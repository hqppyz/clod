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
import { Instance } from '../../claude';
import type { Clod } from '../../clod';
import type { Command } from '../../command';
import { bool, checkKeys, str } from '../../config';
import { includeIndex } from '../../dirs';
import type { Session } from '../../session';
import type { Connector } from '..';
import { pick } from './ask';
import { LoginMessages } from './auth';
import { decide, isPermitButton } from './permit';
import { CategorySync, ChannelDirs } from './channels';
import { Chat, Chats } from './chats';
import { clean } from './clean';
import { promptOf, suggest, suggestionsOf, toDiscord, type Registered, type Suggestions } from './commands';
import { snowflake, snowflakes } from './config';

// The bot's own command: empties the channel, then starts the conversation over
const CLEAN = { name: 'clean', description: 'Delete every message in this channel, then /clear the conversation' };

// /stop's button, which allow waits for
const STOP_BUTTON = 'stop:confirm';
// How long the button waits for its click
const STOP_CONFIRM_MS = 60_000;

// One path entry served, as its block says
export class Path implements Connector.Path {
  constructor(
    private readonly discord: Discord,
    readonly entry: Clod.Path,
    readonly adminOnly: boolean,
    // manual: the existing channel the path is linked to
    readonly channelId?: string,
    // auto: the category its channels go under; undefined is the top of the server
    readonly categoryId?: string,
  ) {}

  attach(session: Session): Promise<Chat> {
    return this.discord.attach(session, this);
  }
}

// A single Discord server, each served directory a channel of it
export class Discord implements Connector {
  // Each served channel's chat, one per attached session
  private readonly chatsByChannel = new Map<string, Chat>();
  // The categories auto paths keep channels in, opened as first needed
  private readonly categories = new Map<string | null, Promise<CategorySync>>();
  // Discord command name to Claude command, filled once they're registered
  private commands: Registered['names'] = new Map();
  private suggestions: Suggestions = {};
  private readonly logins: LoginMessages;

  private constructor(
    readonly id: string,
    private readonly clod: Clod,
    private readonly client: Client<true>,
    private readonly guild: Guild,
    private readonly adminIds: readonly string[],
    private readonly adminOnly: boolean,
    private readonly channelDirs: ChannelDirs,
    private readonly chats: Chats,
  ) {
    this.logins = new LoginMessages(client, adminIds);
  }

