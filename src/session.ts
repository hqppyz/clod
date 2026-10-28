import { Instance } from './claude';
import type { Clod } from './clod';
import { Command } from './command';
import { Config } from './config';
import type { Connector } from './connectors';

type Reason = Extract<Connector.Lifecycle, { type: 'stopped' }>['reason'];

// The conversation of one directory, whether an instance runs it or it's only on disk
export class Session {
  // Changes on /clear or a failed resume
  id: string | undefined;
  // Claude doesn't keep them across a resume, so the resume passes them on
  chosen: Session.Chosen;
  readonly attachments = new Map<Connector, Connector.Attachment>();
  private running: Instance | undefined;
  // So a turn and a wake don't start two instances
  private launching: Promise<Instance> | undefined;
  private stopping: Reason | undefined;
  private idle: Timer | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  // Ours, shown as started once the foreign turn ends
  private waiting: Session.Turn | undefined;
  // A foreign turn's result waits for its command to complete; a foreign
  // command of the bot's own resolves to its reply
  private foreign: { reply?: Session.Reply; command?: Promise<Session.Reply> } = {};

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

  // A command of the bot's own skips the queue; without allow it's refused
  prompt(text: string, from: Connector, { ask, allow }: Session.Handlers = {}): Promise<Session.Reply> {
    const command = Command.parse(text);
    if (command) return this.command(command, allow);
    const turn = this.queue.then(() => this.turn(text, from, ask));
    this.queue = turn.catch(() => {});
    return turn;
  }

  // For connectors that need an instance up without a turn, like Remote Control
  async wake(): Promise<void> {
    await this.launch();
    this.rest();
  }

  interrupt() {
    this.running?.interrupt();
  }

  restart() {
    this.stop('restart');
  }

  shutdown() {
    this.stop('shutdown');
  }

  private stop(reason: Reason) {
    clearTimeout(this.idle);
    if (!this.running) return;
    this.stopping = reason;
    this.running.close();
  }

  private async command(command: Command, allow: Session.Allow | undefined): Promise<Session.Reply> {
    const failed = (e: unknown): Session.Decision => ({ behavior: 'deny', message: `/${command.name} failed: ${e instanceof Error ? e.message : e}` });
    const decision = allow ? await allow(command).catch(failed) : { behavior: 'deny' as const, message: `/${command.name} can't be run from here.` };
    if (decision.behavior === 'deny') return { text: decision.message, failed: true };
    return this.clod.command(command, this);
  }

  // A foreign command has no sender to ask, so any connector may allow it
  private readonly poll: Session.Allow = (command) => {
    const allowing = [...this.attachments.values()].flatMap((a) => (a.allow ? [a.allow(command)] : []));
    if (allowing.length === 0) return Promise.resolve({ behavior: 'deny', message: `No connector allows /${command.name} from here.` });
    return Promise.any(allowing);
  };

  private async turn(text: string, from: Connector, ask?: Session.Ask): Promise<Session.Reply> {
    const instance = await this.launch();
    clearTimeout(this.idle);
    const turn: Session.Turn = { type: 'turn_start', from, text };
    if (instance.foreign) this.waiting = turn;
    else this.emit(turn);
    // from's id tags the prompt, but not a slash command, which has to come first
    const reply = await instance.send(text.startsWith('/') ? text : `[${from.id}] ${text}`, ask);
    this.waiting = undefined;
    if (instance.dead) {
      await instance.exited;
      if (instance.lost) return this.turn(text, from, ask);
    }
    this.rest();
    return reply;
  }

  private launch(): Promise<Instance> {
    if (this.running) return Promise.resolve(this.running);
    return (this.launching ??= this.start().finally(() => (this.launching = undefined)));
  }

  // Every connector must be attached first, so each adds its part
  private async start(): Promise<Instance> {
    await this.clod.ready;
    await this.clod.attached;
    await this.clod.install();
    const options = Config.options(this.clod.config, this.dir);
    options.args.unshift('--settings', Command.settings(this.clod.config.home));
    const prompts: string[] = [];
    for (const [connector, attachment] of this.attachments) {
      const prompt = async (values: Readonly<Record<string, string>>) => {
        const filled = await this.clod.prompts.connector(connector.type, values);
        if (filled) prompts.push(filled);
      };
      await attachment.lifecycle({ type: 'starting', options, prompt });
    }
    if (this.id && this.chosen.model) options.args.push('--model', this.chosen.model);
    if (this.id && this.chosen.effort) options.args.push('--effort', this.chosen.effort);
    const prompt = await this.clod.prompts.system(prompts);
    if (prompt) options.args.push('--append-system-prompt', prompt);
    const instance = (this.running = await Instance.start(this.dir, this.clod.config.home, options, { event: (event) => this.read(event), permit: (permission, signal) => this.permit(permission, signal) }, this.id));
    instance.exited.then(() => this.gone(instance));
    await this.lifecycle({ type: 'started', instance });
    return instance;
  }

