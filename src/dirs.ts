import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Config } from './config';

export namespace Dirs {
  // Globs are relative to the entry's path; "." is the path itself
  const SELF = '.';

  async function exists(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  // Sorted and absolute
  export async function resolve(entry: Config.Path): Promise<string[]> {
    if (!(await exists(entry.path))) throw new Config.Error(`${entry.path}: not a directory`);
    if (entry.mode === 'manual') return [entry.path];

    const rels = new Set<string>();
    for (const pattern of entry.include) {
      if (pattern === SELF) {
        rels.add(SELF);
        continue;
      }
      for await (const rel of new Bun.Glob(pattern).scan({ cwd: entry.path, onlyFiles: false })) {
        if (await exists(join(entry.path, rel))) rels.add(rel);
      }
    }

    // Bun.Glob("*").match(".") is true, so only a literal "." excludes self
    const excluded = (rel: string) => (rel === SELF ? entry.exclude.includes(SELF) : entry.exclude.some((p) => new Bun.Glob(p).match(rel)));
    return [...rels]
      .filter((rel) => !excluded(rel))
      .map((rel) => (rel === SELF ? entry.path : join(entry.path, rel)))
      .sort();
  }
}
