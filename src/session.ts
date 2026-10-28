import { Instance } from './claude';
import type { Clod } from './clod';
import { Command } from './command';
import type { Connector } from './connectors';

// An instance with no turn for this long is asked to stop; the next turn resumes the session
const IDLE_MS = 5 * 60_000;

type Reason = Extract<Instance.Event, { type: 'stopped' }>['reason'];

// A Claude session: the conversation of one directory, whether an instance is
// running it or it's only on disk. Turns from every connector go through here,
// one at a time, and every connector serving it sees every event.
export class Session {
  // Claude's session id; changes on /clear or a failed resume
  id: string | undefined;
  // The model and effort chosen in the conversation, which claude doesn't
  // keep, so a resume passes them on; a new conversation starts without
  chosen: Session.Chosen;
  // The connectors serving it, each through its attachment; Clod keeps it up to date
  readonly attachments = new Map<Connector, Connector.Attachment>();
  private running: Instance | undefined;
  // The instance being started, so a turn and a wake don't start two
  private launching: Promise<Instance> | undefined;
  // Why the running instance is being stopped, for its stopped event
  private stopping: Reason | undefined;
  private idle: Timer | undefined;
  // Turns queue up behind each other, whichever connector sent them
  private queue: Promise<unknown> = Promise.resolve();
  // The turn of ours waiting for a foreign one to end before it shows as started
  private waiting: Session.Turn | undefined;
  // A foreign turn's result, shown once its command completes
  private foreignReply: Session.Reply | undefined;
  // A foreign turn that is a command of the bot's own; resolves to its reply
  private foreignCommand: Promise<Session.Reply> | undefined;

  constructor(
    private readonly clod: Clod,
    readonly dir: string,
    { id, ...chosen }: Session.Saved = {},
  ) {
    this.id = id;
    this.chosen = chosen;
  }

  get instance(): Instance | undefined {
    return this.running;
  }

  // Runs text as a turn. from's id tags the prompt, but not a slash command,
  // which has to come first; ask answers the turn's AskUserQuestion calls, for
  // the connector that sent it. A command of the bot's own skips the queue and
  // runs once allow allows it; without allow it's refused.
  prompt(text: string, from: Connector, { ask, allow }: Session.Handlers = {}): Promise<Session.Reply> {
    const command = Command.parse(text);
    if (command) return this.command(command, allow);
    const turn = this.queue.then(() => this.turn(text, from, ask));
    this.queue = turn.catch(() => {});
    return turn;
  }

  // Starts an instance if none is running, for connectors that need one up
  // without a turn, like Remote Control
  async wake(): Promise<void> {
    await this.launch();
    this.rest();
  }

  // Ends the running turn, as Esc does in the terminal
  interrupt() {
    this.running?.interrupt();
  }

  // Ends the instance; the next prompt resumes the session in a new one
  restart() {
    this.stop('restart');
  }

  // Ends the instance for good, as before the bot exits
  shutdown() {
    this.stop('shutdown');
  }

  private stop(reason: Reason) {
    clearTimeout(this.idle);
    if (!this.running) return;
    this.stopping = reason;
    this.running.close();
  }

  // Runs a command of the bot's own, once its sender's side allows it
  private async command(command: Command, allow: Session.Allow | undefined): Promise<Session.Reply> {
    const failed = (e: unknown): Session.Decision => ({ behavior: 'deny', message: `/${command.name} failed: ${e instanceof Error ? e.message : e}` });
    const decision = allow ? await allow(command).catch(failed) : { behavior: 'deny' as const, message: `/${command.name} can't be run from here.` };
    if (decision.behavior === 'deny') return { text: decision.message, isError: true };
    return this.clod.command(command, this);
  }

  // A command another client sent goes to every connector that can allow
  // it; the first answer wins
  private readonly allowForeign: Session.Allow = (command) => {
    const allowing = [...this.attachments.values()].flatMap((a) => (a.allow ? [a.allow(command)] : []));
    if (allowing.length === 0) return Promise.resolve({ behavior: 'deny', message: `No connector allows /${command.name} from here.` });
    return Promise.any(allowing);
  };

