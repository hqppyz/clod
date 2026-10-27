import { Instance } from './claude';
import type { Clod } from './clod';
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

  constructor(
    private readonly clod: Clod,
    readonly dir: string,
    id?: string,
  ) {
    this.id = id;
  }

  get instance(): Instance | undefined {
    return this.running;
  }

  // Runs text as a turn. from's id tags the prompt, but not a slash command,
  // which has to come first; ask answers the turn's AskUserQuestion calls, for
  // the connector that sent it.
  prompt(text: string, from: Connector, ask?: Session.Ask): Promise<Session.Reply> {
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
    this.id = instance.sessionId ?? this.id;
    this.clod.save(this);
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
      this.clod.save(this);
    }
    // A foreign turn cut short ends here, as its command never completes
    if (instance.foreign) this.emit({ type: 'turn_end', reply: { text: 'claude exited', isError: true } });
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
    if (event.type === 'command_lifecycle' && event.state === 'started') clearTimeout(this.idle);
    if (event.type === 'user' && event.isReplay && instance?.foreign && event.uuid === instance.foreign) {
      const { content } = event.message;
      const text = typeof content === 'string' ? content : content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      this.emit({ type: 'turn_start', from: undefined, text });
    }
    // An interrupted turn ends in an error that only carries diagnostics
    if (event.type === 'result' && instance?.foreign) this.foreignReply = instance.interrupted ? { text: 'Interrupted.', isError: false } : Session.reply(event);
    this.emit(event);
    if (event.type === 'command_lifecycle' && event.state === 'completed') {
      this.emit({ type: 'turn_end', reply: this.foreignReply ?? { text: '', isError: false } });
      this.foreignReply = undefined;
      if (this.waiting) this.emit(this.waiting);
      this.waiting = undefined;
      this.rest();
    }
    // Our own turn ends with its result, while the next event can still be a foreign turn's
    if (event.type === 'result' && !instance?.foreign) this.emit({ type: 'turn_end', reply: Session.reply(event) });
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
