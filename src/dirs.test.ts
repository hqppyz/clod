import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clod } from './clod';
import { includeIndex, resolveDirs } from './dirs';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dirs-test-'));
  for (const dir of ['a/x', 'a/y', 'b', 'c', '.hidden']) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'file'), '');
});

afterAll(() => rm(root, { recursive: true }));

const auto = (include: string[] = [], exclude: string[] = []): Clod.Path =>
  ({ path: root, args: [], env: {}, connectors: {}, mode: 'auto', include, exclude });
const manual = (path = root): Clod.Path => ({ path, args: [], env: {}, connectors: {}, mode: 'manual' });
const rel = (dirs: string[]) => dirs.map((d) => (d === root ? '.' : d.slice(root.length + 1)));

test('manual: the path itself', async () => {
  expect(rel(await resolveDirs(manual()))).toEqual(['.']);
});

test('auto: no include, nothing', async () => {
  expect(await resolveDirs(auto())).toEqual([]);
});

test('* is direct child dirs only: no self, files or hidden dirs', async () => {
  expect(rel(await resolveDirs(auto(['*'])))).toEqual(['a', 'b', 'c']);
});

test('. includes self', async () => {
  expect(rel(await resolveDirs(auto(['.'])))).toEqual(['.']);
  expect(rel(await resolveDirs(auto(['.', '*'])))).toEqual(['.', 'a', 'b', 'c']);
});

test('globs reach deeper', async () => {
  expect(rel(await resolveDirs(auto(['a/*'])))).toEqual(['a/x', 'a/y']);
});

test('exclude . removes self', async () => {
  expect(rel(await resolveDirs(auto(['.', '*'], ['.'])))).toEqual(['a', 'b', 'c']);
});

test('exclude * keeps self', async () => {
  expect(rel(await resolveDirs(auto(['.', '*'], ['*'])))).toEqual(['.']);
});

test('exclude wins over include', async () => {
  expect(rel(await resolveDirs(auto(['a/*'], ['a/x'])))).toEqual(['a/y']);
});

test('missing path throws', async () => {
  expect(resolveDirs(manual(join(root, 'nope')))).rejects.toThrow('not a directory');
});

test('includeIndex: first matching pattern, unmatched last', () => {
  const entry = auto(['b', '.', 'a/*', '*']) as Clod.AutoPath;
  expect(includeIndex(entry, join(root, 'b'))).toBe(0);
  expect(includeIndex(entry, root)).toBe(1);
  expect(includeIndex(entry, join(root, 'a', 'x'))).toBe(2);
  expect(includeIndex(entry, join(root, 'c'))).toBe(3);
  expect(includeIndex(entry, join(root, 'a', 'x', 'deep'))).toBe(4);
});