  private async turn(text: string, from: Connector, ask?: Session.Ask): Promise<Session.Reply> {
    const instance = await this.launch();
    clearTimeout(this.idle);
    const turn: Session.Turn = { type: 'turn_start', from, text };
    // A foreign turn running now finishes before ours starts
    if (instance.foreign) this.waiting = turn;
    else this.emit(turn);
    // from's id tags the prompt, but not a slash command, which has to come first
    const reply = await instance.send(text.startsWith('/') ? text : `[${from.id}] ${text}`, ask);
    this.waiting = undefined;
    if (instance.dead) {
      await instance.exited;
      if (instance.resumeFailed) return this.turn(text, from, ask);
    }
    this.rest();
    return reply;
  }

  private launch(): Promise<Instance> {
    if (this.running) return Promise.resolve(this.running);
    return (this.launching ??= this.start().finally(() => (this.launching = undefined)));
  }

  // Waits for a login, and for every connector to be attached, so each adds its part
  private async start(): Promise<Instance> {
    await this.clod.ready;
    await this.clod.attached;
    await this.clod.install();
    const options = this.clod.optionsFor(this.dir);
    await this.lifecycle({ type: 'starting', options }, true);
    if (this.id && this.chosen.model) options.args.push('--model', this.chosen.model);
    if (this.id && this.chosen.effort) options.args.push('--effort', this.chosen.effort);
    const prompt = await this.clod.connectorsPrompt(options.prompts);
    if (prompt) options.args.push('--append-system-prompt', prompt);
    const instance = (this.running = await Instance.start(this.dir, this.clod.home, options, { event: (event) => this.read(event), permit: (permission, signal) => this.permit(permission, signal) }, this.id));
    instance.exited.then(() => this.gone(instance));
    await this.lifecycle({ type: 'started', instance });
    return instance;
  }

  // The instance exited, whether asked to or not
  private async gone(instance: Instance) {
    if (this.running !== instance) return;
    this.running = undefined;
    clearTimeout(this.idle);
    const reason = this.stopping ?? 'exit';
    this.stopping = undefined;
    // A resume that dies before starting means the conversation is gone
    if (instance.resumeFailed) {
      console.error(`session in ${this.dir} could not resume, starting over`);
      this.id = undefined;
      this.chosen = {};
      this.clod.save(this);
    }
    // A foreign turn cut short ends here, as its command never completes;
    // one restarting the instance is cut short by its own doing
    if (instance.foreign) {
      const command = this.foreignCommand;
      this.foreignCommand = undefined;
      this.emit({ type: 'turn_end', reply: command ? await command : { text: 'claude exited', isError: true } });
    }
    await this.lifecycle({ type: 'stopped', reason });
  }

  // Waits out IDLE_MS of no turns, then stops the instance unless a connector keeps it
  private rest() {
    clearTimeout(this.idle);
    if (!this.running) return;
    this.idle = setTimeout(async () => {
      let kept = false;
      await this.lifecycle({ type: 'idle', keep: () => (kept = true) });
      if (kept) this.rest();
      else this.stop('idle');
    }, IDLE_MS);
  }

  // Tells each connector, in turn. starting's errors refuse the start; the
  // others' are only logged, as the instance is up or gone either way.
  private async lifecycle(event: Instance.Event, strict = false) {
    for (const [connector, attachment] of this.attachments) {
      try {
        await attachment.lifecycle(event);
      } catch (e) {
        if (strict) throw e;
        console.error(`${connector.id} failed on ${event.type} of ${this.dir}:`, e);
      }
    }
  }

