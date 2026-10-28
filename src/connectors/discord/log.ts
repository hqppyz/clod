import { escapeMarkdown, type Message } from 'discord.js';
import type { Session } from '../../session';

// Discord's message length limit
const MAX_MESSAGE = 2000;

// Longest detail on one line of the log
const MAX_DETAIL = 120;

// Longest command shown in a Bash call's code block
const MAX_COMMAND = 1500;

// Most of a Bash call's output shown under its command, from the end, in lines and
// characters; with the longest command it still fits one message
const MAX_OUTPUT_LINES = 10;
const MAX_OUTPUT = 400;

// Terminal color and cursor codes, which a code block shows as is
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

// Events about the instance, not the turn, which the log leaves out
const QUIET = new Set([
  'system/bridge_state',
  'system/session_title_changed',
  'system/background_tasks_changed',
  'system/task_summary',
  'system/post_turn_summary',
  'system/commands_changed',
]);


// A line of the log; one with an id replaces the earlier one with the same id, as
// a Bash call's output joins its command
export type Entry = string | { id: string; text: string };

// Splits at the last newline that fits, or hard at the limit
export function chunks(text: string): string[] {
  const out: string[] = [];
  while (text.length > MAX_MESSAGE) {
    const cut = text.lastIndexOf('\n', MAX_MESSAGE);
    const at = cut > 0 ? cut : MAX_MESSAGE;
    out.push(text.slice(0, at));
    text = text.slice(at).replace(/^\n/, '');
  }
  if (text) out.push(text);
  return out;
}

// One line, cut to fit
function short(text: unknown): string {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL - 1)}…` : line;
}

// A log line, in small text so Claude's own text stands out
const note = (line: string) => `-# ${escapeMarkdown(line)}`;

// The line between log lines and Claude's text, since Discord's markdown has no divider
export const RULE = `-# ${'─'.repeat(24)}`;

// The prompt of a turn sent from elsewhere, quoted under who sent it
export const prompt = (from: string, text: string) => `${note(from)}\n${text.replace(/^/gm, '> ')}`;

// Whether an entry is a log line, not Claude's text; text that starts like a note counts as one
const isLog = (entry: Entry) => typeof entry !== 'string' || entry.startsWith('-# ');

// A Bash call in a code block, under a note naming it: its command, then the end of
// its output once it comes; a zero-width space keeps backticks from closing the block
function bash(command: string, output = ''): string {
  const cut = command.length > MAX_COMMAND ? `${command.slice(0, MAX_COMMAND - 1)}…` : command;
  const body = output ? `$ ${cut}\n${output}` : `$ ${cut}`;
  return `${note('bash')}\n\`\`\`bash\n${body.replace(/```/g, '`\u200b``')}\n\`\`\``;
}

// The end of a Bash call's output, where errors and summaries go, marked when cut
function tail(output: string): string {
  const all = output.replace(ANSI, '').trimEnd();
  const kept = all.split('\n').slice(-MAX_OUTPUT_LINES).join('\n').slice(-MAX_OUTPUT);
  return kept.length < all.length ? `…\n${kept}` : kept;
}

// A tool result's text; parts that aren't text show as their type
const resultText = (content: Extract<Session.Block, { type: 'tool_result' }>): string =>
  typeof content.content === 'string' || content.content === undefined
    ? (content.content ?? '')
    : content.content.map((part) => part.text ?? `[${part.type}]`).join(' ');

// Whether a tool call is a question the bot asks in its own message
const isQuestion = (call: Session.ToolUse | undefined) => call?.name === 'AskUserQuestion' && Array.isArray(call.input?.questions);


// What a content block of an assistant or user message did; Claude's text goes as is.
// asks is whether the bot asks the turn's questions in their own message.
function block(content: Session.Block, calls: Map<string, Session.ToolUse>, asks: boolean): Entry[] {
  switch (content.type) {
    case 'text':
      return [content.text];
    // The typing indicator shows thinking instead
    case 'thinking':
    case 'redacted_thinking':
      return [];
    case 'tool_use': {
      const input = content.input ?? {};
      calls.set(content.id, content);
      // The bot asks these questions in their own message, or someone elsewhere does
      if (isQuestion(content)) return asks ? [] : [note(`asked · ${short(content.input.questions.map((q: Session.Question) => q.question).join(' / '))}`)];
      if (content.name === 'Bash' && typeof input.command === 'string') return [{ id: content.id, text: bash(input.command) }];
      // The field a person would recognize the call by, else the whole input
      const detail = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.prompt ?? JSON.stringify(input);
      return [note(`tool ${content.name} · ${short(detail)}`)];
    }
    case 'tool_result': {
      const call = calls.get(content.tool_use_id);
      // The answers show on the question's own message
      if (isQuestion(call)) return asks ? [] : [note(`answered · ${short(resultText(content))}`)];
      const command = call?.name === 'Bash' ? call.input?.command : undefined;
      if (typeof command === 'string') return [{ id: call!.id, text: bash(command, tail(resultText(content))) }];
      return [note(`${content.is_error ? 'tool error' : 'tool result'} · ${short(resultText(content))}`)];
    }
    case 'raw':
      return [note(content.name)];
  }
}

