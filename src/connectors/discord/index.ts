import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ComponentType,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  MessageFlags,
  RESTJSONErrorCodes,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
} from 'discord.js';
import { relative } from 'node:path';
import { Instance } from '../../claude';
import type { Clod } from '../../clod';
import type { Command } from '../../command';
import { Config } from '../../config';
import type { Session } from '../../session';
import type { Connector } from '..';
import { Asking } from './ask';
import { Logins } from './auth';
import { Category, Channels } from './channels';
import { Chat, History } from './chats';
import { Commands } from './commands';
import { snowflake, snowflakes } from './config';
import { Permitting } from './permit';
import { Presence } from './presence';

export class Path implements Connector.Path {
  constructor(
    private readonly discord: Discord,
    readonly entry: Config.Path,
    // admin-only
    readonly restricted: boolean,
    // manual: the existing channel the path is linked to
    readonly channel?: string,
    // auto: the category its channels go under; undefined is the top of the server
    readonly category?: string,
  ) {}

  attach(session: Session): Promise<Chat> {
    return this.discord.attach(session, this);
  }

  // The first include pattern matching dir, to order channels by; "." only matches the path itself
  include(dir: string): number {
    if (this.entry.mode !== 'auto') return 0;
    const { include } = this.entry;
    const rel = relative(this.entry.path, dir) || '.';
    const found = include.findIndex((p) => (rel === '.' ? p === '.' : new Bun.Glob(p).match(rel)));
    return found === -1 ? include.length : found;
  }
}

// A single Discord server, each served directory a channel of it
export class Discord implements Connector {
  readonly type = 'discord';
  // By channel
  private readonly chats = new Map<string, Chat>();
  // Opened as first needed
  private readonly categories = new Map<string | null, Promise<Category>>();
  // Filled once they're registered
  private commands: Commands.Registered['names'] = new Map();
  private suggestions: Commands.Suggestions = {};
  private readonly logins: Logins;
  readonly presence: Presence;

  private constructor(
    readonly id: string,
    private readonly clod: Clod,
    private readonly client: Client<true>,
    private readonly guild: Guild,
    readonly admins: readonly string[],
    // admin-only
    private readonly restricted: boolean,
    private readonly channels: Channels,
    private readonly history: History,
  ) {
    this.logins = new Logins(client, admins);
    this.presence = new Presence(guild);
  }

