import { basename, join } from 'node:path';
import { ChannelType, type CategoryChannel, type Guild, type TextChannel } from 'discord.js';
import type { Session } from '../../session';

// Which directory each managed channel holds. Unmanaged channels are never
// deleted, so the category can hold other channels too; one whose name
// matches a new directory is adopted instead.
export class Channels {
  private writing: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly path: string,
    private readonly dirs: Map<string, string>,
  ) {}

  static async load(data: string): Promise<Channels> {
    const path = join(data, 'channels.json');
    const file = Bun.file(path);
    const saved: Record<string, string> = (await file.exists()) ? await file.json() : {};
    return new Channels(path, new Map(Object.entries(saved)));
  }

  get(id: string): string | undefined {
    return this.dirs.get(id);
  }

  entries(): IterableIterator<[string, string]> {
    return this.dirs.entries();
  }

  set(id: string, dir: string) {
    this.dirs.set(id, dir);
    this.save();
  }

  delete(id: string) {
    if (this.dirs.delete(id)) this.save();
  }

  private save() {
    const json = JSON.stringify(Object.fromEntries(this.dirs), null, 2);
    this.writing = this.writing.then(() => Bun.write(this.path, json)).catch((e) => console.error('failed to save channels:', e));
  }
}

// The line the bot keeps as a channel's topic, "<model> · <effort> · <mode> · <cost>"
export interface Status {
  readonly model?: string;
  readonly effort?: string;
  readonly mode?: string;
  // "<tokens> · $<cost>"
  readonly cost?: string;
}

// Found by its shape, so updating one part leaves the others alone. Lines of
// no known shape, like an old format's, are dropped so the topic fixes itself.
export namespace Status {
  const LINE = /^(\S+) · (\S+) · ([a-zA-Z]+)(?: · (.+ · \$[\d.]+))?$/;

  export function parse(topic: string | null): Status {
    const lines = (topic ?? '').split('\n').filter(Boolean);
    const [, model, effort, mode, cost] = lines.map((l) => LINE.exec(l)).find(Boolean) ?? [];
    return { model, effort, mode, cost };
  }

  // Each kind of token apart, since they're priced apart: cache reads cost a
  // tenth of fresh input, cache writes more than it. Local commands have none.
  export function cost(event: Session.Result): string | undefined {
    if (event.local_command) return undefined;
    const kinds: [keyof Session.Usage, string][] = [
      ['cache_read_input_tokens', 'cache read'],
      ['cache_creation_input_tokens', 'cache write'],
      ['input_tokens', 'in'],
      ['output_tokens', 'out'],
    ];
    const tokens = kinds.map(([key, label]) => {
      const n = event.usage?.[key] ?? 0;
      return `${n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n} ${label}`;
    });
    return `${tokens.join(' · ')} · $${(event.total_cost_usd ?? 0).toFixed(3)}`;
  }

  export const init = (event: Session.Init): Status => ({ model: event.model, mode: event.permissionMode });

  // The result's text is the only place it shows
  export const effort = (event: Session.Result): string | undefined =>
    event.local_command === 'effort' ? /effort level to (\w+)/i.exec(event.result ?? '')?.[1]?.toLowerCase() : undefined;

  // The topic with the given parts replaced and the others kept
  export function apply(topic: string | null, status: Status): string {
    const given = Object.fromEntries(Object.entries(status).filter(([, v]) => v !== undefined));
    const { model, effort, mode, cost } = { ...parse(topic), ...given };
    return model && effort && mode ? [model, effort, mode, cost].filter(Boolean).join(' · ') : '';
  }
}

// The managed text channels of one category, or of the top of the server when
// null: one per claimed directory, adopted or created as it's claimed and
// deleted as it's released. Once the changes in progress settle, managed
// channels nobody claimed, like those of directories gone while the bot was
// off, are deleted, and the claimed ones ordered by rank.
export class Category {
  private readonly claimed = new Map<string, { id: string; rank: readonly number[] }>();
  // Changes go one at a time, so two claims can't create the same channel
  private queue: Promise<unknown> = Promise.resolve();
  private tidying = false;

  private constructor(
    private readonly guild: Guild,
    private readonly category: CategoryChannel | null,
    private readonly dirs: Channels,
    // Resolves once no claims or releases are on their way
    private readonly settled: () => Promise<void>,
  ) {}

  static async open(guild: Guild, id: string | null, dirs: Channels, settled: () => Promise<void>): Promise<Category> {
    if (id === null) return new Category(guild, null, dirs, settled);
    const category = await guild.channels.fetch(id).catch(() => null);
    if (category?.type !== ChannelType.GuildCategory) throw new Error(`category ${id} not found in server ${guild.name}`);
    return new Category(guild, category, dirs, settled);
  }