// What one event adds to the turn's messages; message events add one entry per content block.
// calls collects the turn's tool calls by id, which their results are shown with.
export function describe(event: Session.Event, calls = new Map<string, Session.ToolUse>(), asks = true): Entry[] {
  switch (event.type) {
    case 'system':
      // The channel topic shows the session's model and mode instead
      if (event.subtype === 'init') return [];
      // The typing indicator shows thinking instead
      if (event.subtype === 'thinking_tokens') return [];
      break;
    case 'assistant':
    case 'user': {
      // The prompt, echoed back; it shows as what the turn answers
      if (event.isReplay) return [];
      const { content } = event.message;
      if (typeof content === 'string') return [note(`${event.type} · ${short(content)}`)];
      return content.flatMap((c) => block(c, calls, asks));
    }
    case 'command_lifecycle':
      return [];
    case 'control_request':
      // Permission prompts, like the questions, which the bot asks in their own message
      return [];
    case 'conversation_reset':
      return [note(`conversation reset · ${event.trigger}`)];
    case 'rate_limit_event': {
      const info = event.rate_limit_info;
      // The bot's status shows usage; the log only shows a limit getting close or hit
      if (info.status === 'allowed') return [];
      const windows = Object.entries(info.unifiedWindows ?? {}).map(
        ([window, w]) => `${window} ${Math.round((w.utilization ?? 0) * 100)}%`,
      );
      return [note(`rate limit · ${[info.status, ...windows].join(' · ')}`)];
    }
    case 'result':
      // The channel topic shows the turn's cost instead
      return [];
    case 'raw':
      return QUIET.has(event.name) ? [] : [note(event.name)];
  }
  return [note(event.type)];
}

// Where a turn's messages go
export interface Outlet {
  // index is the message's place in the turn; the first one answers the input
  send(content: string, index: number): Promise<Message>;
  edit(message: Message, content: string, index: number): Promise<unknown>;
  // A plain message in the channel, for when sending or editing fails
  report(content: string): Promise<unknown>;
}

// A turn's events and reply as they happen: the first event sends a message,
// later ones edit it, and text past Discord's limit goes on in new messages.
// Edits never overlap; events that arrive during one go out together.
export class LiveReply {
  private readonly entries: string[] = [];
  // Where each entry with an id is, for its replacement
  private readonly ids = new Map<string, number>();
  private readonly messages: Message[] = [];
  private readonly sent: string[] = [];
  private flushing: Promise<void> | undefined;
  private dirty = false;
  private hasText = false;
  // Whether the last entry was a log line, to put a rule where log and text meet
  private lastLog: boolean | undefined;
  // Whether a failure has been reported in the channel, which happens once per reply
  private reported = false;

  // calls is shared by the turn's replies, since a question's result comes after it splits them;
  // asks is whether the bot asks the turn's questions itself
  constructor(
    private readonly outlet: Outlet,
    private readonly calls = new Map<string, Session.ToolUse>(),
    private readonly asks = true,
  ) {}

  add(event: Session.Event) {
    if (event.type === 'assistant' && typeof event.message.content !== 'string' && event.message.content.some((c) => c.type === 'text')) this.hasText = true;
    this.push(...describe(event, this.calls, this.asks));
  }

  // A reply that goes on where this one stops, for the turn's output after a
  // message of its own, like a question
  below(outlet: Outlet): LiveReply {
    return new LiveReply(outlet, this.calls, this.asks);
  }

  // A log line of the bot's own, like the prompt a turn answers
  note(entry: string) {
    this.push(entry);
  }

  // Adds what the events didn't show: an error, or the output of a local
  // command, which has no assistant text. Resolves once every message is up to date.
  async finish(reply: Session.Reply) {
    if (reply.isError) this.push(`Claude failed: ${reply.text}`);
    else if (!this.hasText && reply.text) this.push(reply.text);
    else if (this.entries.length === 0) this.push('(empty reply)');
    await this.flushing;
  }

  // The ids of the messages sent so far
  messageIds(): string[] {
    return this.messages.map((m) => m.id);
  }

  // Resolves once every message is up to date, for when later output goes elsewhere
  async settle() {
    while (this.flushing) await this.flushing;
  }

  // An entry whose id is in an earlier reply of the turn goes at the end of this one
  private push(...entries: Entry[]) {
    for (const entry of entries) {
      const replaces = typeof entry !== 'string' && this.ids.has(entry.id);
      if (!replaces) {
        // A blank line under the rule spaces Claude's text from it; a code block keeps its own margin
        if (this.lastLog !== undefined && this.lastLog !== isLog(entry)) this.entries.push(...(isLog(entry) ? [RULE] : [RULE, '']));
        this.lastLog = isLog(entry);
      }
      if (typeof entry === 'string') this.entries.push(entry);
      else {
        const at = this.ids.get(entry.id);
        if (at === undefined) this.ids.set(entry.id, this.entries.push(entry.text) - 1);
        else this.entries[at] = entry.text;
      }
    }
    this.dirty = true;
    this.flushing ??= this.flush().finally(() => (this.flushing = undefined));
  }

  private async flush() {
    while (this.dirty) {
      this.dirty = false;
      for (const [i, content] of chunks(this.entries.join('\n')).entries()) {
        if (this.sent[i] === content) continue;
        try {
          if (this.messages[i]) await this.outlet.edit(this.messages[i]!, content, i);
          else this.messages.push(await this.outlet.send(content, i));
          this.sent[i] = content;
        } catch (e) {
          console.error("failed to update the turn's messages:", e);
          this.report(e);
          break;
        }
      }
    }
  }

  // A reply needs more than a plain message (Read Message History, for one), so
  // a plain message can still tell why the reply is missing
  private report(e: unknown) {
    if (this.reported) return;
    this.reported = true;
    const reason = e instanceof Error ? e.message : String(e);
    this.outlet.report(`Failed to send Claude's reply: ${reason}`).catch((e) => console.error('failed to report the failure:', e));
  }
}
