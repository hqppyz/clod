import type { Instance } from '../claude';
import type { Clod } from '../clod';
import type { Config } from '../config';
import type { Command } from '../command';
import type { Session } from '../session';
import { Discord } from './discord';
import { RemoteControl } from './remote-control';

// One per entry under `connectors:`, serving each path entry it's enabled in
// through a Connector.Path, and each session of those through an Attachment
export interface Connector extends AsyncDisposable {
  // Its key under `connectors:`
  readonly id: string;
  // As `type:` names it, which picks its CONNECTORS.<type>.md
  readonly type: string;

  // Runs at startup, so mistakes fail there; Config.Errors name keys within
  // the block, and Clod adds where it is
  register(entry: Config.Path, raw: Readonly<Record<string, unknown>>): Connector.Path;

  notify?(event: Clod.Event): Promise<void>;
}

export namespace Connector {
  export interface Path {
    // Throws to leave the session unserved
    attach(session: Session): Promise<Attachment>;
  }

  // Disposing the connector at shutdown leaves its attachments as they are, so
  // only an attachment's own disposal undoes what attaching did, like deleting a channel
  export interface Attachment extends AsyncDisposable {
    // Runs on every start, resumes included
    lifecycle(event: Lifecycle): Promise<void>;

    // Turns from other connectors and clients included
    observe(event: Session.Event | Session.Turn): void;

    // Rejects to leave it to others; the first answer aborts the signal for the rest
    permit?(permission: Session.Permission, signal: AbortSignal): Promise<Session.Decision>;

    // For a command another client sent, like the Claude app; connectors allow
    // their own commands per turn instead
    allow?(command: Command): Promise<Session.Decision>;
  }

  // What happens to a session's instance, for its connectors. Each connector
  // sees each event in turn, awaited.
  export type Lifecycle =
    // About to spawn: connectors add args and env to options, and fill their
    // CONNECTORS.<type>.md with prompt. Throwing refuses the start, so it's a
    // hook as much as an event.
    | { readonly type: 'starting'; readonly options: Instance.Options; prompt(values: Readonly<Record<string, string>>): Promise<void> }
    // Spawned: setup that needs the process, like enabling Remote Control
    | { readonly type: 'started'; readonly instance: Instance }
    // Idle for a while: it stops unless a connector calls keep()
    | { readonly type: 'idle'; keep(): void }
    // Gone, and why: exit is any end nobody asked for
    | { readonly type: 'stopped'; readonly reason: 'idle' | 'restart' | 'shutdown' | 'exit' };

  // Resolves to a working connector or throws
  export type Factory = (id: string, raw: Readonly<Record<string, unknown>>, clod: Clod) => Promise<Connector>;

  // As `type:` names them
  export const FACTORIES: Readonly<Record<string, Factory>> = {
    discord: Discord.create,
    'remote-control': RemoteControl.create,
  };
}
