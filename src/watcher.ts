import { existsSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Clod } from './clod';
import { ConfigError } from './config';
import { resolveDirs } from './dirs';

export type DirEvent =
  | { readonly type: 'added' | 'removed'; readonly entry: Clod.Path; readonly dir: string }
  | { readonly type: 'ready' };

const DEBOUNCE_MS = 200;
const GLOB_CHARS = /[*?[\]{}!]/;

// Directories whose listing can change an entry's matches, each with the only
// child name to react to (undefined: any). The entry's parent catches the
// entry path itself being created or deleted. In auto mode, also the entry
// path and the static prefix of each include pattern ("a/b/*" -> "a/b").
// Changes below a pattern's first wildcard level ("a/*/c") are not seen.
function watchTargets(entry: Clod.Path): Map<string, string | undefined> {
  const targets = new Map<string, string | undefined>([[dirname(entry.path), basename(entry.path)]]);
  if (entry.mode === 'manual') return targets;

  targets.set(entry.path, undefined);
  for (const pattern of entry.include) {
    const prefix: string[] = [];
    for (const segment of pattern.split('/').slice(0, -1)) {
      if (GLOB_CHARS.test(segment)) break;
      prefix.push(segment);
    }
    targets.set(join(entry.path, ...prefix), undefined);
  }
  return targets;
}

async function safeResolve(entry: Clod.Path): Promise<Set<string>> {
  try {
    return new Set(await resolveDirs(entry));
  } catch (e) {
    // Entry path deleted while running: nothing matches until it comes back
    if (e instanceof ConfigError) return new Set();
    throw e;
  }
}

// Yields an "added" event for every matching directory at startup, then
// "ready", then "added"/"removed" as the filesystem changes. Stops watching when the
// consumer breaks out of the loop.
export async function* watchDirs(entries: readonly Clod.Path[]): AsyncGenerator<DirEvent> {
  const queue: DirEvent[] = [];
  let wake: (() => void) | undefined;
  const push = (event: DirEvent) => {
    queue.push(event);
    wake?.();
    wake = undefined;
  };

  const closers: (() => void)[] = [];

  for (const entry of entries) {
    const watchers = new Map<string, FSWatcher>();
    let known = new Set<string>();
    let timer: Timer | undefined;
    let pending = Promise.resolve();

    // Watch targets that exist now, drop watchers on deleted ones so they are
    // re-watched when recreated.
    const sync = () => {
      for (const [dir, watcher] of watchers) {
        if (!existsSync(dir)) {
          watcher.close();
          watchers.delete(dir);
        }
      }
      for (const [dir, only] of watchTargets(entry)) {
        if (watchers.has(dir) || !existsSync(dir)) continue;
        const watcher = watch(dir, (_, filename) => {
          if (only === undefined || filename === only) onChange();
        });
        watcher.on('error', () => {
          watcher.close();
          watchers.delete(dir);
        });
        watchers.set(dir, watcher);
      }
    };

    const rescan = async () => {
      const now = await safeResolve(entry);
      for (const dir of now) if (!known.has(dir)) push({ type: 'added', entry, dir });
      for (const dir of known) if (!now.has(dir)) push({ type: 'removed', entry, dir });
      known = now;
      sync();
    };

    // Debounced, and serialized so overlapping rescans can't interleave
    function onChange() {
      clearTimeout(timer);
      timer = setTimeout(() => (pending = pending.then(rescan)), DEBOUNCE_MS);
    }

    closers.push(() => {
      clearTimeout(timer);
      for (const watcher of watchers.values()) watcher.close();
    });

    pending = pending.then(rescan);
    await pending;
  }

  push({ type: 'ready' });

  try {
    while (true) {
      while (queue.length > 0) yield queue.shift()!;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  } finally {
    for (const close of closers) close();
  }
}