  // Resolves logged in and serving the server, or throws
  static async create(id: string, raw: Readonly<Record<string, unknown>>, clod: Clod): Promise<Discord> {
    checkKeys(raw, ['token', 'server-id', 'admin-id', 'admin-only'], `connectors.${id}`);
    const where = `connectors.${id}`;
    // The token, a secret, can stay out of config.yaml in <ID>_TOKEN, which wins
    const tokenEnv = `${id.toUpperCase().replaceAll('-', '_')}_TOKEN`;
    const token = str(Bun.env[tokenEnv] || raw.token, `${where}.token (or ${tokenEnv})`);
    const serverId = snowflake(raw['server-id'], `${where}.server-id`);
    const adminIds = snowflakes(raw['admin-id'], `${where}.admin-id`);
    const adminOnly = bool(raw['admin-only'], `${where}.admin-only`, true);

    // No DirectMessages intent, so DMs never reach the bot
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    });
    // discord.js waits out a rate limit silently, so log it
    client.rest.on('rateLimited', (info) => console.error(`rate limited on ${info.route} for ${info.retryAfter}ms`));
    const ready = new Promise<Client<true>>((resolve) => client.once(Events.ClientReady, resolve));
    try {
      await client.login(token);
      const c = await ready;
      const guild = c.guilds.cache.get(serverId);
      if (!guild) throw new Error(`bot is not a member of server ${serverId}`);
      console.log(`logged in as ${c.user.tag}, serving ${guild.name}`);
      const discord = new Discord(id, clod, c, guild, adminIds, adminOnly, await ChannelDirs.load(clod.config.dataDir), await Chats.load(clod.config.dataDir));
      discord.listen();
      discord.registerCommands();
      clod.scanned.then(() => discord.sweep()).catch((e) => console.error('failed to sweep leftover channels:', e));
      return discord;
    } catch (e) {
      await client.destroy();
      throw e;
    }
  }

  register(entry: Clod.Path, raw: Readonly<Record<string, unknown>>): Path {
    const adminOnly = bool(raw['admin-only'], 'admin-only', this.adminOnly);
    if (entry.mode === 'manual') {
      checkKeys(raw, ['channel_id', 'admin-only'], '');
      return new Path(this, entry, adminOnly, snowflake(raw.channel_id, 'channel_id'));
    }
    checkKeys(raw, ['category_id', 'admin-only'], '');
    return new Path(this, entry, adminOnly, undefined, raw.category_id == null ? undefined : snowflake(raw.category_id, 'category_id'));
  }

  // A manual path links its channel; an auto path gets a channel in its
  // category, ordered by config entry, then include order, then name
  async attach(session: Session, path: Path): Promise<Chat> {
    let channelId = path.channelId;
    if (channelId === undefined) {
      const entries = this.clod.config.paths;
      const rank = [entries.indexOf(path.entry), path.entry.mode === 'auto' ? includeIndex(path.entry, session.dir) : 0];
      channelId = await (await this.category(path.categoryId ?? null)).claim(session.dir, rank);
    }
    const chat = new Chat(this.chats, this, this.guild, channelId, session, path);
    this.chatsByChannel.set(channelId, chat);
    this.catchUp(chat).catch((e) => console.error(`failed to catch up on missed messages in ${session.dir}:`, e));
    return chat;
  }

  // A chat's attachment disposed: an auto path's channel goes with it
  async detach(chat: Chat): Promise<void> {
    if (this.chatsByChannel.get(chat.channelId) === chat) this.chatsByChannel.delete(chat.channelId);
    if (chat.path.channelId === undefined) await (await this.category(chat.path.categoryId ?? null)).release(chat.session.dir);
  }

  // Its CONNECTORS.discord.md bullet, for an instance about to start
  bullet(): Promise<string | undefined> {
    return this.clod.connectorBullet('discord', { CONNECTOR: this.id, BOT_NAME: this.client.user.username });
  }

  async notify(event: Clod.Event): Promise<void> {
    if (event.type === 'login-required') return this.logins.required(event);
    if (event.type === 'logged-in') return this.logins.done(event.by);
    for (const id of this.adminIds) {
      await this.client.users
        .fetch(id)
        .then((user) => user.send(event.text))
        .catch((e) => console.error(`failed to message admin ${id}:`, e));
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.client.destroy();
  }

  // Tidies every category holding a managed channel, so channels of earlier
  // runs go even where no path puts channels anymore. Records of channels
  // deleted by hand go too.
  private async sweep() {
    const parents = new Set<string | null>();
    for (const [channelId] of [...this.channelDirs.entries()]) {
      try {
        const channel = await this.guild.channels.fetch(channelId);
        if (channel) parents.add(channel.parentId);
      } catch (e) {
        // Only a channel Discord says is gone; any other failure keeps its record
        if (e instanceof DiscordAPIError && e.code === RESTJSONErrorCodes.UnknownChannel) this.channelDirs.delete(channelId);
        else throw e;
      }
    }
    for (const parent of parents) (await this.category(parent)).tidy();
  }

  private category(id: string | null): Promise<CategorySync> {
    let category = this.categories.get(id);
    if (!category) {
      category = CategorySync.open(this.guild, id, this.channelDirs, () => this.clod.attached);
      // A failed open is tried again by the next attach
      category.catch(() => this.categories.delete(id));
      this.categories.set(id, category);
    }
    return category;
  }

  private registerCommands() {
    // Listing needs a logged in Claude. Commands registered by an earlier run stay until then.
    this.clod.ready
      .then(async () => {
        const listed = await Instance.commands(this.clod.config.dataDir, this.clod.home);
        const found = suggestionsOf(listed);
        const registered = toDiscord(listed.commands, [CLEAN], found);
        await this.guild.commands.set(registered.data);
        this.commands = registered.names;
        this.suggestions = found;
        console.log(`registered ${registered.data.length} commands`);
      })
      .catch((e) => console.error('failed to register commands:', e));
  }

  // Single server bot: only messages from its server, never from bots
  // (including itself), and with admin-only, only from the admins
  private allowed(userId: string, channelId: string) {
    const adminOnly = this.chatsByChannel.get(channelId)?.path.adminOnly ?? this.adminOnly;
    return !adminOnly || this.adminIds.includes(userId);
  }

  private accepting(message: Message) {
    return message.guildId === this.guild.id && !message.author.bot && this.allowed(message.author.id, message.channelId);
  }

  private listen() {
    this.client.on(Events.MessageCreate, (message) => {
      if (this.accepting(message)) this.chatsByChannel.get(message.channelId)?.add([message]);
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      // Other instances of the bot may serve other servers or channels with the
      // same token, so whatever isn't in one of ours is theirs to answer
      if (interaction.guildId !== this.guild.id || !interaction.channelId) return;
      const chat = this.chatsByChannel.get(interaction.channelId);
      if (!chat) return;
      if (!this.allowed(interaction.user.id, interaction.channelId)) {
        // An interaction left unanswered shows as failed, so tell them why
        if (interaction.isRepliable()) {
          interaction.reply({ content: 'Only admins can use this bot.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        return;
      }
      if (interaction.isStringSelectMenu()) pick(interaction);
      if (interaction.isButton() && isPermitButton(interaction.customId)) {
        // Running tools nobody approved is for admins, even without admin-only
        if (this.adminIds.includes(interaction.user.id)) decide(interaction);
        else interaction.reply({ content: 'Only admins can approve tool calls.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      if (interaction.isAutocomplete()) {
        const { name, value } = interaction.options.getFocused(true);
        interaction.respond(suggest(this.suggestions[name] ?? [], value)).catch(() => {});
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      this.runCommand(interaction, chat).catch((e) => console.error(`/${interaction.commandName} failed:`, e));
    });
  }

  private async runCommand(interaction: ChatInputCommandInteraction, chat: Chat) {
    const dir = chat.session.dir;
    // /clean wipes the channel, so it's for admins even without admin-only
    if (interaction.commandName === CLEAN.name && !this.adminIds.includes(interaction.user.id)) {
      await interaction.reply({ content: `Only admins can use /${interaction.commandName}.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.commandName === CLEAN.name && interaction.inGuild() && interaction.channel) {
      // The reply stays, as /clear's answer goes into it
      const reply = await interaction.deferReply({ withResponse: true });
      const cleaned = await clean(interaction.channel, reply.resource?.message?.id).catch(async (e) => {
        console.error(`failed to clean ${dir}:`, e);
        await interaction.editReply(`Couldn't clean the channel: ${e instanceof Error ? e.message : e}`);
      });
      if (!cleaned) return;
      const { deleted, left } = cleaned;
      console.log(`cleaned ${deleted} message(s) in ${dir}${left ? `, ${left} left` : ''}`);
      if (left) await interaction.followUp(`${left} message(s) couldn't be deleted.`);
      chat.add([{ interaction, prompt: '/clear' }]);
      return;
    }
    const command = this.commands.get(interaction.commandName);
    if (command === undefined) {
      await interaction.reply({ content: 'Unknown command.', flags: MessageFlags.Ephemeral });
      return;
    }
    // Deferring buys 15 minutes to answer instead of 3 seconds
    await interaction.deferReply();
    chat.add([{ interaction, prompt: promptOf(command, interaction) }]);
  }

  // The bot's own commands restart or stop things, so they're for admins
  // even without admin-only. /stop waits for its button, on the command's
  // deferred reply, which the command's own reply replaces.
  async allow(interaction: ChatInputCommandInteraction, command: Command): Promise<Session.Decision> {
    if (!this.adminIds.includes(interaction.user.id)) return { behavior: 'deny', message: `Only admins can use /${command.name}.` };
    console.log(`/${command.name} by ${interaction.user.tag}`);
    if (command.name !== 'stop') return { behavior: 'allow' };
    const confirm = new ButtonBuilder().setCustomId(STOP_BUTTON).setLabel('Stop the bot').setStyle(ButtonStyle.Danger);
    const message = await interaction.editReply({
      content: 'This stops the whole bot until someone starts it again.',
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(confirm)],
    });
    const admin = (click: { user: { id: string }; reply(o: object): Promise<unknown> }) => {
      if (this.adminIds.includes(click.user.id)) return true;
      click.reply({ content: 'Only admins can stop the bot.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return false;
    };
    try {
      const click = await message.awaitMessageComponent({ componentType: ComponentType.Button, filter: admin, time: STOP_CONFIRM_MS });
      await click.deferUpdate();
      return { behavior: 'allow' };
    } catch {
      return { behavior: 'deny', message: 'Not stopped: nobody confirmed in time.' };
    }
  }

  // Queues the messages sent in the chat's channel while the bot was offline,
  // which go out merged into one turn
  private async catchUp(chat: Chat) {
    const last = this.chats.get(chat.channelId)?.lastMessageId;
    if (!last) return;
    const channel = await this.guild.channels.fetch(chat.channelId).catch(() => null);
    if (!channel?.isTextBased()) return;

    const missed: Message[] = [];
    let after = last;
    for (;;) {
      const page = await channel.messages.fetch({ after, limit: 100 });
      missed.push(...page.values());
      if (page.size < 100) break;
      after = page.reduce((max, m) => (BigInt(m.id) > BigInt(max) ? m.id : max), after);
    }
    const accepted = missed.filter((m) => this.accepting(m));
    if (accepted.length === 0) return;
    console.log(`catching up on ${accepted.length} message(s) in ${chat.session.dir}`);
    chat.add(accepted);
  }
}
