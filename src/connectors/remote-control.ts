import { basename } from 'node:path';
import type { Clod } from '../clod';
import { Config } from '../config';
import { Template } from '../template';
import type { Session } from '../session';
import type { Connector } from '.';

// Prompts from claude.ai/code and the Claude app go straight into the
// instance, so all it does is keep one running per session, Remote Control enabled
export class RemoteControl implements Connector {
  readonly type = 'remote-control';

  private constructor(
    readonly id: string,
    private readonly name: string,
  ) {}

  static async create(id: string, raw: Readonly<Record<string, unknown>>, _clod: Clod): Promise<RemoteControl> {
    Config.keys(raw, ['name'], `connectors.${id}`);
    const name = raw.name == null ? '{{NAME}}' : Config.text(raw.name, `connectors.${id}.name`);
    return new RemoteControl(id, name);
  }

  register(_entry: Config.Path, raw: Readonly<Record<string, unknown>>): Path {
    Config.keys(raw, ['name'], '');
    return new Path(this.id, raw.name == null ? this.name : Config.text(raw.name, 'name'));
  }

  async [Symbol.asyncDispose](): Promise<void> {}
}

class Path implements Connector.Path {
  constructor(
    private readonly id: string,
    // {{NAME}} is the directory's name
    private readonly name: string,
  ) {}

  async attach(session: Session): Promise<Attachment> {
    const attachment = new Attachment(this.id, session, this.name);
    attachment.wake();
    return attachment;
  }
}

class Attachment implements Connector.Attachment {
  private disposed = false;

  constructor(
    private readonly id: string,
    private readonly session: Session,
    private readonly name: string,
  ) {}

  async lifecycle(event: Connector.Lifecycle): Promise<void> {
    switch (event.type) {
      case 'starting': {
        event.options.args.push('--name', this.title);
        await event.prompt({ CONNECTOR: this.id });
        return;
      }
      case 'started': {
        const url = await event.instance.remote(true);
        await event.instance.rename(this.title).catch((e) => console.error(`failed to rename ${this.session.dir}:`, e));
        console.log(`remote control for ${this.session.dir}: ${url}`);
        return;
      }
      // The app only reaches sessions whose instance runs
      case 'idle':
        event.keep();
        return;
      case 'stopped': {
        // So an instance that keeps crashing doesn't spin
        const REWAKE_MS = 10_000;
        if (event.reason === 'restart') this.wake();
        if (event.reason === 'exit') setTimeout(() => this.wake(), REWAKE_MS);
        return;
      }
    }
  }

  private get title(): string {
    return Template.fill(this.name, { NAME: basename(this.session.dir) });
  }

  // The app shows the instance's events itself
  observe(): void {}

  // The app shows the prompt itself, and claude cancels ours once it's answered there
  permit(_permission: Session.Permission, signal: AbortSignal): Promise<Session.Decision> {
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('answered elsewhere')), { once: true }));
  }

  // Commands from the app come from the account's owner
  async allow(): Promise<Session.Decision> {
    return { behavior: 'allow' };
  }

  // Not awaited, as starting waits for every attachment to be made, this one included
  wake() {
    if (this.disposed) return;
    this.session.wake().catch((e) => console.error(`failed to start ${this.session.dir} for ${this.id}:`, e));
  }

  // The instance goes on for the other connectors, if any, without Remote
  // Control; it stops at its next idle unless one of them keeps it
  async [Symbol.asyncDispose](): Promise<void> {
    this.disposed = true;
    await this.session.instance?.remote(false).catch(() => {});
  }
}
