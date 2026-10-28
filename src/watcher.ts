import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Config } from './config';
import { Dirs } from './dirs';

export namespace Watcher {
  export type Event =
    | { readonly type: 'added' | 'removed'; readonly entry: Config.Path; readonly dir: string }
    | { readonly type: 'ready' };

  // Directories whose listing can change an entry's matches, each with the only
  // child name to react to (undefined: any). The entry's parent catches the
  // entry path itself being created or deleted. In auto mode, also the entry
  // path and the static prefix of each include pattern ("a/b/*" -> "a/b").
  // Changes below a pattern's first wildcard level ("a/*/c") are not seen.
  function targets(entry: Config.Path): Map<string, string | undefined> {
    const GLOB = /[*?[\]{}!]/;
    const found = new Map<string, string | undefined>([[dirname(entry.path), basename(entry.path)]]);
    if (entry.mode === 'manual') return found;

    found.set(entry.path, undefined);
    for (const pattern of entry.include) {
      const prefix: string[] = [];
      for (const segment of pattern.split('/').slice(0, -1)) {
        if (GLOB.test(segment)) break;
        prefix.push(segment);
      }
      found.set(join(entry.path, ...prefix), undefined);
    }
    return found;
  }

  // "added" for every match at startup, then "ready", then changes as they come.
  // Breaking out of the loop stops watching.
  export async function* watch(entries: readonly Config.Path[]): AsyncGenerator<Event> {
    const DEBOUNCE_MS = 200;
    const queue: Event[] = [];
    let wake: (() => void) | undefined;
    const push = (event: Event) => {
      queue.push(event);
      wake?.();
      wake = undefined;
    };

    const closers: (() => void)[] = [];

    for (const entry of entries) {
      const watchers = new Map<string, fs.FSWatcher>();
      let known = new Set<string>();
      let timer: Timer | undefined;
      let pending = Promise.resolve();

      // A deleted target's watcher is dropped, so it's watched again once recreated
      const sync = () => {
        for (const [dir, watcher] of watchers) {
          if (!fs.existsSync(dir)) {
            watcher.close();
            watchers.delete(dir);
          }
        }
        for (const [dir, only] of targets(entry)) {
          if (watchers.has(dir) || !fs.existsSync(dir)) continue;
          const watcher = fs.watch(dir, (_, filename) => {
            if (only === undefined || filename === only) change();
          });
          watcher.on('error', () => {
            watcher.close();
            watchers.delete(dir);
          });
          watchers.set(dir, watcher);
        }
      };

      const rescan = async () => {
        let now: Set<string>;
        try {
          now = new Set(await Dirs.resolve(entry));
        } catch (e) {
          // Entry path deleted while running: nothing matches until it comes back
          if (!(e instanceof Config.Error)) throw e;
          now = new Set();
        }
        for (const dir of now) if (!known.has(dir)) push({ type: 'added', entry, dir });
        for (const dir of known) if (!now.has(dir)) push({ type: 'removed', entry, dir });
        known = now;
        sync();
      };

      // Serialized, so overlapping rescans can't interleave
      function change() {
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
}
