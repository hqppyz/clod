import { mkdir } from 'node:fs/promises';
import { Session } from './session';

// The stream-json events in a process's stdout
async function* events(stdout: ReadableStream<Uint8Array>): AsyncGenerator<Session.Event> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop()!;
    for (const line of lines) {
      const event = Session.parse(line);
      if (event) yield event;
    }
  }
}

// One running `claude` process. It reads turns from stdin until it's closed, so
// the conversation stays loaded between messages; --resume continues an
// earlier one in a new process.
export class Instance {
  sessionId: string | undefined;
  // Set once initialize answers, which a failed resume never does
  started = false;
  dead = false;
  // Set by close(), so a process killed on purpose isn't taken for a failed resume
  closed = false;
  // The command_uuid of the turn running for another client, like the Claude
  // app over Remote Control; those turns are wrapped in command_lifecycle events
  foreign: string | undefined;
  // Resolves once the process is gone and its output read
  readonly exited: Promise<void>;
  private turn: PromiseWithResolvers<Session.Reply> | undefined;
  private ask: Session.Ask | undefined;
  // The permission mode as of the latest init event, which every turn starts with
  private mode: string | undefined;
  // The initialize response, which a failed resume never gives
  private readonly initialized: Promise<Readonly<Record<string, any>> | undefined>;
  // Control requests the instance made, waiting for their response, by request id
  private readonly requests = new Map<string, PromiseWithResolvers<Readonly<Record<string, any>> | undefined>>();
  // Permission prompts waiting for an answer, by request id
  private readonly prompts = new Map<string, AbortController>();
  // Set by interrupt() until the turn it ended is over, ours or a foreign one
  interrupted = false;
  private readonly stderr: Promise<string>;

  private constructor(
    private readonly proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>,
    readonly resumed: string | undefined,
    private readonly listener: Instance.Listener,
  ) {
    this.sessionId = resumed;
    // Drained alongside stdout, so a full stderr pipe can't stall the process
    this.stderr = new Response(proc.stderr).text();
    this.exited = this.read().catch((e) => console.error('failed to read claude output:', e));
    // Stdin is read in order, so later requests wait for it without awaiting
    this.initialized = this.request({ subtype: 'initialize' });
    this.initialized.then(() => (this.started = true)).catch(() => {});
  }