  // Discord text channel names: lowercase, no spaces, at most 100 characters
  private static slug(dir: string): string {
    const name = basename(dir).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return (name || 'root').slice(0, 100);
  }

  get name(): string {
    return this.category?.name ?? '(no category)';
  }

  // Its managed channel, else an unmanaged one of its name, else a new one.
  // rank orders it among the others, lowest first, then by directory.
  claim(dir: string, rank: readonly number[]): Promise<string> {
    return this.run(async () => {
      const claimed = this.claimed.get(dir);
      if (claimed) return claimed.id;
      const channel = (await this.find(dir)) ?? (await this.create(dir));
      this.claimed.set(dir, { id: channel.id, rank });
      this.tidy();
      return channel.id;
    });
  }

  release(dir: string): Promise<void> {
    return this.run(async () => {
      const claimed = this.claimed.get(dir);
      if (!claimed) return;
      this.claimed.delete(dir);
      const channel = this.guild.channels.cache.get(claimed.id);
      await channel?.delete(`directory gone: ${dir}`);
      this.dirs.delete(claimed.id);
      console.log(`deleted #${channel?.name ?? claimed.id} (${dir})`);
      this.tidy();
    });
  }

  private run<T>(change: () => Promise<T>): Promise<T> {
    const result = this.queue.then(change);
    this.queue = result.catch(() => {});
    return result;
  }

  private channels(): TextChannel[] {
    const parent = this.category?.id ?? null;
    return [...this.guild.channels.cache.values()]
      .filter((c): c is TextChannel => c.parentId === parent && c.type === ChannelType.GuildText)
      .sort((a, b) => a.position - b.position);
  }

  private async find(dir: string): Promise<TextChannel | undefined> {
    const channels = this.channels();
    const managed = channels.find((channel) => this.dirs.get(channel.id) === dir);
    if (managed) return managed;
    const name = Category.slug(dir);
    const unmanaged = channels.find((channel) => this.dirs.get(channel.id) === undefined && channel.name === name);
    if (!unmanaged) return undefined;
    this.dirs.set(unmanaged.id, dir);
    console.log(`adopted #${unmanaged.name} (${dir})`);
    return unmanaged;
  }

  private async create(dir: string): Promise<TextChannel> {
    const channel = await this.guild.channels.create({
      name: Category.slug(dir),
      type: ChannelType.GuildText,
      parent: this.category?.id,
      reason: `directory found: ${dir}`,
    });
    this.dirs.set(channel.id, dir);
    console.log(`created #${channel.name} (${dir})`);
    return channel;
  }

  // One tidy for all the changes in progress, once they settle
  tidy() {
    if (this.tidying) return;
    this.tidying = true;
    this.settled()
      .then(() =>
        this.run(async () => {
          this.tidying = false;
          const kept = new Set([...this.claimed.values()].map((c) => c.id));
          for (const channel of this.channels()) {
            const dir = this.dirs.get(channel.id);
            if (dir === undefined || kept.has(channel.id)) continue;
            await channel.delete(`directory gone: ${dir}`);
            this.dirs.delete(channel.id);
            console.log(`deleted #${channel.name} (${dir})`);
          }
          await this.order();
        }),
      )
      .catch((e) => console.error(`failed to tidy ${this.name}:`, e));
  }

  // Managed channels take the slots managed channels already occupy, in rank
  // order; unmanaged channels keep their place
  private async order(): Promise<void> {
    const byRank = (a: [string, { rank: readonly number[] }], b: [string, { rank: readonly number[] }]) => {
      for (let i = 0; i < Math.max(a[1].rank.length, b[1].rank.length); i++) {
        const d = (a[1].rank[i] ?? 0) - (b[1].rank[i] ?? 0);
        if (d) return d;
      }
      return a[0].localeCompare(b[0]);
    };
    const wanted = [...this.claimed].sort(byRank).map(([, c]) => c.id);
    const current = this.channels();
    const queue = wanted.flatMap((id) => current.find((channel) => channel.id === id) ?? []);
    const target = current.map((channel) => (this.dirs.get(channel.id) === undefined ? channel : queue.shift()!));
    if (target.every((channel, i) => channel === current[i])) return;

    await this.guild.channels.setPositions(target.map((channel, position) => ({ channel, position })));
    console.log(`ordered ${this.name}: ${target.map((c) => `#${c.name}`).join(' ')}`);
  }
}
