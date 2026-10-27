import { join } from 'node:path';
import { Message, type ChatInputCommandInteraction, type Guild, type SendableChannels } from 'discord.js';
import type { Instance } from '../../claude';
import { Session } from '../../session';
import type { Connector } from '..';
import type { Discord, Path } from '.';
import { Asking } from './ask';
import { Permitting } from './permit';
import { showUsage } from './presence';
import { withStatus, type Status } from './channels';
import { LiveReply, prompt, type Outlet } from './log';

// Discord allows two topic changes per 10 minutes per channel
const TOPIC_WRITES = 2;
const TOPIC_WINDOW_MS = 10 * 60_000;

// Changes arriving together go out as one
const TOPIC_DEBOUNCE_MS = 2_000;

// A typing indicator lasts about 10 seconds, so it's renewed before that
const TYPING_MS = 8_000;

// An interaction can be answered for 15 minutes; later replies go to the channel
const INTERACTION_MS = 14 * 60_000;

// A slash command run in the channel, with the prompt that runs it in Claude
export interface Command {
  readonly interaction: ChatInputCommandInteraction;
  readonly prompt: string;
}

type Input = Message | Command;

const idOf = (input: Input) => (input instanceof Message ? input.id : input.interaction.id);

const channelOf = (input: Input) => (input instanceof Message ? input.channel : input.interaction.channel) as SendableChannels;

interface Saved {
  // The newest message Claude has answered; later ones are caught up on at startup
  readonly lastMessageId?: string;
}

const byId = (a: Input, b: Input) => {
  const [x, y] = [BigInt(idOf(a)), BigInt(idOf(b))];
  return x < y ? -1 : x > y ? 1 : 0;
};

// One message or command goes as is; several messages get their authors so
// Claude can tell them apart
function merge(batch: readonly Input[]): string {
  if (batch.length === 1) return batch[0] instanceof Message ? batch[0].content : batch[0]!.prompt;
  return (batch as Message[]).map((m) => `${m.author.displayName}: ${m.content}`).join('\n\n');
}

// Shows "typing" in the channel while on. Discord can't take it back, so once
// off it fades within 10 seconds, or at the bot's next message.
class Typing {
  private timer: Timer | undefined;

  constructor(private readonly channel: SendableChannels) {}

  set(on: boolean) {
    if (!on) {
      clearInterval(this.timer);
      this.timer = undefined;
    } else if (!this.timer) {
      const send = () => this.channel.sendTyping().catch(() => {});
      send();
      this.timer = setInterval(send, TYPING_MS);
    }
  }
}

// Keeps the status lines of a channel's topic up to date. Changes wait out
// Discord's rate limit and go out together, the latest of each line winning.
class TopicWriter {
  private status: Status = {};
  private channel: SendableChannels | undefined;
  private timer: Timer | undefined;
  // When the latest writes went out, to stay within Discord's limit
  private writes: number[] = [];
  // The last topic sent, in case the cached channel hasn't caught up with it
  private written: string | undefined;

  update(channel: SendableChannels, change: Status) {
    if (!('setTopic' in channel)) return;
    this.channel = channel;
    this.status = { ...this.status, ...change };
    const oldest = this.writes.length < TOPIC_WRITES ? 0 : this.writes[0]! + TOPIC_WINDOW_MS;
    this.timer ??= setTimeout(() => this.write(), Math.max(TOPIC_DEBOUNCE_MS, oldest - Date.now()));
  }

  private async write() {
    this.timer = undefined;
    const channel = this.channel;
    if (!channel || !('setTopic' in channel)) return;
    const status = this.status;
    this.status = {};
    const current = this.written ?? channel.topic;
    const topic = withStatus(current, status);
    if (topic === (current ?? '')) return;
    this.written = topic;
    this.writes = [...this.writes, Date.now()].slice(-TOPIC_WRITES);
    // Logged once Discord takes it, which its rate limit can hold back for minutes
    await channel
      .setTopic(topic)
      .then(() => console.log(`topic of #${channel.name}: ${JSON.stringify(topic)}`))
      .catch((e) => console.error('failed to set the channel topic:', e));
  }
}