  // An event of the instance. Turns other clients send, like the Claude app
  // over Remote Control, come wrapped in command_lifecycle events; their prompt
  // is the replayed user message with the command's uuid.
  private read(event: Session.Event) {
    const instance = this.running;
    // Kept up to date on every event, as a /clear sent from another client
    // starts a new conversation without a turn of ours to save it
    if (instance?.sessionId && instance.sessionId !== this.id) {
      if (this.id) this.chosen = {};
      this.id = instance.sessionId;
      this.clod.save(this);
    }
    // /model and /effort are the turns that change them
    if (instance && event.type === 'result' && (event.local_command === 'model' || event.local_command === 'effort')) this.choose(instance);
    if (event.type === 'command_lifecycle' && event.state === 'started') clearTimeout(this.idle);
    if (event.type === 'user' && event.isReplay && instance?.foreign && event.uuid === instance.foreign) {
      const { content } = event.message;
      const text = typeof content === 'string' ? content : content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      this.emit({ type: 'turn_start', from: undefined, text });
      // Claude would take a command of the bot's own for a prompt, so its turn is cut short
      const command = Command.parse(text);
      if (command) {
        instance.interrupt();
        this.foreignCommand = this.command(command, this.allowForeign);
        return;
      }
    }
    // The rest of a foreign command's turn is Claude's answer to it, which nobody needs
    const completed = event.type === 'command_lifecycle' && event.state === 'completed';
    if (this.foreignCommand && instance?.foreign && !completed) return;
    // An interrupted turn ends in an error that only carries diagnostics
    if (event.type === 'result' && instance?.foreign) this.foreignReply = instance.interrupted ? { text: 'Interrupted.', isError: false } : Session.reply(event);
    this.emit(event);
    if (completed) {
      const command = this.foreignCommand;
      this.foreignCommand = undefined;
      if (command) command.then((reply) => this.endForeign(reply));
      else this.endForeign(this.foreignReply ?? { text: '', isError: false });
    }
    // Our own turn ends with its result, while the next event can still be a foreign turn's
    if (event.type === 'result' && !instance?.foreign) this.emit({ type: 'turn_end', reply: Session.reply(event) });
  }

  // Saves the model and effort the instance runs with now
  private async choose(instance: Instance) {
    const { model, effort } = await instance.settings().catch(() => ({ model: undefined, effort: undefined }));
    this.chosen = { model, effort };
    this.clod.save(this);
  }

  // A foreign turn's end, then the turn of ours waiting for it starts
  private endForeign(reply: Session.Reply) {
    this.emit({ type: 'turn_end', reply });
    this.foreignReply = undefined;
    if (this.waiting) this.emit(this.waiting);
    this.waiting = undefined;
    this.rest();
  }

  // A tool call the mode didn't approve goes to every connector that can
  // answer it; the first answer wins and the others are aborted
  private async permit(permission: Session.Permission, signal: AbortSignal): Promise<Session.Decision> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      const answering = [...this.attachments.values()].flatMap((a) => (a.permit ? [a.permit(permission, controller.signal)] : []));
      return await Promise.any(answering);
    } catch {
      return { behavior: 'deny', message: 'nobody is available to approve this' };
    } finally {
      controller.abort();
      signal.removeEventListener('abort', abort);
    }
  }

  private emit(event: Session.Event | Session.Turn) {
    for (const attachment of this.attachments.values()) attachment.observe(event);
  }
}

export namespace Session {
  // A turn's result
  export interface Reply {
    readonly text: string;
    readonly isError: boolean;
  }

  // A question of AskUserQuestion's input
  export interface Question {
    readonly question: string;
    readonly header: string;
    readonly options: readonly { label: string; description?: string }[];
    readonly multiSelect: boolean;
  }

  // Asks the person the questions; resolves to each question's answer, keyed by
  // its text. The signal aborts when Claude stops waiting for the answers.
  export type Ask = (questions: readonly Question[], signal: AbortSignal) => Promise<Record<string, string>>;

  // Whether the sender may run a command of the bot's own, like asking an
  // admin to confirm; a deny's message is the command's reply
  export interface Chosen {
    readonly model?: string;
    readonly effort?: string;
  }

  // A session as <data>/sessions.json keeps it
  export interface Saved extends Chosen {
    readonly id?: string;
  }

  export type Allow = (command: Command) => Promise<Decision>;

