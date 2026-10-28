import { join } from 'node:path';
import { Message, type ChatInputCommandInteraction, type Guild, type SendableChannels } from 'discord.js';
import type { Instance } from '../../claude';
import { Command as Own } from '../../command';
import { Session } from '../../session';
import type { Connector } from '..';
import type { Discord, Path } from '.';
import { Asking } from './ask';
import { Permitting } from './permit';
import { Status } from './channels';
import { Log } from './log';

// A slash command run in the channel, with the prompt that runs it in Claude
export interface Command {
  readonly interaction: ChatInputCommandInteraction;
  readonly prompt: string;
}

type Input = Message | Command;

namespace Input {
  export const id = (input: Input) => (input instanceof Message ? input.id : input.interaction.id);

  export const channel = (input: Input) => (input instanceof Message ? input.channel : input.interaction.channel) as SendableChannels;

  export const compare = (a: Input, b: Input) => {
    const [x, y] = [BigInt(id(a)), BigInt(id(b))];
    return x < y ? -1 : x > y ? 1 : 0;
  };

  // Several messages get their authors so Claude can tell them apart
  export function merge(batch: readonly Input[]): string {
    if (batch.length === 1) return batch[0] instanceof Message ? batch[0].content : batch[0]!.prompt;
    return (batch as Message[]).map((m) => `${m.author.displayName}: ${m.content}`).join('\n\n');
  }
}

