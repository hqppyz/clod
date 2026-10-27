import { stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Clod } from './clod';
import { ConfigError } from './config';

// Globs are relative to the entry's path; "." is the path itself.
const SELF = '.';

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function expand(root: string, pattern: string): Promise<string[]> {
  if (pattern === SELF) return [SELF];
  const found: string[] = [];
  for await (const rel of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: false })) {
    if (await isDir(join(root, rel))) found.push(rel);
  }
  return found;
}

function excluded(rel: string, patterns: readonly string[]): boolean {
  // Bun.Glob("*").match(".") is true, so only a literal "." excludes self
  if (rel === SELF) return patterns.includes(SELF);
  return patterns.some((p) => new Bun.Glob(p).match(rel));
}

// manual: the path itself. auto: include - exclude, where only a literal "."
// matches the path itself and "*" matches direct children. Returns sorted
// absolute paths.
export async function resolveDirs(entry: Clod.Path): Promise<string[]> {
  if (!(await isDir(entry.path))) throw new ConfigError(`${entry.path}: not a directory`);
  if (entry.mode === 'manual') return [entry.path];

  const rels = new Set<string>();
  for (const pattern of entry.include) {
    for (const rel of await expand(entry.path, pattern)) rels.add(rel);
  }

  return [...rels]
    .filter((rel) => !excluded(rel, entry.exclude))
    .map((rel) => (rel === SELF ? entry.path : join(entry.path, rel)))
    .sort();
}

// Index of the first include pattern matching dir, used to order channels
export function includeIndex(entry: Clod.AutoPath, dir: string): number {
  const rel = relative(entry.path, dir) || SELF;
  const index = entry.include.findIndex((p) => (rel === SELF ? p === SELF : new Bun.Glob(p).match(rel)));
  return index === -1 ? entry.include.length : index;
}