// The turn's messages answer the input: a message gets a reply, a command its
// deferred reply while the interaction lasts. Later messages go to the channel.
function outlet(to: Input): Outlet {
  if (to instanceof Message) {
    const channel = to.channel as SendableChannels;
    return {
      send: (content, i) => channel.send({ content, ...(i === 0 ? { reply: { messageReference: to.id, failIfNotExists: false } } : {}) }),
      edit: (message, content) => message.edit(content),
      report: (content) => channel.send(content),
    };
  }
  const { interaction } = to;
  const channel = interaction.channel as SendableChannels;
  const fresh = () => Date.now() - interaction.createdTimestamp < INTERACTION_MS;
  return {
    send: (content, i) => (i === 0 && fresh() ? interaction.editReply(content) : channel.send(content)),
    edit: (message, content, i) => (i === 0 && fresh() ? interaction.editReply(content) : message.edit(content)),
    report: (content) => channel.send(content),
  };
}

// Plain messages in the channel, for a turn's output after a question
function channelOutlet(channel: SendableChannels): Outlet {
  return {
    send: (content) => channel.send(content),
    edit: (message, content) => message.edit(content),
    report: (content) => channel.send(content),
  };
}

// What each channel has seen, kept in <data>/chats.json so a restart catches
// up on what came in meanwhile
export class Chats {
  private writing: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly path: string,
    private readonly saved: Map<string, Saved>,
  ) {}

  static async load(dataDir: string): Promise<Chats> {
    const path = join(dataDir, 'chats.json');
    const file = Bun.file(path);
    const saved: Record<string, Saved> = (await file.exists()) ? await file.json() : {};
    return new Chats(path, new Map(Object.entries(saved)));
  }

  get(channelId: string): Saved | undefined {
    return this.saved.get(channelId);
  }

  save(channelId: string, saved: Saved) {
    this.saved.set(channelId, saved);
    const json = JSON.stringify(Object.fromEntries(this.saved), null, 2);
    this.writing = this.writing.then(() => Bun.write(this.path, json)).catch((e) => console.error('failed to save chats:', e));
  }
}

// A turn being shown in the channel
interface Live {
  reply: LiveReply;
  readonly typing: Typing;
}

// A channel's side of its session. Messages that arrive while Claude works go
// out merged into the next turn; commands always get a turn of their own.
// Turns sent from elsewhere show as plain messages in the channel. It's the
// Discord connector's attachment to the session.
export class Chat implements Connector.Attachment {
  private readonly seen = new Set<string>();
  private pending: Input[] = [];
  // A question Claude asked; the next message answers it instead of starting a
  // turn, and a command interrupts the turn so it can run
  private asking: Asking | undefined;
  // Tool calls waiting for Allow or Deny; a command interrupts the turn too
  private permitting = 0;
  private readonly topic = new TopicWriter();
  private draining = false;
  // The turn this channel is sending, set up before the session starts it
  private live: Live | undefined;
  // The turn the session is running, this channel's or not
  private current: Live | undefined;

  constructor(
    private readonly chats: Chats,
    private readonly discord: Discord,
    private readonly guild: Guild,
    readonly channelId: string,
    readonly session: Session,
    readonly path: Path,
  ) {}

  async lifecycle(event: Instance.Event): Promise<void> {
    if (event.type === 'started') this.refresh(event.instance);
    if (event.type !== 'starting') return;
    const bullet = await this.discord.bullet();
    if (bullet) event.options.prompts.push(bullet);
  }

  // Reads the instance's model, effort and mode into the topic; events
  // update them between reads
  private refresh(instance: Instance | undefined) {
    const channel = this.channel();
    if (!instance || !channel) return;
    instance
      .settings()
      .then((settings) => this.topic.update(channel, settings))
      .catch((e) => console.error(`failed to read the settings of ${this.session.dir}:`, e));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.discord.detach(this);
  }