  private async gone(instance: Instance) {
    if (this.running !== instance) return;
    this.running = undefined;
    clearTimeout(this.idle);
    const reason = this.stopping ?? 'exit';
    this.stopping = undefined;
    if (instance.lost) {
      console.error(`session in ${this.dir} could not resume, starting over`);
      this.id = undefined;
      this.chosen = {};
      this.clod.save(this);
    }
    // A foreign turn cut short ends here, as its command never completes;
    // one restarting the instance is cut short by its own doing
    if (instance.foreign) {
      const { command } = this.foreign;
      this.foreign = {};
      this.emit({ type: 'turn_end', reply: command ? await command : { text: 'claude exited', failed: true } });
    }
    await this.lifecycle({ type: 'stopped', reason });
  }

  private rest() {
    // The next turn resumes the session
    const IDLE_MS = 5 * 60_000;
    clearTimeout(this.idle);
    if (!this.running) return;
    this.idle = setTimeout(async () => {
      let kept = false;
      await this.lifecycle({ type: 'idle', keep: () => (kept = true) });
      if (kept) this.rest();
      else this.stop('idle');
    }, IDLE_MS);
  }

  // Only logged, as the instance is up or gone either way; starting's errors
  // refuse the start, so start sends it itself
  private async lifecycle(event: Exclude<Connector.Lifecycle, { type: 'starting' }>) {
    for (const [connector, attachment] of this.attachments) {
      try {
        await attachment.lifecycle(event);
      } catch (e) {
        console.error(`${connector.id} failed on ${event.type} of ${this.dir}:`, e);
      }
    }
  }

  // A foreign turn's prompt is the replayed user message with the command's uuid
  private read(event: Session.Event) {
    const instance = this.running;
    // Kept up to date on every event, as a /clear sent from another client
    // starts a new conversation without a turn of ours to save it
    if (instance?.id && instance.id !== this.id) {
      if (this.id) this.chosen = {};
      this.id = instance.id;
      this.clod.save(this);
    }
    if (instance && event.type === 'result' && (event.local_command === 'model' || event.local_command === 'effort')) this.choose(instance);
    if (event.type === 'command_lifecycle' && event.state === 'started') clearTimeout(this.idle);
    if (event.type === 'user' && event.isReplay && instance?.foreign && event.uuid === instance.foreign) {
      const { content } = event.message;
      const text = typeof content === 'string' ? content : content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      this.emit({ type: 'turn_start', from: undefined, text });
    }
    // A command of the bot's own never reaches the model, as the hook blocks
    // it; the event saying so is the only place its prompt shows
    if (event.type === 'system' && event.subtype === 'informational' && instance?.foreign) {
      const text = Command.blocked(event.content);
      const command = text === undefined ? undefined : Command.parse(text);
      if (text !== undefined && command) {
        this.emit({ type: 'turn_start', from: undefined, text });
        this.foreign.command = this.command(command, this.poll);
        return;
      }
    }
    // The rest of a foreign command's turn is Claude's answer to it, which nobody needs
    const completed = event.type === 'command_lifecycle' && event.state === 'completed';
    if (this.foreign.command && instance?.foreign && !completed) return;
    // An interrupted turn ends in an error that only carries diagnostics
    if (event.type === 'result' && instance?.foreign) this.foreign.reply = instance.interrupted ? { text: 'Interrupted.', failed: false } : Session.reply(event);
    this.emit(event);
    if (completed) {
      const { command, reply } = this.foreign;
      this.foreign = {};
      if (command) command.then((reply) => this.settle(reply));
      else this.settle(reply ?? { text: '', failed: false });
    }
    // Our own turn ends with its result, while the next event can still be a foreign turn's
    if (event.type === 'result' && !instance?.foreign) this.emit({ type: 'turn_end', reply: Session.reply(event) });
  }

  private async choose(instance: Instance) {
    const { model, effort } = await instance.settings().catch(() => ({ model: undefined, effort: undefined }));
    this.chosen = { model, effort };
    this.clod.save(this);
  }

  // Ends a foreign turn, then starts ours waiting on it
  private settle(reply: Session.Reply) {
    this.emit({ type: 'turn_end', reply });
    if (this.waiting) this.emit(this.waiting);
    this.waiting = undefined;
    this.rest();
  }

