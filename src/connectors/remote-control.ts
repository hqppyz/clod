import { basename } from 'node:path';
import type { Instance } from '../claude';
import { render, type Clod } from '../clod';
import { checkKeys, str } from '../config';
import type { Session } from '../session';
import type { Connector } from '.';

const DEFAULT_NAME = '{{NAME}}';

// Waited before starting an instance that exited on its own again, so one
// that keeps crashing doesn't spin
const REWAKE_MS = 10_000;

// Makes sessions reachable from claude.ai/code and the Claude app through
// Remote Control. Prompts from there go straight into the instance, so all it
// does is keep an instance running per session, Remote Control enabled.
export class RemoteControl implements Connector {
  private constructor(
    readonly id: string,
    private readonly clod: Clod,
    private readonly name: string,
  ) {}

  // Nothing to connect, so parsing is all that can fail
  static async create(id: string, raw: Readonly<Record<string, unknown>>, clod: Clod): Promise<RemoteControl> {
    checkKeys(raw, ['name'], `connectors.${id}`);
    const name = raw.name == null ? DEFAULT_NAME : str(raw.name, `connectors.${id}.name`);
    return new RemoteControl(id, clod, name);
  }

  register(_entry: Clod.Path, raw: Readonly<Record<string, unknown>>): Path {
    checkKeys(raw, ['name'], '');
    return new Path(this.clod, this.id, raw.name == null ? this.name : str(raw.name, 'name'));
  }

  async [Symbol.asyncDispose](): Promise<void> {}
}

// One path entry served
class Path implements Connector.Path {
  constructor(
    private readonly clod: Clod,
    private readonly id: string,
    // The session's name in claude.ai/code and the app; {{NAME}} is the directory's name
    private readonly name: string,
  ) {}

  async attach(session: Session): Promise<Attachment> {
    const attachment = new Attachment(this.clod, this.id, session, this.name);
    attachment.wake();
    return attachment;
  }
}

// One session served: an instance kept running with Remote Control enabled
class Attachment implements Connector.Attachment {
  private disposed = false;

  constructor(
    private readonly clod: Clod,
    private readonly id: string,
    private readonly session: Session,
    private readonly name: string,
  ) {}

  async lifecycle(event: Instance.Event): Promise<void> {
    switch (event.type) {
      case 'starting': {
        event.options.args.push('--name', render(this.name, { NAME: basename(this.session.dir) }));
        const bullet = await this.clod.connectorBullet('remote-control', { CONNECTOR: this.id });
        if (bullet) event.options.prompts.push(bullet);
        return;
      }
      case 'started': {
        const url = await event.instance.remoteControl(true);
        console.log(`remote control for ${this.session.dir}: ${url}`);
        return;
      }
      // The app only reaches sessions whose instance runs
      case 'idle':
        event.keep();
        return;
      case 'stopped':
        if (event.reason === 'restart') this.wake();
        if (event.reason === 'exit') setTimeout(() => this.wake(), REWAKE_MS);
        return;
    }
  }

  // The app shows the instance's events itself
  observe(): void {}

  // The app shows the prompt itself, and claude cancels ours once it's answered there
  permit(_permission: Session.Permission, signal: AbortSignal): Promise<Session.Decision> {
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('answered elsewhere')), { once: true }));
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
    await this.session.instance?.remoteControl(false).catch(() => {});
  }
}