  // Skips messages already answered or queued, so catch-up and live messages can overlap
  add(inputs: readonly Input[]) {
    const last = this.chats.get(this.channelId)?.lastMessageId;
    for (const input of inputs) {
      const id = idOf(input);
      if (this.seen.has(id) || (last && BigInt(id) <= BigInt(last))) continue;
      this.seen.add(id);
      if (this.asking && input instanceof Message) {
        this.asking.type(input.content);
        continue;
      }
      if (this.asking || this.permitting > 0) this.session.interrupt();
      this.pending.push(input);
    }
    this.pending.sort(byId);
    this.drain().catch((e) => console.error(`chat in ${this.session.dir} failed:`, e));
  }

  // An event of the session. This channel's turns answer their input; the
  // others' replies go to the channel under their prompt, and end with their turn.
  observe(event: Session.Event | Session.Turn) {
    const channel = this.channel();
    if (event.type === 'turn_start') {
      if (event.from === this.discord) this.current = this.live;
      else if (channel) {
        const reply = new LiveReply(channelOutlet(channel), undefined, false);
        reply.note(prompt(event.from?.id ?? 'app', event.text));
        this.current = { reply, typing: new Typing(channel) };
      }
      return;
    }
    if (event.type === 'turn_end') {
      // A turn can change them, like /model or plan mode ending
      this.refresh(this.session.instance);
      const current = this.current;
      this.current = undefined;
      // This channel's own turn finishes in drain, with the reply it awaits
      if (!current || current === this.live) return;
      current.typing.set(false);
      current.reply.finish(event.reply).catch((e) => console.error(`failed to show a turn in ${this.session.dir}:`, e));
      return;
    }
    if (!channel) return;
    if (event.type === 'system' && event.subtype === 'init') {
      this.topic.update(channel, Session.status(event));
    }
    if (event.type === 'result') {
      const effort = Session.effortSet(event);
      if (effort) this.topic.update(channel, { effort });
      const cost = Session.cost(event);
      if (cost) this.topic.update(channel, { cost });
    }
    if (event.type === 'rate_limit_event') showUsage(this.guild, event);
    const current = this.current;
    if (!current) return;
    current.typing.set(Session.isThinking(event));
    current.reply.add(event);
  }

  // Asks for Allow or Deny below the turn's messages so far; what follows goes in new ones below it.
  // Questions go to whoever sent the turn, so this leaves them to others.
  async permit(permission: Session.Permission, signal: AbortSignal): Promise<Session.Decision> {
    const channel = this.channel();
    if (!channel) throw new Error('the channel is gone');
    if (permission.tool === 'AskUserQuestion') throw new Error('questions go to whoever sent the turn');
    const current = this.current;
    await current?.reply.settle();
    const permitting = await Permitting.post(channel, permission, signal);
    if (current) current.reply = current.reply.below(channelOutlet(channel));
    this.permitting++;
    try {
      return await permitting.decided;
    } finally {
      this.permitting--;
    }
  }

  private channel(): SendableChannels | undefined {
    const channel = this.guild.channels.cache.get(this.channelId);
    return channel?.isSendable() ? channel : undefined;
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        // Messages up to the next command, or the command alone
        const command = this.pending.findIndex((input) => !(input instanceof Message));
        const batch = this.pending.splice(0, command === 0 ? 1 : command === -1 ? this.pending.length : command);
        const last = batch.at(-1)!;
        // Typing shows that Claude is thinking
        const typing = new Typing(channelOf(last));
        // A question ends the turn's messages so far; what follows goes in new ones below it
        const calls = new Map<string, Session.ToolUse>();
        const live: Live = (this.live = { reply: new LiveReply(outlet(last), calls), typing });
        try {
          const ask: Session.Ask = async (questions, signal) => {
            await live.reply.settle();
            const channel = channelOf(last);
            const asking = (this.asking = await Asking.post(channel, questions, signal));
            live.reply = live.reply.below(channelOutlet(channel));
            try {
              return await asking.answered;
            } finally {
              this.asking = undefined;
            }
          };
          const reply = await this.session.prompt(merge(batch), this.discord, ask);
          await live.reply.finish(reply);
        } finally {
          typing.set(false);
          if (this.current === live) this.current = undefined;
          this.live = undefined;
        }
        this.chats.save(this.channelId, { lastMessageId: idOf(last) });
      }
    } finally {
      this.draining = false;
    }
  }
}
