import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command } from './command';
import { Config } from './config';
import { Connector } from './connectors';
import { Login } from './login';
import { Prompts } from './prompts';
import { Session } from './session';
import { Template } from './template';
import { Watcher } from './watcher';

// JSON Merge Patch (RFC 7396)
function merge(target: unknown, patch: unknown): unknown {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch;
  const result: Record<string, unknown> =
    typeof target === 'object' && target !== null && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = merge(result[key], value);
  }
  return result;
}

// Connectors reach the rest of the bot through it
export class Clod implements AsyncDisposable {
  readonly sessions = new Map<string, Session>();
  readonly connectors: Connector[] = [];
  readonly prompts: Prompts;
  // Missing where a connector is disabled
  private readonly paths = new Map<Connector, Map<Config.Path, Connector.Path>>();
  private readonly ready$ = Promise.withResolvers<void>();
  private attaching: Promise<void> = Promise.resolve();
  private readonly scanned$ = Promise.withResolvers<void>();
  // To redo an attachment if its path changes
  private readonly sources = new Map<Connector.Attachment, Connector.Path>();
  private writing: Promise<unknown> = Promise.resolve();
  private exiting = false;

  private constructor(
    readonly config: Config,
    // By directory
    private readonly saved: Map<string, Session.Saved>,
  ) {
    this.prompts = new Prompts(config.data);
  }

  static async create(config: Config): Promise<Clod> {
    const file = Bun.file(join(config.data, 'sessions.json'));
    const saved: Record<string, string | Session.Saved> = (await file.exists()) ? await file.json() : {};
    // A bare id is how sessions were saved before the model and effort were
    const sessions = Object.entries(saved).map(([dir, s]): [string, Session.Saved] => [dir, typeof s === 'string' ? { id: s } : s]);
    const clod = new Clod(config, new Map(sessions));
    try {
      for (const [id, { type, enabled, raw }] of Object.entries(config.connectors)) {
        if (!enabled) continue;
        const factory = Connector.FACTORIES[type];
        if (!factory) throw new Config.Error(`connectors.${id}.type: unknown type ${type}`);
        const connector = await factory(id, raw, clod);
        clod.connectors.push(connector);
        clod.paths.set(connector, clod.parse(connector));
      }
    } catch (e) {
      await clod[Symbol.asyncDispose]();
      throw e;
    }
    clod.authenticate().catch((e) => console.error('claude login failed:', e));
    return clod;
  }

  private parse(connector: Connector): Map<Config.Path, Connector.Path> {
    const parsed = new Map<Config.Path, Connector.Path>();
    this.config.paths.forEach((entry, i) => {
      const where = `paths[${i}] (${entry.path}).connectors.${connector.id}`;
      const { enabled = true, ...raw } = (entry.connectors[connector.id] ?? {}) as Record<string, unknown>;
      if (typeof enabled !== 'boolean') throw new Config.Error(`${where}.enabled: expected true or false`);
      if (!enabled) return;
      try {
        parsed.set(entry, connector.register(entry, raw));
      } catch (e) {
        if (e instanceof Config.Error) throw new Config.Error(`${where}.${e.message}`);
        throw e;
      }
    });
    return parsed;
  }

  // Prompts sent before Claude is logged in queue up on it
  get ready(): Promise<void> {
    return this.ready$.promise;
  }

  async notify(event: Clod.Event): Promise<void> {
    await Promise.all(this.connectors.map((c) => c.notify?.(event).catch((e) => console.error(`failed to notify ${c.id}:`, e))));
  }

  // The code can come back from any connector, or from stdin
  private async authenticate(): Promise<void> {
    if (await Login.check(this.config.home)) return this.ready$.resolve();
    console.error('claude is not authenticated');
    let login = await Login.start(this.config.home);
    let done = false;
    const announce = (current: Login) => {
      console.log(`log Claude in at ${current.url}`);
      console.log('then paste the code here, or send it through a connector');
      this.notify({ type: 'login-required', url: current.url, submit: (code, by) => submit(current, code, by) });
    };
    const submit = async (current: Login, code: string, by: string): Promise<boolean> => {
      if (done) return true;
      if (await current.submit(code)) {
        if (done) return true;
        done = true;
        console.log(`claude authenticated by ${by}`);
        this.ready$.resolve();
        await this.notify({ type: 'logged-in', by });
        return true;
      }
      // A failed code ends the login process, so start a new one unless a
      // concurrent submit already did
      if (login === current) {
        login = await Login.start(this.config.home);
        announce(login);
      }
      return false;
    };
    announce(login);
    // Ends with stdin, as it does under a service manager
    for await (const line of console) {
      if (done) break;
      if (line.trim()) await submit(login, line, 'console');
    }
  }

