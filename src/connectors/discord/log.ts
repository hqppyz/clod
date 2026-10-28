import { escapeMarkdown, type Message } from 'discord.js';
import type { Session } from '../../session';
import { cut } from './text';

// A turn's events as Discord messages
export namespace Log {
  // Discord's message length limit
  const MAX_MESSAGE = 2000;

  // A line of the log; one with an id replaces the earlier one with the same id,
  // as a Bash call's output joins its command
  export type Entry = string | { id: string; text: string };

  export interface Outlet {
    // index is the message's place in the turn; the first one answers the input
    send(content: string, index: number): Promise<Message>;
    edit(message: Message, content: string, index: number): Promise<unknown>;
    // For when sending or editing fails
    report(content: string): Promise<unknown>;
  }

  // Splits at the last newline that fits, or hard at the limit
  export function chunks(text: string): string[] {
    const out: string[] = [];
    while (text.length > MAX_MESSAGE) {
      const at = text.lastIndexOf('\n', MAX_MESSAGE);
      const end = at > 0 ? at : MAX_MESSAGE;
      out.push(text.slice(0, end));
      text = text.slice(end).replace(/^\n/, '');
    }
    if (text) out.push(text);
    return out;
  }

  // One line, cut to fit
  function short(text: unknown): string {
    const MAX_DETAIL = 120;
    return cut(String(text ?? '').replace(/\s+/g, ' ').trim(), MAX_DETAIL);
  }

  // Small text, so Claude's own text stands out
  const note = (line: string) => `-# ${escapeMarkdown(line)}`;

  // Discord's markdown has no divider
  export const RULE = `-# ${'─'.repeat(24)}`;

  // The prompt of a turn sent from elsewhere, quoted under who sent it
  export const prompt = (from: string, text: string) => `${note(from)}\n${text.replace(/^/gm, '> ')}`;

  // Text that starts like a note counts as one
  const logged = (entry: Entry) => typeof entry !== 'string' || entry.startsWith('-# ');