  // The first answer wins and the others are aborted
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
  export interface Reply {
    readonly text: string;
    readonly failed: boolean;
  }

  export interface Question {
    readonly question: string;
    readonly header: string;
    readonly options: readonly { label: string; description?: string }[];
    readonly multiSelect: boolean;
  }

  // Answers are keyed by question text. The signal aborts when Claude stops waiting.
  export type Ask = (questions: readonly Question[], signal: AbortSignal) => Promise<Record<string, string>>;

  export interface Chosen {
    readonly model?: string;
    readonly effort?: string;
  }

  // A session as <data>/sessions.json keeps it
  export interface Saved extends Chosen {
    readonly id?: string;
  }

  // A deny's message is the command's reply
  export type Allow = (command: Command) => Promise<Decision>;

  export interface Handlers {
    readonly ask?: Ask;
    readonly allow?: Allow;
  }

  // from is undefined for a turn another client sent, like the Claude app
  export type Turn =
    | { readonly type: 'turn_start'; readonly from: Connector | undefined; readonly text: string }
    | { readonly type: 'turn_end'; readonly reply: Reply };

  export interface Permission {
    readonly tool: string;
    readonly input: Readonly<Record<string, any>>;
    readonly title?: string;
    readonly reason?: string;
  }

  export type Decision = { readonly behavior: 'allow' } | { readonly behavior: 'deny'; readonly message: string };

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
    // A block of a type the bot doesn't read
    | { readonly type: 'raw'; readonly name: string };

  export type Tool = Extract<Block, { type: 'tool_use' }>;

  export interface Usage {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_read_input_tokens?: number;
    readonly cache_creation_input_tokens?: number;
  }

  export interface Window {
    readonly utilization?: number;
    readonly resetsAt?: number;
  }

  export interface Init {
    readonly type: 'system';
    readonly subtype: 'init';
    readonly session_id: string;
    readonly model: string;
    readonly permissionMode: string;
  }
  // A prompt a UserPromptSubmit hook blocked
  export interface Blocked {
    readonly type: 'system';
    readonly subtype: 'informational';
    readonly content: string;
  }
  export interface Thinking {
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
  // Only turns another client sent have one
  export interface Lifecycle {
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
  export interface Limit {
    readonly type: 'rate_limit_event';
    readonly rate_limit_info: { readonly status?: string; readonly unifiedWindows?: Readonly<Record<string, Window>> };
  }
  export interface Request {
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
  export interface Cancel {
    readonly type: 'control_cancel_request';
    readonly request_id: string;
  }
  // To a control request the bot made
  export interface Response {
    readonly type: 'control_response';
    readonly response: {
      readonly subtype: string;
      readonly request_id: string;
      readonly error?: string;
      readonly response?: Readonly<Record<string, any>>;
    };
  }
  export interface Reset {
    readonly type: 'conversation_reset';
    readonly trigger: string;
  }
  // An event of a kind the bot doesn't read; name is its type and subtype
  export interface Raw {
    readonly type: 'raw';
    readonly name: string;
    readonly line: string;
  }

  export type Event =
    | Init
    | Thinking
    | Blocked
    | Message
    | Result
    | Limit
    | Request
    | Cancel
    | Response
    | Reset
    | Lifecycle
    | Raw;

  // Undefined if it isn't JSON
  export function parse(line: string): Event | undefined {
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
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (typeof event !== 'object' || event === null) return undefined;
    const name = event.subtype ? `${event.type}/${event.subtype}` : String(event.type);
    if (event.type === 'system' && (event.subtype === 'init' || event.subtype === 'thinking_tokens')) return event;
    if (event.type === 'system' && event.subtype === 'informational' && event.prompt_submit_outcome?.kind === 'blocked_by_hook') return event;
    if (!KNOWN.has(event.type)) return { type: 'raw', name, line };
    if ((event.type === 'assistant' || event.type === 'user') && Array.isArray(event.message?.content)) {
      const content = event.message.content.map((b: any) => (BLOCKS.has(b?.type) ? b : { type: 'raw', name: String(b?.type) }));
      return { ...event, message: { ...event.message, content } };
    }
    return event;
  }

  export const reply = (event: Result): Reply => ({ text: event.result ?? event.errors?.join('\n') ?? '', failed: event.is_error ?? false });

  // Progress frames, or a message of thinking blocks only
  export function thinking(event: Event): boolean {
    if (event.type === 'system') return event.subtype === 'thinking_tokens';
    if (event.type !== 'assistant') return false;
    const { content } = event.message;
    return Array.isArray(content) && content.length > 0 && content.every((c) => c.type === 'thinking' || c.type === 'redacted_thinking');
  }
}
