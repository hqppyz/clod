import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ButtonInteraction,
  type Channel,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
} from "discord.js";
import { pick } from "./ask";
import { CategorySync, ChannelDirs } from "./channels";
import { clean } from "./clean";
import { authenticate } from "./auth";
import { Chats } from "./chats";
import { claudeHome, listCommands } from "./claude";
import { promptOf, suggest, suggestionsOf, toDiscord, type Registered, type Suggestions } from "./commands";
import type { AutoEntry, Config, PathConfig } from "./config";
import { includeIndex } from "./dirs";
import { RESTART_CODE } from "./restart";
import { watchDirs } from "./watcher";

// The bot's own command: empties the channel, then starts the conversation over
const CLEAN = { name: "clean", description: "Delete every message in this channel, then /clear the conversation" };

// The bot's own command: a new claude process for the channel, or a new bot process
const RESTART = {
  name: "restart",
  description: "Restart this channel's Claude session, or the whole bot",
  options: [
    {
      type: ApplicationCommandOptionType.String as const,
      name: "what",
      description: "session or bot",
      required: true,
      choices: ["session", "bot"].map((c) => ({ name: c, value: c })),
    },
  ],
};

// The bot's own command: exits the bot for good, once its button confirms it
const STOP = { name: "stop", description: "Stop the whole bot" };
const STOP_BUTTON = "stop:confirm";