// An input's turn answers it: a message gets a reply, a command its deferred
// reply while the interaction lasts. A channel gets plain messages.
function outlet(to: Input | SendableChannels): Log.Outlet {
  // An interaction can be answered for 15 minutes; later replies go to the channel
  const INTERACTION_MS = 14 * 60_000;
  if (to instanceof Message) {
    const channel = to.channel as SendableChannels;
    return {
      send: (content, i) => channel.send({ content, ...(i === 0 ? { reply: { messageReference: to.id, failIfNotExists: false } } : {}) }),
      edit: (message, content) => message.edit(content),
      report: (content) => channel.send(content),
    };
  }
  if (!('interaction' in to)) {
    return {
      send: (content) => to.send(content),
      edit: (message, content) => message.edit(content),
      report: (content) => to.send(content),
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

// Discord can't take "typing" back, so once off it fades within 10 seconds,
// or at the bot's next message
class Typing {
  private timer: Timer | undefined;

  constructor(private readonly channel: SendableChannels) {}

  set(on: boolean) {
    // It lasts about 10 seconds, so it's renewed before that
    const RENEW_MS = 8_000;
    if (!on) {
      clearInterval(this.timer);
      this.timer = undefined;
    } else if (!this.timer) {
      const send = () => this.channel.sendTyping().catch(() => {});
      send();
      this.timer = setInterval(send, RENEW_MS);
    }
  }
}

// Changes wait out Discord's rate limit and go out together, the latest of each part winning
class Topic {
  // Discord allows two topic changes per 10 minutes per channel
  private static readonly WRITES = 2;
  private static readonly WINDOW_MS = 10 * 60_000;
  private status: Status = {};
  private channel: SendableChannels | undefined;
  private timer: Timer | undefined;
  private writes: number[] = [];
  // In case the cached channel hasn't caught up with it
  private written: string | undefined;

  update(channel: SendableChannels, change: Status) {
    // Changes arriving together go out as one
    const DEBOUNCE_MS = 2_000;
    if (!('setTopic' in channel)) return;
    this.channel = channel;
    this.status = { ...this.status, ...change };
    const oldest = this.writes.length < Topic.WRITES ? 0 : this.writes[0]! + Topic.WINDOW_MS;
    this.timer ??= setTimeout(() => this.write(), Math.max(DEBOUNCE_MS, oldest - Date.now()));
  }

  private async write() {
    this.timer = undefined;
    const channel = this.channel;
    if (!channel || !('setTopic' in channel)) return;
    const status = this.status;
    this.status = {};
    const current = this.written ?? channel.topic;
    const topic = Status.apply(current, status);
    if (topic === (current ?? '')) return;
    this.written = topic;
    this.writes = [...this.writes, Date.now()].slice(-Topic.WRITES);
    // Logged once Discord takes it, which its rate limit can hold back for minutes
    await channel
      .setTopic(topic)
      .then(() => console.log(`topic of #${channel.name}: ${JSON.stringify(topic)}`))
      .catch((e) => console.error('failed to set the channel topic:', e));
  }
}

// What each channel has seen, so a restart catches up on what came in meanwhile
export class History {
  private writing: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly path: string,
    private readonly saved: Map<string, History.Saved>,
  ) {}

  static async load(data: string): Promise<History> {
    const path = join(data, 'chats.json');
    const file = Bun.file(path);
    const saved: Record<string, History.Saved> = (await file.exists()) ? await file.json() : {};
    return new History(path, new Map(Object.entries(saved)));
  }

  get(channel: string): History.Saved | undefined {
    return this.saved.get(channel);
  }

  save(channel: string, saved: History.Saved) {
    this.saved.set(channel, saved);
    const json = JSON.stringify(Object.fromEntries(this.saved), null, 2);
    this.writing = this.writing.then(() => Bun.write(this.path, json)).catch((e) => console.error('failed to save chats:', e));
  }
}

export namespace History {
  export interface Saved {
    // The newest message Claude has answered; the key is as chats.json has it
    readonly lastMessageId?: string;
  }
}

interface Live {
  reply: Log.Reply;
  readonly typing: Typing;
}

// The Discord connector's attachment to a session. Messages that arrive while
// Claude works go out merged into the next turn; commands always get a turn of
// their own. Turns sent from elsewhere show as plain messages in the channel.
export class Chat implements Connector.Attachment {
  private readonly seen = new Set<string>();
  private pending: Input[] = [];
  // The next message answers it instead of starting a turn, and a command
  // interrupts the turn so it can run
  private asking: Asking | undefined;
  // Tool calls waiting for Allow or Deny; a command interrupts the turn too
  private permitting = 0;
  private readonly topic = new Topic();
  private draining = false;
  // Set up before the session starts it
  private live: Live | undefined;
  // A /clear empties the channel once answered
  private cleared = false;
  // This channel's or not
  private current: Live | undefined;

  constructor(
    private readonly history: History,
    private readonly discord: Discord,
    private readonly guild: Guild,
    readonly id: string,
    readonly session: Session,
    readonly path: Path,
  ) {}

  async lifecycle(event: Connector.Lifecycle): Promise<void> {
    if (event.type === 'started') this.refresh(event.instance);
    if (event.type !== 'starting') return;
    await event.prompt(this.discord.values);
  }

  // Events update the topic between reads
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
    // Claude's /clear, which empties the channel too
    const CLEAR = /^\/clear(\s|$)/;
    const last = this.history.get(this.id)?.lastMessageId;
    for (const input of inputs) {
      const id = Input.id(input);
      if (this.seen.has(id) || (last && BigInt(id) <= BigInt(last))) continue;
      this.seen.add(id);
      // Emptying the channel is for admins, even without admin-only
      const [text, user] = input instanceof Message ? [input.content, input.author.id] : [input.prompt, input.interaction.user.id];
      if (CLEAR.test(text) && !this.discord.admins.includes(user)) {
        const refused = input instanceof Message ? input.reply('Only admins can use /clear.') : input.interaction.editReply('Only admins can use /clear.');
        refused.catch((e) => console.error('failed to refuse /clear:', e));
        continue;
      }
      // The bot's own commands run at once, even during a turn. Typed out,
      // they're refused, so messages caught up on after downtime can't restart
      // or stop the bot.
      if (!(input instanceof Message) && Own.parse(input.prompt)) {
        const { interaction } = input;
        this.session
          .prompt(input.prompt, this.discord, { allow: (own) => this.discord.allow(interaction, own) })
          .then((reply) => interaction.editReply({ content: reply.text, components: [] }))
          .catch((e) => console.error(`${input.prompt} in ${this.session.dir} failed:`, e));
        continue;
      }
      if (this.asking && input instanceof Message) {
        this.asking.type(input.content);
        continue;
      }
      if (this.asking || this.permitting > 0) this.session.interrupt();
      this.pending.push(input);
    }
    this.pending.sort(Input.compare);
    this.drain().catch((e) => console.error(`chat in ${this.session.dir} failed:`, e));
  }

  // This channel's turns answer their input; the others' replies go to the
  // channel under their prompt, and end with their turn
  observe(event: Session.Event | Session.Turn) {
    const channel = this.channel();
    if (event.type === 'turn_start') {
      if (event.from === this.discord) this.current = this.live;
      else if (channel) {
        const reply = new Log.Reply(outlet(channel), undefined, false);
        reply.note(Log.prompt(event.from?.id ?? 'app', event.text));
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
      const cleared = this.cleared;
      this.cleared = false;
      current.reply
        .finish(event.reply)
        .then(() => (cleared ? this.wipe([current.reply]) : undefined))
        .catch((e) => console.error(`failed to show a turn in ${this.session.dir}:`, e));
      return;
    }
    if (!channel) return;
    if (event.type === 'system' && event.subtype === 'init') this.topic.update(channel, Status.init(event));
    if (event.type === 'result') {
      if (event.local_command === 'clear') this.cleared = true;
      const effort = Status.effort(event);
      if (effort) this.topic.update(channel, { effort });
      const cost = Status.cost(event);
      if (cost) this.topic.update(channel, { cost });
    }
    if (event.type === 'rate_limit_event') this.discord.presence.show(event);
    const current = this.current;
    if (!current) return;
    current.typing.set(Session.thinking(event));
    current.reply.add(event);
  }

  // Below the turn's messages so far; what follows goes in new ones below it
  async permit(permission: Session.Permission, signal: AbortSignal): Promise<Session.Decision> {
    const channel = this.channel();
    if (!channel) throw new Error('the channel is gone');
    if (permission.tool === 'AskUserQuestion') throw new Error('questions go to whoever sent the turn');
    const current = this.current;
    await current?.reply.settle();
    const permitting = await Permitting.post(channel, permission, signal);
    if (current) current.reply = current.reply.below(outlet(channel));
    this.permitting++;
    try {
      return await permitting.decided;
    } finally {
      this.permitting--;
    }
  }

  // Newest first: those under 14 days old in bulk, older ones one at a time, as
  // Discord allows. Stops when a round deletes nothing, so messages that can't
  // be deleted don't loop forever.
  private async wipe(replies: readonly Log.Reply[]) {
    const channel = this.guild.channels.cache.get(this.id);
    if (!channel?.isTextBased() || channel.isDMBased()) return;
    const keep = new Set(replies.flatMap((r) => r.ids()));
    let [deleted, left] = [0, 0];
    for (;;) {
      const page = (await channel.messages.fetch({ limit: 100 })).filter((message) => !keep.has(message.id));
      if (page.size === 0) break;
      const bulk = await channel.bulkDelete(page, true);
      let round = bulk.size;
      for (const message of page.values()) {
        if (bulk.has(message.id)) continue;
        if (await message.delete().then(() => true, () => false)) round++;
      }
      deleted += round;
      if (round === 0) {
        left = page.size;
        break;
      }
    }
    console.log(`cleaned ${deleted} message(s) in ${this.session.dir}${left ? `, ${left} left` : ''}`);
    if (left) await channel.send(`${left} message(s) couldn't be deleted.`);
  }

  private channel(): SendableChannels | undefined {
    const channel = this.guild.channels.cache.get(this.id);
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
        const typing = new Typing(Input.channel(last));
        const calls = new Map<string, Session.Tool>();
        const live: Live = (this.live = { reply: new Log.Reply(outlet(last), calls), typing });
        try {
          // A question ends the turn's messages so far; what follows goes in new ones below it
          const ask: Session.Ask = async (questions, signal) => {
            await live.reply.settle();
            const channel = Input.channel(last);
            const asking = (this.asking = await Asking.post(channel, questions, signal));
            live.reply = live.reply.below(outlet(channel));
            try {
              return await asking.answered;
            } finally {
              this.asking = undefined;
            }
          };
          this.cleared = false;
          const reply = await this.session.prompt(Input.merge(batch), this.discord, { ask });
          await live.reply.finish(reply);
          if (this.cleared) {
            this.cleared = false;
            await this.wipe([live.reply]);
          }
        } finally {
          typing.set(false);
          if (this.current === live) this.current = undefined;
          this.live = undefined;
        }
        this.history.save(this.id, { lastMessageId: Input.id(last) });
      }
    } finally {
      this.draining = false;
    }
  }
}