  // What answers a turn's requests, for the connector that sent it
  export interface Handlers {
    readonly ask?: Ask;
    readonly allow?: Allow;
  }

  // A turn starting or ending, around its events. from is the connector that
  // sent it, or undefined for one another client sent, like the Claude app.
  export type Turn =
    | { readonly type: 'turn_start'; readonly from: Connector | undefined; readonly text: string }
    | { readonly type: 'turn_end'; readonly reply: Reply };

  // A tool call the permission mode didn't approve, waiting for someone to
  export interface Permission {
    readonly tool: string;
    readonly input: Readonly<Record<string, any>>;
    // Claude's own wording of the prompt, and why it asks, when it gives them
    readonly title?: string;
    readonly reason?: string;
  }

  export type Decision = { readonly behavior: 'allow' } | { readonly behavior: 'deny'; readonly message: string };

  // A message's content block
  export type Block =
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'thinking' }
    | { readonly type: 'redacted_thinking' }
    | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: Readonly<Record<string, any>> }
    | {
        readonly type: 'tool_result';
        readonly tool_use_id: string;
        readonly content?: string | readonly { readonly type: string; readonly text?: string }[];
        readonly is_error?: boolean;
      }
    // A block of a type the bot doesn't read; name is its type
    | { readonly type: 'raw'; readonly name: string };

  export type ToolUse = Extract<Block, { type: 'tool_use' }>;

  // Tokens of a turn, each kind apart
  export interface Usage {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_read_input_tokens?: number;
    readonly cache_creation_input_tokens?: number;
  }

  // A rate limit window's state
  export interface Window {
    readonly utilization?: number;
    readonly resetsAt?: number;
  }

  // The stream-json events the bot reads
  export interface Init {
    readonly type: 'system';
    readonly subtype: 'init';
    readonly session_id: string;
    readonly model: string;
    readonly permissionMode: string;
  }
  // Progress while Claude thinks
  export interface ThinkingTokens {
    readonly type: 'system';
    readonly subtype: 'thinking_tokens';
  }
  export interface Message {
    readonly type: 'assistant' | 'user';
    readonly message: { readonly content: string | readonly Block[] };
    readonly uuid?: string;
    // A user message echoed back by --replay-user-messages
    readonly isReplay?: boolean;
  }
  // A turn another client sent, like the Claude app over Remote Control, going
  // through its states; turns sent on stdin have none
  export interface CommandLifecycle {
    readonly type: 'command_lifecycle';
    readonly command_uuid: string;
    readonly state: 'queued' | 'started' | 'completed' | (string & {});
  }
  export interface Result {
    readonly type: 'result';
    readonly result?: string;
    readonly is_error?: boolean;
    readonly errors?: readonly string[];
    readonly usage?: Usage;
    readonly total_cost_usd?: number;
    // Set when a local command like /effort ran the turn
    readonly local_command?: string;
  }
  export interface RateLimit {
    readonly type: 'rate_limit_event';
    readonly rate_limit_info: { readonly status?: string; readonly unifiedWindows?: Readonly<Record<string, Window>> };
  }
  // A permission prompt, or another request Claude makes of the bot
  export interface ControlRequest {
    readonly type: 'control_request';
    readonly request_id: string;
    readonly request: {
      readonly subtype: string;
      readonly tool_name?: string;
      readonly display_name?: string;
      readonly title?: string;
      readonly decision_reason?: string;
      readonly input?: Readonly<Record<string, any>> & { readonly questions?: readonly Question[] };
    };
  }
  export interface ControlCancel {
    readonly type: 'control_cancel_request';
    readonly request_id: string;
  }
  // The answer to a control request the bot made
  export interface ControlResponse {
    readonly type: 'control_response';
    readonly response: {
      readonly subtype: string;
      readonly request_id: string;
      readonly error?: string;
      readonly response?: Readonly<Record<string, any>>;
    };
  }
  export interface ConversationReset {
    readonly type: 'conversation_reset';
    readonly trigger: string;
  }
  // An event of a kind the bot doesn't read; name is its type and subtype, line the JSON
  export interface Raw {
    readonly type: 'raw';
    readonly name: string;
    readonly line: string;
  }

  export type Event =
    | Init
    | ThinkingTokens
    | Message
    | Result
    | RateLimit
    | ControlRequest
    | ControlCancel
    | ControlResponse
    | ConversationReset
    | CommandLifecycle
    | Raw;

  const KNOWN = new Set([
    'assistant',
    'user',
    'result',
    'rate_limit_event',
    'control_request',
    'control_cancel_request',
    'control_response',
    'conversation_reset',
    'command_lifecycle',
  ]);
  const BLOCKS = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use', 'tool_result']);

  // One line of stream-json output; undefined if it isn't JSON. Events and
  // blocks of kinds the bot doesn't read become raw ones.
  export function parse(line: string): Event | undefined {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (typeof event !== 'object' || event === null) return undefined;
    const name = event.subtype ? `${event.type}/${event.subtype}` : String(event.type);
    if (event.type === 'system' && (event.subtype === 'init' || event.subtype === 'thinking_tokens')) return event;
    if (!KNOWN.has(event.type)) return { type: 'raw', name, line };
    if ((event.type === 'assistant' || event.type === 'user') && Array.isArray(event.message?.content)) {
      const content = event.message.content.map((b: any) => (BLOCKS.has(b?.type) ? b : { type: 'raw', name: String(b?.type) }));
      return { ...event, message: { ...event.message, content } };
    }
    return event;
  }

  const count = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

  // Each kind of token apart, since they're priced apart: cache reads cost a
  // tenth of fresh input, cache writes more than it
  function tokens(usage: Usage | undefined): string {
    const kinds: [keyof Usage, string][] = [
      ['cache_read_input_tokens', 'cache read'],
      ['cache_creation_input_tokens', 'cache write'],
      ['input_tokens', 'in'],
      ['output_tokens', 'out'],
    ];
    return kinds.map(([key, label]) => `${count(usage?.[key] ?? 0)} ${label}`).join(' · ');
  }

  // A turn's result as a reply
  export const reply = (event: Result): Reply => ({ text: event.result ?? event.errors?.join('\n') ?? '', isError: event.is_error ?? false });

  // A turn's tokens and cost; local commands have none
  export const cost = (event: Result) =>
    event.local_command ? undefined : `${tokens(event.usage)} · $${(event.total_cost_usd ?? 0).toFixed(3)}`;

  // The model and permission mode an instance runs with
  export const status = (event: Init) => ({ model: event.model, mode: event.permissionMode });

  // The effort a turn's /effort command set; the result's text is the only place it shows
  export const effortSet = (event: Result): string | undefined =>
    event.local_command === 'effort' ? /effort level to (\w+)/i.exec(event.result ?? '')?.[1]?.toLowerCase() : undefined;

  // Time left as its two largest units: 45m, 2h05m, 4d18h
  function left(ms: number): string {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    const [d, h, m] = [Math.floor(minutes / 1440), Math.floor(minutes / 60) % 24, minutes % 60];
    if (d > 0) return `${d}d${String(h).padStart(2, '0')}h`;
    if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
    return `${m}m`;
  }

  // What's left of the 5-hour window, in percent, and the time to its reset
  export function usage(event: RateLimit, now = Date.now()): { percent: number; reset?: string } | undefined {
    const w = event.rate_limit_info.unifiedWindows?.five_hour;
    if (!w) return undefined;
    const percent = Math.round((1 - (w.utilization ?? 0)) * 100);
    return { percent, reset: w.resetsAt ? left(w.resetsAt * 1000 - now) : undefined };
  }

  // Whether an event is Claude thinking: progress frames, or a message of thinking blocks only
  export function isThinking(event: Event): boolean {
    if (event.type === 'system') return event.subtype === 'thinking_tokens';
    if (event.type !== 'assistant') return false;
    const { content } = event.message;
    return Array.isArray(content) && content.length > 0 && content.every((c) => c.type === 'thinking' || c.type === 'redacted_thinking');
  }
}
