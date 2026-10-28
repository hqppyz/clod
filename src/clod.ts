import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Instance } from './claude';
import type { Command } from './command';
import { ConfigError, entryFor } from './config';
import { FACTORIES, type Connector } from './connectors';
import { Session } from './session';
import { watchDirs } from './watcher';

// Fills in {{NAME}}s from values; unknown ones stay as written
export function render(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match);
}

// Fills in {{NAME}}s in every string of a JSON value, keys included
function renderJson(value: unknown, values: Readonly<Record<string, string>>): unknown {
  if (typeof value === 'string') return render(value, values);
  if (Array.isArray(value)) return value.map((v) => renderJson(v, values));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [render(k, values), renderJson(v, values)]));
}

// Applies patch to target as a JSON Merge Patch (RFC 7396): objects merge
// key by key, null removes a key, and any other value replaces the old one.
function mergePatch(target: unknown, patch: unknown): unknown {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch;
  const result: Record<string, unknown> =
    typeof target === 'object' && target !== null && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

// Waited before the bot exits on a command, so connectors can show its reply
const EXIT_GRACE_MS = 2_000;

// The bot: its sessions, one per directory, and the connectors serving them.
// Connectors reach the rest of the bot through it.
export class Clod implements AsyncDisposable {
  readonly sessions = new Map<string, Session>();
  readonly connectors: Connector[] = [];
  // How each connector serves each path entry; missing when disabled there
  private readonly paths = new Map<Connector, Map<Clod.Path, Connector.Path>>();
  private readonly ready$ = Promise.withResolvers<void>();
  // The pass attaching and detaching connectors, if one is running
  private attaching: Promise<void> = Promise.resolve();
  private readonly scanned$ = Promise.withResolvers<void>();
  // Which path each attachment was made by, to redo it if that changes
  private readonly attachedBy = new Map<Connector.Attachment, Connector.Path>();
  private writing: Promise<unknown> = Promise.resolve();
  private exiting = false;

  private constructor(
    readonly config: Clod.Config,
    // Sessions by directory, from <data>/sessions.json
    private readonly saved: Map<string, Session.Saved>,
  ) {}

  // Resolves with every enabled connector created, or throws, disposing the ones made so far
  static async create(config: Clod.Config): Promise<Clod> {
    const file = Bun.file(join(config.dataDir, 'sessions.json'));
    const saved: Record<string, string | Session.Saved> = (await file.exists()) ? await file.json() : {};
    // A bare id is how sessions were saved before the model and effort were
    const sessions = Object.entries(saved).map(([dir, s]): [string, Session.Saved] => [dir, typeof s === 'string' ? { id: s } : s]);
    const clod = new Clod(config, new Map(sessions));
    try {
      for (const [id, { type, enabled, raw }] of Object.entries(config.connectors)) {
        if (!enabled) continue;
        const factory = FACTORIES[type];
        if (!factory) throw new ConfigError(`connectors.${id}.type: unknown type ${type}`);
        const connector = await factory(id, raw, clod);
        clod.connectors.push(connector);
        clod.paths.set(connector, clod.parsePaths(connector));
      }
    } catch (e) {
      await clod[Symbol.asyncDispose]();
      throw e;
    }
    clod.authenticate().catch((e) => console.error('claude login failed:', e));
    return clod;
  }

  private parsePaths(connector: Connector): Map<Clod.Path, Connector.Path> {
    const parsed = new Map<Clod.Path, Connector.Path>();
    this.config.paths.forEach((entry, i) => {
      const where = `paths[${i}] (${entry.path}).connectors.${connector.id}`;
      const { enabled = true, ...raw } = (entry.connectors[connector.id] ?? {}) as Record<string, unknown>;
      if (typeof enabled !== 'boolean') throw new ConfigError(`${where}.enabled: expected true or false`);
      if (!enabled) return;
      try {
        parsed.set(entry, connector.register(entry, raw));
      } catch (e) {
        if (e instanceof ConfigError) throw new ConfigError(`${where}.${e.message}`);
        throw e;
      }
    });
    return parsed;
  }

  // Claude Code keeps settings, credentials and transcripts under CLAUDE_CONFIG_DIR,
  // so pointing it into the data dir keeps the bot's sessions out of the user's ~/.claude.
  get home(): string {
    return join(this.config.dataDir, '.claude');
  }

  // Turns wait for this, so prompts sent before Claude is logged in queue up
  get ready(): Promise<void> {
    return this.ready$.promise;
  }

  // Tells every connector that can hear it
  async notify(event: Clod.Event): Promise<void> {
    await Promise.all(this.connectors.map((c) => c.notify?.(event).catch((e) => console.error(`failed to notify ${c.id}:`, e))));
  }

  // Logs Claude in if it isn't. The link goes to the console and every
  // connector; the code can come back from any of them, or from stdin. The
  // first code that works sends logged-in, which the others react to.
  private async authenticate(): Promise<void> {
    if (await Clod.Login.check(this.home)) return this.ready$.resolve();
    console.error('claude is not authenticated');
    let login = await Clod.Login.start(this.home);
    let done = false;
    const announce = (current: Clod.Login) => {
      console.log(`log Claude in at ${current.url}`);
      console.log('then paste the code here, or send it through a connector');
      this.notify({ type: 'login-required', url: current.url, submit: (code, by) => submit(current, code, by) });
    };
    const submit = async (current: Clod.Login, code: string, by: string): Promise<boolean> => {
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
        login = await Clod.Login.start(this.home);
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
    await this.installClaudeMd();
    await this.installSettings();
  }

  // Copies <data>/CLAUDE.md, if there is one, into the Claude home, where Claude
  // reads it as its user-level instructions. A symlink is followed, and a copy
  // Claude changed is overwritten. Without a source, an earlier copy is removed.
  // {{DATA_DIR}} is filled in; other {{...}} stay as written.
  private async installClaudeMd(): Promise<void> {
    const source = Bun.file(join(this.config.dataDir, 'CLAUDE.md'));
    const target = join(this.home, 'CLAUDE.md');
    if (await source.exists()) {
      await mkdir(this.home, { recursive: true });
      await Bun.write(target, render(await source.text(), { DATA_DIR: this.config.dataDir }));
    } else {
      await rm(target, { force: true });
    }
  }

  // Merges <data>/settings.json, if there is one, into the Claude home's
  // settings.json, so keys it names win and keys Claude set itself stay.
  // {{HOME}}, the user's home directory, is filled in in its strings; other
  // {{...}} stay as written.
  private async installSettings(): Promise<void> {
    const source = Bun.file(join(this.config.dataDir, 'settings.json'));
    if (!(await source.exists())) return;
    const target = Bun.file(join(this.home, 'settings.json'));
    const current = (await target.exists()) ? await target.json() : {};
    const patch = renderJson(await source.json(), { HOME: homedir() });
    await mkdir(this.home, { recursive: true });
    await Bun.write(target, `${JSON.stringify(mergePatch(current, patch), null, 2)}\n`);
  }

  // <data>/CONNECTORS.md with {{CONNECTORS}} filled in by an instance's
  // connector bullets, for --append-system-prompt. Undefined without the file.
  async connectorsPrompt(bullets: readonly string[]): Promise<string | undefined> {
    const source = Bun.file(join(this.config.dataDir, 'CONNECTORS.md'));
    if (!(await source.exists())) return undefined;
    return render(await source.text(), { CONNECTORS: bullets.join('\n') });
  }

  // <data>/CONNECTORS.<type>.md rendered with values, or undefined without the file
  async connectorBullet(type: string, values: Readonly<Record<string, string>>): Promise<string | undefined> {
    const source = Bun.file(join(this.config.dataDir, `CONNECTORS.${type}.md`));
    if (!(await source.exists())) return undefined;
    return render((await source.text()).trim(), values);
  }

  // What an instance in dir starts with, before connectors add theirs
  optionsFor(dir: string): Instance.Options {
    const entry = entryFor(this.config, dir);
    return {
      args: [...this.config.claude.args, ...(entry?.args ?? [])],
      env: { ...this.config.claude.env, ...entry?.env },
      prompts: [],
    };
  }

  save(session: Session) {
    if (session.id) this.saved.set(session.dir, { id: session.id, ...session.chosen });
    else this.saved.delete(session.dir);
    const json = JSON.stringify(Object.fromEntries(this.saved), null, 2);
    const path = join(this.config.dataDir, 'sessions.json');
    this.writing = this.writing.then(() => Bun.write(path, json)).catch((e) => console.error('failed to save sessions:', e));
  }

  // Resolves once the first pass has attached every connector to the sessions
  // the initial scan found, so whatever none of them claimed can go
  get scanned(): Promise<void> {
    return this.scanned$.promise;
  }

  // Resolves once no connectors are being attached or detached, which
  // instances wait for, so every connector serving them adds its part
  get attached(): Promise<void> {
    return this.attaching;
  }

  // Watches the configured paths, keeping a session per matched directory
  // and each connector attached to the sessions it serves
  async run(): Promise<never> {
    const matched = new Map<Clod.Path, Set<string>>(this.config.paths.map((entry) => [entry, new Set()]));
    // Passes run one at a time, as the watcher's events are awaited
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
    for await (const event of watchDirs(this.config.paths)) {
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

  // Attaches each connector to the sessions it now serves and disposes the
  // attachments of the ones it no longer does; a session whose path changed
  // gets a new attachment
  private async attach(matched: ReadonlyMap<Clod.Path, ReadonlySet<string>>) {
    for (const connector of this.connectors) {
      const wanted = new Map<Session, Connector.Path>();
      for (const [entry, dirs] of matched) {
        const path = this.paths.get(connector)!.get(entry);
        if (path === undefined) continue;
        for (const dir of dirs) wanted.set(this.session(dir), path);
      }
      for (const session of this.sessions.values()) {
        const attachment = session.attachments.get(connector);
        const path = wanted.get(session);
        if (attachment && this.attachedBy.get(attachment) === path) continue;
        if (attachment) {
          session.attachments.delete(connector);
          this.attachedBy.delete(attachment);
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
          this.attachedBy.set(made, path);
        } catch (e) {
          console.error(`failed to attach ${connector.id} to ${session.dir}:`, e);
        }
      }
    }
  }

  // Runs a command of the bot's own, sent in session and allowed already
  command(command: Command, session: Session): Session.Reply {
    if (command.name === 'restart' && command.what === 'instance') {
      session.restart();
      console.log(`restarted the instance in ${session.dir}`);
      return { text: 'Instance restarted; the next message resumes the session.', isError: false };
    }
    const restart = command.name === 'restart';
    console.log(`${restart ? 'restart' : 'stop'} of the bot from ${session.dir}`);
    // Exit code 0, so index.ts doesn't start a new process
    if (!this.exiting) setTimeout(() => this.exit(restart ? Clod.RESTART_CODE : 0), EXIT_GRACE_MS);
    this.exiting = true;
    return { text: restart ? 'Restarting the bot…' : 'Stopping the bot…', isError: false };
  }

  private async exit(code: number) {
    await this[Symbol.asyncDispose]().catch((e) => console.error('failed to stop cleanly:', e));
    process.exit(code);
  }

  // Ends every running instance, as before the bot exits
  stop() {
    for (const session of this.sessions.values()) session.shutdown();
  }

  private session(dir: string): Session {
    let session = this.sessions.get(dir);
    if (!session) this.sessions.set(dir, (session = new Session(this, dir, this.saved.get(dir))));
    return session;
  }

  async [Symbol.asyncDispose]() {
    this.stop();
    for (const connector of this.connectors.reverse()) await connector[Symbol.asyncDispose]();
  }
}

export namespace Clod {
  // auto: one session per directory matched by include - exclude.
  // manual: the path itself.
  // args go after claude.args, and env merges over claude.env. connectors holds
  // each connector's block for this path, raw, for the connector to parse.
  export type Path = {
    readonly path: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly connectors: Readonly<Record<string, unknown>>;
  } & (
    | {
        readonly mode: 'auto';
        readonly include: readonly string[];
        readonly exclude: readonly string[];
      }
    | { readonly mode: 'manual' }
  );

  export type AutoPath = Extract<Path, { mode: 'auto' }>;

  // A connector's block, raw but for its type and whether it's on
  export interface ConnectorConfig {
    readonly type: string;
    readonly enabled: boolean;
    readonly raw: Readonly<Record<string, unknown>>;
  }

  // What Clod tells every connector through notify
  export type Event =
    // Claude needs logging in at url; submit the code its page shows. Resolves
    // to whether it worked; a failed code sends a new login-required.
    | { readonly type: 'login-required'; readonly url: string; submit(code: string, by: string): Promise<boolean> }
    | { readonly type: 'logged-in'; readonly by: string }
    | { readonly type: 'text'; readonly text: string };

  // `claude auth login` without a TTY prints the URL and waits for the code on
  // stdin; the callback page shows the code, so any machine can do the login.
  export class Login {
    private submitting: Promise<boolean> | undefined;

    private constructor(
      private readonly home: string,
      private readonly proc: Bun.Subprocess<'pipe', 'pipe', 'ignore'>,
      readonly url: string,
    ) {}

    // Whether credentials exist in the Claude home. Doesn't validate them,
    // but never starts a session.
    static async check(home: string): Promise<boolean> {
      await mkdir(home, { recursive: true });
      const proc = Bun.spawn(['claude', 'auth', 'status', '--json'], {
        env: { ...Bun.env, CLAUDE_CONFIG_DIR: home },
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      try {
        return JSON.parse(stdout).loggedIn === true;
      } catch {
        return false;
      }
    }

    static async start(home: string): Promise<Login> {
      await mkdir(home, { recursive: true });
      const proc = Bun.spawn(['claude', 'auth', 'login'], {
        // BROWSER=true makes the browser launch a no-op on the server
        env: { ...Bun.env, CLAUDE_CONFIG_DIR: home, BROWSER: 'true' },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'ignore',
      });

      // A reader, not for-await: breaking out of that would cancel stdout
      // and the process could die writing to it later
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let output = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
        const url = output.match(/https:\/\/\S+/)?.[0];
        // The prompt follows the URL, so the URL is complete once it shows
        if (url && output.includes('Paste code')) {
          reader.releaseLock();
          return new Login(home, proc, url);
        }
      }
      throw new Error(`claude auth login exited without a URL: ${output.trim()}`);
    }

    // Resolves to whether the bot is authenticated afterwards. The login
    // process takes one code, so later calls share the first one's result.
    submit(code: string): Promise<boolean> {
      this.submitting ??= this.finish(code);
      return this.submitting;
    }

    cancel() {
      this.proc.kill();
    }

    private async finish(code: string): Promise<boolean> {
      this.proc.stdin.write(`${code.trim()}\n`);
      await this.proc.stdin.end();
      const timeout = setTimeout(() => this.proc.kill(), 30_000);
      await this.proc.exited;
      clearTimeout(timeout);
      return Login.check(this.home);
    }
  }

  // The exit code with which the bot asks index.ts for a new process
  export const RESTART_CODE = 75;

  export interface Config {
    // Absolute; holds config.yaml and the bot's Claude home
    readonly dataDir: string;
    readonly paths: readonly Clod.Path[];
    readonly connectors: Readonly<Record<string, ConnectorConfig>>;
    readonly claude: {
      // Extra `claude` arguments and environment for every instance
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    };
  }
}
