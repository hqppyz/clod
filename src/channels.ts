import { basename, join } from "node:path";
import { ChannelType, type CategoryChannel, type Guild, type TextChannel } from "discord.js";

// Which directory each managed channel holds, kept in the data dir.
// Unmanaged channels are never deleted, so the category can hold other
// channels too; one whose name matches a new directory is adopted instead.
export class ChannelDirs {
  private writing: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly path: string,
    private readonly dirs: Map<string, string>,
  ) {}

  static async load(dataDir: string): Promise<ChannelDirs> {
    const path = join(dataDir, "channels.json");
    const file = Bun.file(path);
    const saved: Record<string, string> = (await file.exists()) ? await file.json() : {};
    return new ChannelDirs(path, new Map(Object.entries(saved)));
  }

  get(channelId: string): string | undefined {
    return this.dirs.get(channelId);
  }

  set(channelId: string, dir: string) {
    this.dirs.set(channelId, dir);
    this.save();
  }

  delete(channelId: string) {
    if (this.dirs.delete(channelId)) this.save();
  }

  private save() {
    const json = JSON.stringify(Object.fromEntries(this.dirs), null, 2);
    this.writing = this.writing.then(() => Bun.write(this.path, json)).catch((e) => console.error("failed to save channels:", e));
  }
}

// The status line the bot keeps as a channel's topic, found by its shape so
// updating one part leaves the others alone. Lines of no known shape, like an
// old format's, are dropped so the topic fixes itself.
// All on one line, as "<model> · <effort> · <mode> · <cost>"
export interface Status {
  readonly model?: string;
  readonly effort?: string;
  // The session's permission mode
  readonly mode?: string;
  // The last turn's tokens and cost, as "<tokens> · $<cost>"
  readonly cost?: string;
}

const STATUS_LINE = /^(\S+) · (\S+) · ([a-zA-Z]+)(?: · (.+ · \$[\d.]+))?$/;

export function parseTopic(topic: string | null): Status {
  const lines = (topic ?? "").split("\n").filter(Boolean);
  const [, model, effort, mode, cost] = lines.map((l) => STATUS_LINE.exec(l)).find(Boolean) ?? [];
  return { model, effort, mode, cost };
}

// The topic with the given parts replaced and the others kept
export function withStatus(topic: string | null, status: Status): string {
  const { model, effort, mode, cost } = { ...parseTopic(topic), ...stripUndefined(status) };
  return model && effort && mode ? [model, effort, mode, cost].filter(Boolean).join(" · ") : "";
}

const stripUndefined = (status: Status) => Object.fromEntries(Object.entries(status).filter(([, v]) => v !== undefined));

// Discord text channel names: lowercase, no spaces, at most 100 characters
function channelName(dir: string): string {
  const name = basename(dir).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (name || "root").slice(0, 100);
}

// Keeps the managed text channels of one category, or of the top of the server
// when null, in line with a set of directories.
export class CategorySync {
  private constructor(
    private readonly guild: Guild,
    private readonly category: CategoryChannel | null,
    private readonly dirs: ChannelDirs,
  ) {}

  static async open(guild: Guild, categoryId: string | null, dirs: ChannelDirs): Promise<CategorySync> {
    if (categoryId === null) return new CategorySync(guild, null, dirs);
    const category = await guild.channels.fetch(categoryId).catch(() => null);
    if (category?.type !== ChannelType.GuildCategory) {
      throw new Error(`category ${categoryId} not found in server ${guild.name}`);
    }
    return new CategorySync(guild, category, dirs);
  }

  get name(): string {
    return this.category?.name ?? "(no category)";
  }

  private textChannels(): TextChannel[] {
    const parentId = this.category?.id ?? null;
    return [...this.guild.channels.cache.values()]
      .filter((c): c is TextChannel => c.parentId === parentId && c.type === ChannelType.GuildText)
      .sort((a, b) => a.position - b.position);
  }

  // Adopts or creates channels for missing directories, deletes managed
  // channels whose directory is no longer wanted (including duplicates), then
  // orders managed channels like wanted.
  async reconcile(wanted: readonly string[]): Promise<void> {
    const seen = new Set<string>();
    const unmanaged: TextChannel[] = [];
    for (const channel of this.textChannels()) {
      const dir = this.dirs.get(channel.id);
      if (dir === undefined) {
        unmanaged.push(channel);
        continue;
      }
      if (wanted.includes(dir) && !seen.has(dir)) {
        seen.add(dir);
        continue;
      }
      await channel.delete(`directory gone: ${dir}`);
      this.dirs.delete(channel.id);
      console.log(`deleted #${channel.name} (${dir})`);
    }

    for (const dir of wanted) {
      if (seen.has(dir)) continue;
      const name = channelName(dir);

      const existing = unmanaged.findIndex((channel) => channel.name === name);
      if (existing !== -1) {
        const [channel] = unmanaged.splice(existing, 1) as [TextChannel];
        this.dirs.set(channel.id, dir);
        console.log(`adopted #${channel.name} (${dir})`);
        continue;
      }

      const channel = await this.guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: this.category?.id,
        reason: `directory found: ${dir}`,
      });
      this.dirs.set(channel.id, dir);
      console.log(`created #${channel.name} (${dir})`);
    }

    await this.order(wanted);
  }

  // Managed channels take the slots managed channels already occupy, in wanted
  // order; unmanaged channels keep their place.
  private async order(wanted: readonly string[]): Promise<void> {
    const current = this.textChannels();
    const managed = new Map<string, TextChannel>();
    for (const channel of current) {
      const dir = this.dirs.get(channel.id);
      if (dir !== undefined) managed.set(dir, channel);
    }

    const queue = wanted.flatMap((dir) => managed.get(dir) ?? []);
    const target = current.map((channel) => (this.dirs.get(channel.id) === undefined ? channel : queue.shift()!));
    if (target.every((channel, i) => channel === current[i])) return;

    await this.guild.channels.setPositions(target.map((channel, position) => ({ channel, position })));
    console.log(`ordered ${this.name}: ${target.map((c) => `#${c.name}`).join(" ")}`);
  }
}