  static async start(dir: string, home: string, options: Instance.Options, listener: Instance.Listener, resume?: string): Promise<Instance> {
    await mkdir(home, { recursive: true });
    // Tool calls the mode doesn't approve come to stdin as can_use_tool
    // requests, which is how AskUserQuestion is answered. Replayed user
    // messages carry the prompts of turns other clients send.
    const args = ['claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
    args.push('--permission-prompt-tool', 'stdio', '--replay-user-messages');
    if (resume) args.push('--resume', resume);
    args.push(...options.args);
    const proc = Bun.spawn(args, {
      cwd: dir,
      env: { ...Bun.env, ...options.env, CLAUDE_CONFIG_DIR: home },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return new Instance(proc, resume, listener);
  }

  // The slash commands and models an instance in dir can use. The initialize
  // control request answers without starting a turn, so this costs no tokens.
  static async commands(dir: string, home: string): Promise<{ commands: Instance.Command[]; models: Instance.Model[] }> {
    await mkdir(home, { recursive: true });
    const proc = Bun.spawn(['claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], {
      cwd: dir,
      env: { ...Bun.env, CLAUDE_CONFIG_DIR: home },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
    });
    try {
      proc.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'commands', request: { subtype: 'initialize' } })}\n`);
      proc.stdin.flush();
      for await (const event of events(proc.stdout)) {
        if (event.type !== 'control_response' || event.response.request_id !== 'commands') continue;
        const { response } = event;
        if (response.subtype !== 'success') throw new Error(`claude refused to list its commands: ${response.error}`);
        return { commands: response.response?.commands ?? [], models: response.response?.models ?? [] };
      }
      throw new Error('claude exited without listing its commands');
    } finally {
      proc.kill();
    }
  }

  // Whether the process died resuming a conversation that's gone
  get resumeFailed(): boolean {
    return this.dead && !!this.resumed && !this.started && !this.closed;
  }

  // One turn at a time; resolves with the turn's result, or an error if the
  // process dies. ask answers the turn's AskUserQuestion calls.
  send(prompt: string, ask?: Session.Ask): Promise<Session.Reply> {
    if (this.turn) throw new Error('a turn is already running');
    if (this.dead) return Promise.resolve({ text: 'claude is not running', isError: true });
    this.turn = Promise.withResolvers();
    this.ask = ask;
    this.write({ type: 'user', message: { role: 'user', content: prompt } });
    return this.turn.promise;
  }

  // The model, effort and permission mode it runs with now. Costs no tokens,
  // as neither request starts a turn. get_settings has no mode, so it's the
  // latest turn's, else the one it started in.
  async settings(): Promise<Instance.Settings> {
    const [init, settings] = await Promise.all([this.initialized, this.request({ subtype: 'get_settings' })]);
    return { model: settings?.applied?.model, effort: settings?.applied?.effort, mode: this.mode ?? init?.current_permission_mode };
  }

  // Makes the session reachable from claude.ai/code and the Claude app, or
  // stops; resolves to the session's URL there
  async remoteControl(enabled: boolean): Promise<string | undefined> {
    const response = await this.request({ subtype: 'remote_control', enabled });
    return response?.session_url;
  }

  // Sets the session's title, in claude.ai/code and the app too. A resumed
  // session reattaches to its Remote Control session, which keeps the title
  // it was created with until renamed.
  async rename(title: string): Promise<void> {
    await this.request({ subtype: 'rename_session', title, source: 'host' });
  }

  close() {
    this.closed = true;
    this.proc.kill();
  }

  // Ends the running turn, as Esc does in the terminal, whoever sent it.
  // Claude cancels any permission prompt the turn is waiting on.
  interrupt() {
    if ((!this.turn && !this.foreign) || this.interrupted) return;
    this.interrupted = true;
    this.write({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'interrupt' } });
  }

  // Sends a control request; resolves to its response, or rejects with its
  // error or once the process dies
  private request(request: { readonly subtype: string } & Record<string, unknown>): Promise<Readonly<Record<string, any>> | undefined> {
    if (this.dead) return Promise.reject(new Error('claude is not running'));
    const request_id = crypto.randomUUID();
    const pending = Promise.withResolvers<Readonly<Record<string, any>> | undefined>();
    this.requests.set(request_id, pending);
    this.write({ type: 'control_request', request_id, request });
    return pending.promise;
  }

  private write(message: object) {
    try {
      this.proc.stdin.write(`${JSON.stringify(message)}\n`);
      this.proc.stdin.flush();
    } catch {
      // The process is exiting; read() ends the turn once it has
    }
  }

  // Answers a permission prompt: the turn's ask answers AskUserQuestion, the
  // listener everything else. No timeout, as in Claude's own clients: an
  // interrupt or another client's answer cancels it.
  private async permit(request_id: string, request: Session.ControlRequest['request']) {
    const controller = new AbortController();
    this.prompts.set(request_id, controller);
    const input = request.input ?? {};
    let response: object;
    try {
      const questions = input.questions;
      if (request.tool_name === 'AskUserQuestion' && questions && this.ask) {
        response = { behavior: 'allow', updatedInput: { ...input, answers: await this.ask(questions, controller.signal) } };
      } else {
        const permission: Session.Permission = { tool: request.display_name ?? request.tool_name ?? '?', input, title: request.title, reason: request.decision_reason };
        const decision = await this.listener.permit(permission, controller.signal);
        response = decision.behavior === 'allow' ? { behavior: 'allow', updatedInput: input } : decision;
      }
    } catch (e) {
      response = { behavior: 'deny', message: `the prompt could not be answered: ${e}` };
    } finally {
      this.prompts.delete(request_id);
    }
    // A cancelled prompt takes no answer
    if (controller.signal.aborted) return;
    this.write({ type: 'control_response', response: { subtype: 'success', request_id, response } });
  }

  private async read() {
    for await (const event of events(this.proc.stdout)) this.handle(event);
    const code = await this.proc.exited;
    this.dead = true;
    // Questions still waiting can't be answered anymore, nor requests
    for (const prompt of this.prompts.values()) prompt.abort();
    for (const pending of this.requests.values()) pending.reject(new Error('claude exited'));
    this.requests.clear();
    const stderr = (await this.stderr).trim();
    if (this.closed) this.finish({ text: 'Instance closed.', isError: false });
    else this.finish({ text: stderr || `claude exited with code ${code}`, isError: true });
  }

  private handle(event: Session.Event) {
    // A foreign turn counts from its start through its completion, both
    // events included, so listeners can tell whose turn an event is
    if (event.type === 'command_lifecycle' && event.state === 'started') this.foreign = event.command_uuid;
    this.listener.event(event);
    if (event.type === 'command_lifecycle' && event.state === 'completed' && this.foreign === event.command_uuid) {
      this.foreign = undefined;
      this.interrupted = false;
    }
    if (event.type === 'control_request' && event.request.subtype === 'can_use_tool') {
      // The client that sent a foreign turn answers its prompts
      if (this.foreign) return;
      this.permit(event.request_id, event.request).catch((e) => console.error('failed to answer a permission prompt:', e));
    } else if (event.type === 'control_cancel_request') {
      this.prompts.get(event.request_id)?.abort();
    } else if (event.type === 'control_response') {
      const { response } = event;
      const pending = this.requests.get(response.request_id);
      if (!pending) return;
      this.requests.delete(response.request_id);
      if (response.subtype === 'success') pending.resolve(response.response);
      else pending.reject(new Error(response.error ?? response.subtype));
    } else if (event.type === 'system' && event.subtype === 'init') {
      this.sessionId = event.session_id;
      this.mode = event.permissionMode;
    } else if (event.type === 'result') {
      // A foreign turn's result isn't the answer to ours
      if (this.foreign) return;
      // An interrupted turn ends in an error that only carries diagnostics
      this.finish(this.interrupted ? { text: 'Interrupted.', isError: false } : Session.reply(event));
    }
  }

  private finish(reply: Session.Reply) {
    this.turn?.resolve(reply);
    this.turn = undefined;
    this.interrupted = false;
  }
}

export namespace Instance {
  export interface Model {
    readonly value: string;
    readonly displayName: string;
    readonly description: string;
  }

  export interface Command {
    readonly name: string;
    readonly description: string;
    readonly argumentHint: string;
    readonly builtin?: boolean;
  }

  // What an instance starts with: the path entry's settings, then each
  // connector's additions
  export interface Options {
    readonly args: string[];
    readonly env: Record<string, string>;
    // Connectors' CONNECTORS.<type>.md bullets, for CONNECTORS.md
    readonly prompts: string[];
  }

  // What settings() reads; each is missing when Claude doesn't say
  export interface Settings {
    readonly model?: string;
    readonly effort?: string;
    readonly mode?: string;
  }

  // Who an instance reports to: every event, whoever's turn it is, and the
  // permission prompts its turns' asks don't answer
  export interface Listener {
    event(event: Session.Event): void;
    permit(permission: Session.Permission, signal: AbortSignal): Promise<Session.Decision>;
  }

  // What happens to a session's instance, for its connectors. Each connector
  // sees each event in turn, awaited.
  export type Event =
    // About to spawn: connectors add args, env and their CONNECTORS bullet to
    // options. Throwing refuses the start, so it's a hook as much as an event.
    | { readonly type: 'starting'; readonly options: Options }
    // Spawned: setup that needs the process, like enabling Remote Control
    | { readonly type: 'started'; readonly instance: Instance }
    // Idle for a while: it stops unless a connector calls keep()
    | { readonly type: 'idle'; keep(): void }
    // Gone, and why: exit is any end nobody asked for
    | { readonly type: 'stopped'; readonly reason: 'idle' | 'restart' | 'shutdown' | 'exit' };
}
