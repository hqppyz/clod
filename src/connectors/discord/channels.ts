import { basename, join } from 'node:path';
import { ChannelType, type CategoryChannel, type Guild, type TextChannel } from 'discord.js';

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
    const path = join(dataDir, 'channels.json');
    const file = Bun.file(path);
    const saved: Record<string, string> = (await file.exists()) ? await file.json() : {};
    return new ChannelDirs(path, new Map(Object.entries(saved)));
  }

  get(channelId: string): string | undefined {
    return this.dirs.get(channelId);
  }

  entries(): IterableIterator<[string, string]> {
    return this.dirs.entries();
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
    this.writing = this.writing.then(() => Bun.write(this.path, json)).catch((e) => console.error('failed to save channels:', e));
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
  const lines = (topic ?? '').split('\n').filter(Boolean);
  const [, model, effort, mode, cost] = lines.map((l) => STATUS_LINE.exec(l)).find(Boolean) ?? [];
  return { model, effort, mode, cost };
}

// The topic with the given parts replaced and the others kept
export function withStatus(topic: string | null, status: Status): string {
  const { model, effort, mode, cost } = { ...parseTopic(topic), ...stripUndefined(status) };
  return model && effort && mode ? [model, effort, mode, cost].filter(Boolean).join(' · ') : '';
}

const stripUndefined = (status: Status) => Object.fromEntries(Object.entries(status).filter(([, v]) => v !== undefined));

// Discord text channel names: lowercase, no spaces, at most 100 characters
function channelName(dir: string): string {
  const name = basename(dir).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return (name || 'root').slice(0, 100);
}

// Keeps the managed text channels of one category, or of the top of the server
// when null: a channel per claimed directory, adopted or created as it's
// claimed and deleted as it's released. Once the changes in progress settle,
// managed channels nobody claimed, like those of directories gone while the
// bot was off, are deleted, and the claimed ones ordered by rank.
export class CategorySync {
  // Claimed directories, with their channel and rank
  private readonly claimed = new Map<string, { channelId: string; rank: readonly number[] }>();
  // Changes go one at a time, so two claims can't create the same channel
  private queue: Promise<unknown> = Promise.resolve();
  private tidying = false;

  private constructor(
    private readonly guild: Guild,
    private readonly category: CategoryChannel | null,
    private readonly dirs: ChannelDirs,
    // Resolves once no claims or releases are on their way
    private readonly settled: () => Promise<void>,
  ) {}

  static async open(guild: Guild, categoryId: string | null, dirs: ChannelDirs, settled: () => Promise<void>): Promise<CategorySync> {
    if (categoryId === null) return new CategorySync(guild, null, dirs, settled);
    const category = await guild.channels.fetch(categoryId).catch(() => null);
    if (category?.type !== ChannelType.GuildCategory) {
      throw new Error(`category ${categoryId} not found in server ${guild.name}`);
    }
    return new CategorySync(guild, category, dirs, settled);
  }

  get name(): string {
    return this.category?.name ?? '(no category)';
  }

  // The channel for dir: its managed one, else an unmanaged one of its name,
  // else a new one. rank orders it among the others, lowest first, then by directory.
  claim(dir: string, rank: readonly number[]): Promise<string> {
    return this.run(async () => {
      const claimed = this.claimed.get(dir);
      if (claimed) return claimed.channelId;
      const channel = (await this.find(dir)) ?? (await this.create(dir));
      this.claimed.set(dir, { channelId: channel.id, rank });
      this.tidy();
      return channel.id;
    });
  }

  // Deletes dir's channel
  release(dir: string): Promise<void> {
    return this.run(async () => {
      const claimed = this.claimed.get(dir);
      if (!claimed) return;
      this.claimed.delete(dir);
      const channel = this.guild.channels.cache.get(claimed.channelId);
      await channel?.delete(`directory gone: ${dir}`);
      this.dirs.delete(claimed.channelId);
      console.log(`deleted #${channel?.name ?? claimed.channelId} (${dir})`);
      this.tidy();
    });
  }

  private run<T>(change: () => Promise<T>): Promise<T> {
    const result = this.queue.then(change);
    this.queue = result.catch(() => {});
    return result;
  }

  private textChannels(): TextChannel[] {
    const parentId = this.category?.id ?? null;
    return [...this.guild.channels.cache.values()]
      .filter((c): c is TextChannel => c.parentId === parentId && c.type === ChannelType.GuildText)
      .sort((a, b) => a.position - b.position);
  }

  private async find(dir: string): Promise<TextChannel | undefined> {
    const channels = this.textChannels();
    const managed = channels.find((channel) => this.dirs.get(channel.id) === dir);
    if (managed) return managed;
    const name = channelName(dir);
    const unmanaged = channels.find((channel) => this.dirs.get(channel.id) === undefined && channel.name === name);
    if (!unmanaged) return undefined;
    this.dirs.set(unmanaged.id, dir);
    console.log(`adopted #${unmanaged.name} (${dir})`);
    return unmanaged;
  }

  private async create(dir: string): Promise<TextChannel> {
    const channel = await this.guild.channels.create({
      name: channelName(dir),
      type: ChannelType.GuildText,
      parent: this.category?.id,
      reason: `directory found: ${dir}`,
    });
    this.dirs.set(channel.id, dir);
    console.log(`created #${channel.name} (${dir})`);
    return channel;
  }

  // Once the changes in progress settle: one tidy for all of them
  tidy() {
    if (this.tidying) return;
    this.tidying = true;
    this.settled()
      .then(() =>
        this.run(async () => {
          this.tidying = false;
          await this.deleteUnclaimed();
          await this.order();
        }),
      )
      .catch((e) => console.error(`failed to tidy ${this.name}:`, e));
  }

  private async deleteUnclaimed() {
    const kept = new Set([...this.claimed.values()].map((c) => c.channelId));
    for (const channel of this.textChannels()) {
      const dir = this.dirs.get(channel.id);
      if (dir === undefined || kept.has(channel.id)) continue;
      await channel.delete(`directory gone: ${dir}`);
      this.dirs.delete(channel.id);
      console.log(`deleted #${channel.name} (${dir})`);
    }
  }

  // Managed channels take the slots managed channels already occupy, in rank
  // order; unmanaged channels keep their place.
  private async order(): Promise<void> {
    const byRank = (a: [string, { rank: readonly number[] }], b: [string, { rank: readonly number[] }]) => {
      for (let i = 0; i < Math.max(a[1].rank.length, b[1].rank.length); i++) {
        const d = (a[1].rank[i] ?? 0) - (b[1].rank[i] ?? 0);
        if (d) return d;
      }
      return a[0].localeCompare(b[0]);
    };
    const wanted = [...this.claimed].sort(byRank).map(([, c]) => c.channelId);
    const current = this.textChannels();
    const queue = wanted.flatMap((id) => current.find((channel) => channel.id === id) ?? []);
    const target = current.map((channel) => (this.dirs.get(channel.id) === undefined ? channel : queue.shift()!));
    if (target.every((channel, i) => channel === current[i])) return;

    await this.guild.channels.setPositions(target.map((channel, position) => ({ channel, position })));
    console.log(`ordered ${this.name}: ${target.map((c) => `#${c.name}`).join(' ')}`);
  }
}