  static async create(id: string, raw: Readonly<Record<string, unknown>>, clod: Clod): Promise<Discord> {
    const where = `connectors.${id}`;
    Config.keys(raw, ['token', 'server-id', 'admin-id', 'admin-only'], where);
    // The token, a secret, can stay out of config.yaml in <ID>_TOKEN, which wins
    const variable = `${id.toUpperCase().replaceAll('-', '_')}_TOKEN`;
    const token = Config.text(Bun.env[variable] || raw.token, `${where}.token (or ${variable})`);
    const server = snowflake(raw['server-id'], `${where}.server-id`);
    const admins = snowflakes(raw['admin-id'], `${where}.admin-id`);
    const restricted = Config.bool(raw['admin-only'], `${where}.admin-only`, true);

    // No DirectMessages intent, so DMs never reach the bot
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    });
    // discord.js waits out a rate limit silently
    client.rest.on('rateLimited', (info) => console.error(`rate limited on ${info.route} for ${info.retryAfter}ms`));
    const ready = new Promise<Client<true>>((resolve) => client.once(Events.ClientReady, resolve));
    try {
      await client.login(token);
      const c = await ready;
      const guild = c.guilds.cache.get(server);
      if (!guild) throw new Error(`bot is not a member of server ${server}`);
      console.log(`logged in as ${c.user.tag}, serving ${guild.name}`);
      const discord = new Discord(id, clod, c, guild, admins, restricted, await Channels.load(clod.config.data), await History.load(clod.config.data));
      discord.listen();
      // Listing needs a logged in Claude. Commands registered by an earlier run stay until then.
      clod.ready
        .then(async () => {
          const listed = await Instance.commands(clod.config.data, clod.config.home);
          const suggestions = Commands.suggestions(listed);
          const registered = Commands.build(listed.commands, suggestions);
          await guild.commands.set(registered.data);
          discord.commands = registered.names;
          discord.suggestions = suggestions;
          console.log(`registered ${registered.data.length} commands`);
        })
        .catch((e) => console.error('failed to register commands:', e));
      // Every category holding a managed channel is tidied, so channels of
      // earlier runs go even where no path puts channels anymore
      clod.scanned
        .then(async () => {
          const parents = new Set<string | null>();
          for (const [id] of [...discord.channels.entries()]) {
            try {
              const channel = await guild.channels.fetch(id);
              if (channel) parents.add(channel.parentId);
            } catch (e) {
              // Only a channel Discord says is gone; any other failure keeps its record
              if (e instanceof DiscordAPIError && e.code === RESTJSONErrorCodes.UnknownChannel) discord.channels.delete(id);
              else throw e;
            }
          }
          for (const parent of parents) (await discord.category(parent)).tidy();
        })
        .catch((e) => console.error('failed to sweep leftover channels:', e));
      return discord;
    } catch (e) {
      await client.destroy();
      throw e;
    }
  }

  register(entry: Config.Path, raw: Readonly<Record<string, unknown>>): Path {
    const restricted = Config.bool(raw['admin-only'], 'admin-only', this.restricted);
    if (entry.mode === 'manual') {
      Config.keys(raw, ['channel_id', 'admin-only'], '');
      return new Path(this, entry, restricted, snowflake(raw.channel_id, 'channel_id'));
    }
    Config.keys(raw, ['category_id', 'admin-only'], '');
    return new Path(this, entry, restricted, undefined, raw.category_id == null ? undefined : snowflake(raw.category_id, 'category_id'));
  }

  // An auto path's channels are ordered by config entry, then include order, then name
  async attach(session: Session, path: Path): Promise<Chat> {
    let id = path.channel;
    if (id === undefined) {
      const rank = [this.clod.config.paths.indexOf(path.entry), path.include(session.dir)];
      id = await (await this.category(path.category ?? null)).claim(session.dir, rank);
    }
    const chat = new Chat(this.history, this, this.guild, id, session, path);
    this.chats.set(id, chat);
    // Messages sent while the bot was offline go out merged into one turn
    const missed = async () => {
      const last = this.history.get(chat.id)?.lastMessageId;
      if (!last) return;
      const channel = await this.guild.channels.fetch(chat.id).catch(() => null);
      if (!channel?.isTextBased()) return;
      const found: Message[] = [];
      let after = last;
      for (;;) {
        const page = await channel.messages.fetch({ after, limit: 100 });
        found.push(...page.values());
        if (page.size < 100) break;
        after = page.reduce((max, m) => (BigInt(m.id) > BigInt(max) ? m.id : max), after);
      }
      const accepted = found.filter((m) => this.accepting(m));
      if (accepted.length === 0) return;
      console.log(`catching up on ${accepted.length} message(s) in ${session.dir}`);
      chat.add(accepted);
    };
    missed().catch((e) => console.error(`failed to catch up on missed messages in ${session.dir}:`, e));
    return chat;
  }

  // An auto path's channel goes with its chat
  async detach(chat: Chat): Promise<void> {
    if (this.chats.get(chat.id) === chat) this.chats.delete(chat.id);
    if (chat.path.channel === undefined) await (await this.category(chat.path.category ?? null)).release(chat.session.dir);
  }

  // For its CONNECTORS.discord.md
  get values(): Readonly<Record<string, string>> {
    return { CONNECTOR: this.id, BOT_NAME: this.client.user.username };
  }

  async notify(event: Clod.Event): Promise<void> {
    if (event.type === 'login-required') return this.logins.required(event);
    if (event.type === 'logged-in') return this.logins.done(event.by);
    for (const id of this.admins) {
      await this.client.users
        .fetch(id)
        .then((user) => user.send(event.text))
        .catch((e) => console.error(`failed to message admin ${id}:`, e));
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.client.destroy();
  }

  private category(id: string | null): Promise<Category> {
    let category = this.categories.get(id);
    if (!category) {
      category = Category.open(this.guild, id, this.channels, () => this.clod.attached);
      // A failed open is tried again by the next attach
      category.catch(() => this.categories.delete(id));
      this.categories.set(id, category);
    }
    return category;
  }

  private allowed(user: string, channel: string) {
    const restricted = this.chats.get(channel)?.path.restricted ?? this.restricted;
    return !restricted || this.admins.includes(user);
  }

  // Single server bot: never from bots, itself included
  private accepting(message: Message) {
    return message.guildId === this.guild.id && !message.author.bot && this.allowed(message.author.id, message.channelId);
  }

  private listen() {
    this.client.on(Events.MessageCreate, (message) => {
      if (this.accepting(message)) this.chats.get(message.channelId)?.add([message]);
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      // Other instances of the bot may serve other servers or channels with the
      // same token, so whatever isn't in one of ours is theirs to answer
      if (interaction.guildId !== this.guild.id || !interaction.channelId) return;
      const chat = this.chats.get(interaction.channelId);
      if (!chat) return;
      if (!this.allowed(interaction.user.id, interaction.channelId)) {
        // An interaction left unanswered shows as failed, so tell them why
        if (interaction.isRepliable()) {
          interaction.reply({ content: 'Only admins can use this bot.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        return;
      }
      if (interaction.isStringSelectMenu()) Asking.pick(interaction);
      if (interaction.isButton() && Permitting.owns(interaction.customId)) {
        // Running tools nobody approved is for admins, even without admin-only
        if (this.admins.includes(interaction.user.id)) Permitting.click(interaction);
        else interaction.reply({ content: 'Only admins can approve tool calls.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      if (interaction.isAutocomplete()) {
        const { name, value } = interaction.options.getFocused(true);
        interaction.respond(Commands.suggest(this.suggestions[name] ?? [], value)).catch(() => {});
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      const command = this.commands.get(interaction.commandName);
      if (command === undefined) {
        interaction.reply({ content: 'Unknown command.', flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      // Deferring buys 15 minutes to answer instead of 3 seconds
      interaction
        .deferReply()
        .then(() => chat.add([{ interaction, prompt: Commands.prompt(command, interaction) }]))
        .catch((e) => console.error(`/${interaction.commandName} failed:`, e));
    });
  }

  // The bot's own commands restart or stop things, so they're for admins
  // even without admin-only. /stop waits for its button, on the command's
  // deferred reply, which the command's own reply replaces.
  async allow(interaction: ChatInputCommandInteraction, command: Command): Promise<Session.Decision> {
    const BUTTON = 'stop:confirm';
    const CONFIRM_MS = 60_000;
    if (!this.admins.includes(interaction.user.id)) return { behavior: 'deny', message: `Only admins can use /${command.name}.` };
    console.log(`/${command.name} by ${interaction.user.tag}`);
    if (command.name !== 'stop') return { behavior: 'allow' };
    const confirm = new ButtonBuilder().setCustomId(BUTTON).setLabel('Stop the bot').setStyle(ButtonStyle.Danger);
    const message = await interaction.editReply({
      content: 'This stops the whole bot until someone starts it again.',
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(confirm)],
    });
    const admin = (click: { user: { id: string }; reply(o: object): Promise<unknown> }) => {
      if (this.admins.includes(click.user.id)) return true;
      click.reply({ content: 'Only admins can stop the bot.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return false;
    };
    try {
      const click = await message.awaitMessageComponent({ componentType: ComponentType.Button, filter: admin, time: CONFIRM_MS });
      await click.deferUpdate();
      return { behavior: 'allow' };
    } catch {
      return { behavior: 'deny', message: 'Not stopped: nobody confirmed in time.' };
    }
  }
}