  // Before every instance start, so edits to the sources apply
  async install(): Promise<void> {
    await mkdir(this.config.home, { recursive: true });

    // A symlink is followed, and a copy Claude changed is overwritten
    const md = Bun.file(join(this.config.data, 'CLAUDE.md'));
    const target = join(this.config.home, 'CLAUDE.md');
    if (await md.exists()) await Bun.write(target, Template.fill(await md.text(), { DATA_DIR: this.config.data }));
    else await rm(target, { force: true });

    // Merged, so keys Claude set itself stay
    const settings = Bun.file(join(this.config.data, 'settings.json'));
    if (await settings.exists()) {
      const current = Bun.file(join(this.config.home, 'settings.json'));
      const patch = Template.fill(await settings.json(), { HOME: homedir() });
      await Bun.write(current, `${JSON.stringify(merge((await current.exists()) ? await current.json() : {}, patch), null, 2)}\n`);
    }

    await Command.install(this.config.home);
  }

  save(session: Session) {
    if (session.id) this.saved.set(session.dir, { id: session.id, ...session.chosen });
    else this.saved.delete(session.dir);
    const json = JSON.stringify(Object.fromEntries(this.saved), null, 2);
    const path = join(this.config.data, 'sessions.json');
    this.writing = this.writing.then(() => Bun.write(path, json)).catch((e) => console.error('failed to save sessions:', e));
  }

  // Once the initial scan's sessions are attached, whatever no connector claimed can go
  get scanned(): Promise<void> {
    return this.scanned$.promise;
  }

  // Instances wait for it, so every connector serving them adds its part
  get attached(): Promise<void> {
    return this.attaching;
  }

  async run(): Promise<never> {
    const matched = new Map<Config.Path, Set<string>>(this.config.paths.map((entry) => [entry, new Set()]));
    const update = async () => {
      // Set before the first attach, which may already wait for it
      const pass = Promise.withResolvers<void>();
      this.attaching = pass.promise;
      try {
        await this.attach(matched);
      } finally {
        pass.resolve();
      }
    };

    // Attaching waits for "ready", so a half-finished initial scan can't drop sessions
    let scanned = false;
    for await (const event of Watcher.watch(this.config.paths)) {
      if (event.type === 'ready') {
        scanned = true;
        await update();
        this.scanned$.resolve();
        continue;
      }
      const { type, entry, dir } = event;
      console.log(`${type === 'added' ? '+' : '-'} ${dir} (${entry.mode})`);
      if (type === 'added') matched.get(entry)!.add(dir);
      else matched.get(entry)!.delete(dir);
      if (scanned) await update();
    }
    throw new Error('directory watcher stopped');
  }

  private async attach(matched: ReadonlyMap<Config.Path, ReadonlySet<string>>) {
    for (const connector of this.connectors) {
      const wanted = new Map<Session, Connector.Path>();
      for (const [entry, dirs] of matched) {
        const path = this.paths.get(connector)!.get(entry);
        if (path === undefined) continue;
        for (const dir of dirs) {
          let session = this.sessions.get(dir);
          if (!session) this.sessions.set(dir, (session = new Session(this, dir, this.saved.get(dir))));
          wanted.set(session, path);
        }
      }
      for (const session of this.sessions.values()) {
        const attachment = session.attachments.get(connector);
        const path = wanted.get(session);
        if (attachment && this.sources.get(attachment) === path) continue;
        if (attachment) {
          session.attachments.delete(connector);
          this.sources.delete(attachment);
          try {
            await attachment[Symbol.asyncDispose]();
          } catch (e) {
            console.error(`failed to detach ${connector.id} from ${session.dir}:`, e);
          }
        }
        if (path === undefined) continue;
        try {
          const made = await path.attach(session);
          session.attachments.set(connector, made);
          this.sources.set(made, path);
        } catch (e) {
          console.error(`failed to attach ${connector.id} to ${session.dir}:`, e);
        }
      }
    }
  }

  // Allowed already
  command(command: Command, session: Session): Session.Reply {
    if (command.name === 'restart') {
      session.restart();
      console.log(`restarted the instance in ${session.dir}`);
      return { text: 'Instance restarted; the next message resumes the session.', failed: false };
    }
    const restart = command.name === 'reboot';
    console.log(`${restart ? 'reboot' : 'stop'} of clod from ${session.dir}`);
    // So connectors can show the reply
    const GRACE_MS = 2_000;
    // Exit code 0, so index.ts doesn't start a new process
    const code = restart ? Clod.RESTART_CODE : 0;
    if (!this.exiting) {
      setTimeout(async () => {
        await this[Symbol.asyncDispose]().catch((e) => console.error('failed to stop cleanly:', e));
        process.exit(code);
      }, GRACE_MS);
    }
    this.exiting = true;
    return { text: restart ? 'Rebooting clod…' : 'Stopping clod…', failed: false };
  }

  stop() {
    for (const session of this.sessions.values()) session.shutdown();
  }

  async [Symbol.asyncDispose]() {
    this.stop();
    for (const connector of this.connectors.reverse()) await connector[Symbol.asyncDispose]();
  }
}

export namespace Clod {
  export type Event =
    // A failed code sends a new login-required
    | { readonly type: 'login-required'; readonly url: string; submit(code: string, by: string): Promise<boolean> }
    | { readonly type: 'logged-in'; readonly by: string }
    | { readonly type: 'text'; readonly text: string };

  // Asks index.ts for a new process
  export const RESTART_CODE = 75;
}