export async function startBot(config: Config): Promise<never> {
  const { serverId, token } = config.discord;

  // No DirectMessages intent, so DMs never reach the bot
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  // Single server bot: only messages from serverId, never from bots (including
  // itself), and with admin-only, only from the admins
  const allowed = (userId: string) => !config.discord.adminOnly || config.discord.adminIds.includes(userId);
  const accepting = (message: Message) => message.guildId === serverId && !message.author.bot && allowed(message.author.id);

  const ready = new Promise<Guild>((resolve) => {
    client.once(Events.ClientReady, (c) => {
      const guild = c.guilds.cache.get(serverId);
      if (!guild) {
        console.error(`bot is not a member of server ${serverId}`);
        process.exit(1);
      }
      console.log(`logged in as ${c.user.tag}, serving ${guild.name}`);
      resolve(guild);
    });
  });

  // Manual channels map to their path; auto channels to the directory they were
  // made for, trusted only inside a configured category (null: no category)
  const channelDirs = await ChannelDirs.load(config.dataDir);
  const manual = new Map(config.paths.flatMap((entry) => (entry.mode === "manual" ? [[entry.channelId, entry.path]] : [])));
  const categories = new Set(config.paths.flatMap((entry) => (entry.mode === "auto" ? [entry.categoryId ?? null] : [])));
  const dirFor = (channel: Channel): string | undefined => {
    const dir = manual.get(channel.id);
    if (dir !== undefined) return dir;
    if (channel.type !== ChannelType.GuildText || !categories.has(channel.parentId)) return undefined;
    return channelDirs.get(channel.id);
  };

  const { promise: authed, resolve: authDone } = Promise.withResolvers<void>();
  // Sessions start from messages, so the bot is logged in by then
  const chats = await Chats.load(config, authed, () => client.user?.username ?? "");

  // discord.js waits out a rate limit silently, so log it
  client.rest.on("rateLimited", (info) => console.error(`rate limited on ${info.route} for ${info.retryAfter}ms`));

  client.on(Events.MessageCreate, (message) => {
    if (!accepting(message)) return;
    const dir = dirFor(message.channel);
    if (dir !== undefined) chats.chat(message.channelId, dir).add([message]);
  });

  // Discord command name to Claude command, filled once they're registered
  let commands: Registered["names"] = new Map();
  let suggestions: Suggestions = {};
  const runCommand = async (interaction: ChatInputCommandInteraction, dir: string) => {
    // The bot's own commands wipe, restart or stop things, so they're for admins even without admin-only
    const own = [CLEAN.name, RESTART.name, STOP.name].includes(interaction.commandName);
    if (own && !config.discord.adminIds.includes(interaction.user.id)) {
      await interaction.reply({ content: `Only admins can use /${interaction.commandName}.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.commandName === STOP.name) {
      const confirm = new ButtonBuilder().setCustomId(STOP_BUTTON).setLabel("Stop the bot").setStyle(ButtonStyle.Danger);
      await interaction.reply({
        content: "This stops the whole bot until someone starts it again.",
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(confirm)],
      });
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
      console.log(`cleaned ${deleted} message(s) in ${dir}${left ? `, ${left} left` : ""}`);
      if (left) await interaction.followUp(`${left} message(s) couldn't be deleted.`);
      chats.chat(interaction.channelId, dir).add([{ interaction, prompt: "/clear" }]);
      return;
    }
    if (interaction.commandName === RESTART.name && interaction.options.getString("what") === "bot") {
      console.log(`restart requested by ${interaction.user.tag}`);
      await interaction.reply("Restarting the bot…").catch(() => {});
      chats.stop();
      await client.destroy();
      process.exit(RESTART_CODE);
    }
    if (interaction.commandName === RESTART.name) {
      chats.chat(interaction.channelId, dir).stop();
      console.log(`restarted the session in ${dir}`);
      await interaction.reply("Session restarted; the next message resumes the conversation.");
      return;
    }
    const command = commands.get(interaction.commandName);
    if (command === undefined) {
      await interaction.reply({ content: "Unknown command.", flags: MessageFlags.Ephemeral });
      return;
    }
    // Deferring buys 15 minutes to answer instead of 3 seconds
    await interaction.deferReply();
    chats.chat(interaction.channelId, dir).add([{ interaction, prompt: promptOf(command, interaction) }]);
  };
  // Exit code 0, so index.ts doesn't start a new process
  const stop = async (interaction: ButtonInteraction) => {
    if (!config.discord.adminIds.includes(interaction.user.id)) {
      await interaction.reply({ content: "Only admins can stop the bot.", flags: MessageFlags.Ephemeral });
      return;
    }
    console.log(`stop requested by ${interaction.user.tag}`);
    await interaction.update({ content: "Stopping the bot…", components: [] }).catch(() => {});
    chats.stop();
    await client.destroy();
    process.exit(0);
  };
  client.on(Events.InteractionCreate, (interaction) => {
    // Other instances of the bot may serve other servers or channels with the
    // same token, so whatever isn't in one of ours is theirs to answer
    if (interaction.guildId !== serverId || !interaction.channel) return;
    const dir = dirFor(interaction.channel);
    if (dir === undefined) return;
    if (!allowed(interaction.user.id)) {
      // An interaction left unanswered shows as failed, so tell them why
      if (interaction.isRepliable()) {
        interaction.reply({ content: "Only admins can use this bot.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }
    if (interaction.isStringSelectMenu()) pick(interaction);
    if (interaction.isButton() && interaction.customId === STOP_BUTTON) {
      stop(interaction).catch((e) => console.error("stop failed:", e));
    }
    if (interaction.isAutocomplete()) {
      const { name, value } = interaction.options.getFocused(true);
      interaction.respond(suggest(suggestions[name] ?? [], value)).catch(() => {});
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    runCommand(interaction, dir).catch((e) => console.error(`/${interaction.commandName} failed:`, e));
  });

  await client.login(token);
  const guild = await ready;
  // Runs alongside the channel sync; interactions arrive without a DM intent
  authenticate(client, config)
    .catch((e) => console.error("claude login failed:", e))
    .finally(authDone);
  // Listing needs a logged in Claude. Commands registered by an earlier run stay until then.
  authed
    .then(async () => {
      const listed = await listCommands(config.dataDir, claudeHome(config));
      const found = suggestionsOf(listed);
      const registered = toDiscord(listed.commands, [CLEAN, RESTART, STOP], found);
      await guild.commands.set(registered.data);
      commands = registered.names;
      suggestions = found;
      console.log(`registered ${registered.data.length} commands`);
    })
    .catch((e) => console.error("failed to register commands:", e));
  catchUp(guild, chats, dirFor, accepting).catch((e) => console.error("failed to catch up on missed messages:", e));
  return eventLoop(config, guild, channelDirs);
}

// Queues the messages sent while the bot was offline, which go out merged into one turn
async function catchUp(
  guild: Guild,
  chats: Chats,
  dirFor: (channel: Channel) => string | undefined,
  accepting: (message: Message) => boolean,
) {
  for (const channelId of chats.answered()) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    const dir = channel ? dirFor(channel) : undefined;
    if (!channel?.isTextBased() || dir === undefined) continue;

    const missed: Message[] = [];
    let after = chats.get(channelId)!.lastMessageId!;
    for (;;) {
      const page = await channel.messages.fetch({ after, limit: 100 });
      missed.push(...page.values());
      if (page.size < 100) break;
      after = page.reduce((max, m) => (BigInt(m.id) > BigInt(max) ? m.id : max), after);
    }
    const accepted = missed.filter(accepting);
    if (accepted.length === 0) continue;
    console.log(`catching up on ${accepted.length} message(s) in ${dir}`);
    chats.chat(channelId, dir).add(accepted);
  }
}

async function eventLoop(config: Config, guild: Guild, channelDirs: ChannelDirs): Promise<never> {
  const autoEntries = config.paths.filter((entry): entry is AutoEntry => entry.mode === "auto");

  // One sync per category; several auto entries may share a category. Entries
  // without one share the null key, the top of the server.
  const syncs = new Map<string | null, CategorySync>();
  for (const { categoryId = null } of autoEntries) {
    if (!syncs.has(categoryId)) syncs.set(categoryId, await CategorySync.open(guild, categoryId, channelDirs));
  }

  const matched = new Map<PathConfig, Set<string>>(config.paths.map((entry) => [entry, new Set()]));

  // Wanted dirs in channel order: config entry order, then the first include
  // pattern matching each dir, then alphabetical
  const reconcile = async (categoryId: string | null) => {
    const wanted: string[] = [];
    for (const entry of autoEntries) {
      if ((entry.categoryId ?? null) !== categoryId) continue;
      const rank = (dir: string) => includeIndex(entry, dir);
      const dirs = [...matched.get(entry)!].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
      for (const dir of dirs) if (!wanted.includes(dir)) wanted.push(dir);
    }
    const sync = syncs.get(categoryId)!;
    try {
      await sync.reconcile(wanted);
    } catch (e) {
      console.error(`failed to sync category ${sync.name}:`, e);
    }
  };

  // Reconciling waits for "ready", so a half-finished initial scan can't delete channels
  let synced = false;
  for await (const event of watchDirs(config.paths)) {
    if (event.type === "ready") {
      synced = true;
      for (const categoryId of syncs.keys()) await reconcile(categoryId);
      continue;
    }

    const { type, entry, dir } = event;
    console.log(`${type === "added" ? "+" : "-"} ${dir} (${entry.mode})`);
    if (type === "added") matched.get(entry)!.add(dir);
    else matched.get(entry)!.delete(dir);

    if (synced && entry.mode === "auto") await reconcile(entry.categoryId ?? null);
  }
  throw new Error("directory watcher stopped");
}