  // Its command, then the end of its output once it comes, where errors and
  // summaries go; a zero-width space keeps backticks from closing the block
  function bash(command: string, output?: string): string {
    // With the longest command, the output still fits one message
    const MAX_COMMAND = 1500;
    const MAX_LINES = 10;
    const MAX_OUTPUT = 400;
    // Terminal color and cursor codes, which a code block shows as is
    const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
    let body = `$ ${cut(command, MAX_COMMAND)}`;
    const all = output?.replace(ANSI, '').trimEnd();
    if (all) {
      const kept = all.split('\n').slice(-MAX_LINES).join('\n').slice(-MAX_OUTPUT);
      body += `\n${kept.length < all.length ? `…\n${kept}` : kept}`;
    }
    return `${note('bash')}\n\`\`\`bash\n${body.replace(/```/g, '`​``')}\n\`\`\``;
  }

  // Parts that aren't text show as their type
  const text = (content: Extract<Session.Block, { type: 'tool_result' }>): string =>
    typeof content.content === 'string' || content.content === undefined
      ? (content.content ?? '')
      : content.content.map((part) => part.text ?? `[${part.type}]`).join(' ');

  const question = (call: Session.Tool | undefined) => call?.name === 'AskUserQuestion' && Array.isArray(call.input?.questions);

  // calls collects the turn's tool calls by id, which their results are shown
  // with; asks is whether the bot asks the turn's questions in their own message
  function block(content: Session.Block, calls: Map<string, Session.Tool>, asks: boolean): Entry[] {
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
        if (question(content)) return asks ? [] : [note(`asked · ${short(content.input.questions.map((q: Session.Question) => q.question).join(' / '))}`)];
        if (content.name === 'Bash' && typeof input.command === 'string') return [{ id: content.id, text: bash(input.command) }];
        // The field a person would recognize the call by, else the whole input
        const detail = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.prompt ?? JSON.stringify(input);
        return [note(`tool ${content.name} · ${short(detail)}`)];
      }
      case 'tool_result': {
        const call = calls.get(content.tool_use_id);
        // The answers show on the question's own message
        if (question(call)) return asks ? [] : [note(`answered · ${short(text(content))}`)];
        const command = call?.name === 'Bash' ? call.input?.command : undefined;
        if (typeof command === 'string') return [{ id: call!.id, text: bash(command, text(content)) }];
        return [note(`${content.is_error ? 'tool error' : 'tool result'} · ${short(text(content))}`)];
      }
      case 'raw':
        return [note(content.name)];
    }
  }

  export function describe(event: Session.Event, calls = new Map<string, Session.Tool>(), asks = true): Entry[] {
    // About the instance, not the turn
    const QUIET = new Set([
      'system/bridge_state',
      'system/session_title_changed',
      'system/background_tasks_changed',
      'system/task_summary',
      'system/post_turn_summary',
      'system/commands_changed',
    ]);
    switch (event.type) {
      case 'system':
        // The channel topic shows the model and mode, the typing indicator thinking
        if (event.subtype === 'init' || event.subtype === 'thinking_tokens') return [];
        break;
      case 'assistant':
      case 'user': {
        // The prompt, echoed back; it shows as what the turn answers
        if (event.isReplay) return [];
        const { content } = event.message;
        if (typeof content === 'string') return [note(`${event.type} · ${short(content)}`)];
        return content.flatMap((c) => block(c, calls, asks));
      }
      // Permission prompts, like the questions, get their own message
      case 'command_lifecycle':
      case 'control_request':
        return [];
      case 'conversation_reset':
        return [note(`conversation reset · ${event.trigger}`)];
      case 'rate_limit_event': {
        const info = event.rate_limit_info;
        // The bot's status shows usage; the log only shows a limit getting close or hit
        if (info.status === 'allowed') return [];
        const windows = Object.entries(info.unifiedWindows ?? {}).map(([window, w]) => `${window} ${Math.round((w.utilization ?? 0) * 100)}%`);
        return [note(`rate limit · ${[info.status, ...windows].join(' · ')}`)];
      }
      // The channel topic shows the turn's cost
      case 'result':
        return [];
      case 'raw':
        return QUIET.has(event.name) ? [] : [note(event.name)];
    }
    return [note(event.type)];
  }

  // The first event sends a message, later ones edit it, and text past
  // Discord's limit goes on in new messages. Edits never overlap; events that
  // arrive during one go out together.
  export class Reply {
    private readonly entries: string[] = [];
    // Where each entry with an id is, for its replacement
    private readonly slots = new Map<string, number>();
    private readonly messages: Message[] = [];
    private readonly sent: string[] = [];
    private flushing: Promise<void> | undefined;
    private dirty = false;
    private texted = false;
    // To put a rule where log and text meet
    private logged: boolean | undefined;
    // Once per reply
    private reported = false;

    // calls is shared by the turn's replies, since a question's result comes after it splits them
    constructor(
      private readonly outlet: Outlet,
      private readonly calls = new Map<string, Session.Tool>(),
      private readonly asks = true,
    ) {}

    add(event: Session.Event) {
      if (event.type === 'assistant' && typeof event.message.content !== 'string' && event.message.content.some((c) => c.type === 'text')) this.texted = true;
      this.push(...describe(event, this.calls, this.asks));
    }

    // For the turn's output after a message of its own, like a question
    below(outlet: Outlet): Reply {
      return new Reply(outlet, this.calls, this.asks);
    }

    note(entry: string) {
      this.push(entry);
    }

    // Adds what the events didn't show: an error, or the output of a local
    // command, which has no assistant text
    async finish(reply: Session.Reply) {
      if (reply.failed) this.push(`Claude failed: ${reply.text}`);
      else if (!this.texted && reply.text) this.push(reply.text);
      else if (this.entries.length === 0) this.push('(empty reply)');
      await this.flushing;
    }

    ids(): string[] {
      return this.messages.map((m) => m.id);
    }

    // For when later output goes elsewhere
    async settle() {
      while (this.flushing) await this.flushing;
    }

    // An entry whose id is in an earlier reply of the turn goes at the end of this one
    private push(...entries: Entry[]) {
      for (const entry of entries) {
        if (typeof entry === 'string' || !this.slots.has(entry.id)) {
          // A blank line under the rule spaces Claude's text from it; a code block keeps its own margin
          if (this.logged !== undefined && this.logged !== logged(entry)) this.entries.push(...(logged(entry) ? [RULE] : [RULE, '']));
          this.logged = logged(entry);
        }
        if (typeof entry === 'string') this.entries.push(entry);
        else {
          const at = this.slots.get(entry.id);
          if (at === undefined) this.slots.set(entry.id, this.entries.push(entry.text) - 1);
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

    // A reply needs more than a plain message (Read Message History, for one),
    // so a plain message can still tell why the reply is missing
    private report(e: unknown) {
      if (this.reported) return;
      this.reported = true;
      const reason = e instanceof Error ? e.message : String(e);
      this.outlet.report(`Failed to send Claude's reply: ${reason}`).catch((e) => console.error('failed to report the failure:', e));
    }
  }
}
