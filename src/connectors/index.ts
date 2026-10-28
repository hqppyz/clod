import type { Instance } from '../claude';
import type { Clod } from '../clod';
import type { Command } from '../command';
import type { Session } from '../session';
import { Discord } from './discord';
import { RemoteControl } from './remote-control';

// A backend sessions are reachable from: one per entry under `connectors:`,
// serving each path entry it's enabled in through a Connector.Path, and each
// session of those through an Attachment. Only a Factory makes one, and it
// resolves to a working connector or throws.
export interface Connector extends AsyncDisposable {
  // Its key under `connectors:`
  readonly id: string;

  // Parses its block under a path entry's `connectors:` (enabled already taken
  // out), its own defaults filled in. Runs at startup, so mistakes fail there;
  // ConfigErrors name keys within the block, and Clod adds where it is.
  register(entry: Clod.Path, raw: Readonly<Record<string, unknown>>): Connector.Path;

  // Bot-wide events, like Claude needing a login; connectors that can't act on them leave it out
  notify?(event: Clod.Event): Promise<void>;
}

export namespace Connector {
  // A connector serving one path entry, as its block there says
  export interface Path {
    // Starts serving a session of the entry; disposing the result stops serving
    // it, as when its directory goes. Throws to leave the session unserved.
    attach(session: Session): Promise<Attachment>;
  }

  // A connector serving one session. Disposing the connector at shutdown
  // leaves its attachments as they are, so only an attachment's own disposal
  // undoes what attaching did, like deleting a channel.
  export interface Attachment extends AsyncDisposable {
    // What happens to the session's instance: starting is where it adds args,
    // env and its CONNECTORS bullet, and throwing there refuses the start.
    // Runs on every start, resumes included.
    lifecycle(event: Instance.Event): Promise<void>;

    // Every event of the session, and where each turn starts and ends, turns
    // from other connectors and clients included
    observe(event: Session.Event | Session.Turn): void;

    // A tool call the mode didn't approve: resolves to its answer, or rejects
    // to leave it to others. Every attachment that has it is asked; the first
    // answer wins and aborts the signal for the rest.
    permit?(permission: Session.Permission, signal: AbortSignal): Promise<Session.Decision>;

    // A command of the bot's own that another client sent, like the Claude
    // app: whether it may run. Every attachment that has it is asked; the
    // first answer wins. Connectors allow their own commands per turn instead.
    allow?(command: Command): Promise<Session.Decision>;
  }
}

export type Factory = (id: string, raw: Readonly<Record<string, unknown>>, clod: Clod) => Promise<Connector>;

// Connector types, as `type:` names them
export const FACTORIES: Readonly<Record<string, Factory>> = {
  discord: Discord.create,
  'remote-control': RemoteControl.create,
};
