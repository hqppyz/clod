import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config';
import { Watcher } from './watcher';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'watcher-test-'));
});

afterEach(() => rm(root, { recursive: true, force: true }));

const auto = (include: string[], exclude: string[] = []): Config.Path =>
  ({ path: root, args: [], env: {}, connectors: {}, mode: 'auto', include, exclude });

async function next(events: AsyncGenerator<Watcher.Event>, timeoutMs = 2000): Promise<string> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), timeoutMs));
  const { value } = await Promise.race([events.next(), timeout]);
  if (value!.type === 'ready') return 'ready';
  return `${value!.type} ${value!.dir.slice(root.length + 1) || '.'}`;
}

test('initial dirs, then additions and removals', async () => {
  await mkdir(join(root, 'a'));
  const events = Watcher.watch([auto(['.', '*'])]);

  expect(await next(events)).toBe('added .');
  expect(await next(events)).toBe('added a');
  expect(await next(events)).toBe('ready');

  await mkdir(join(root, 'b'));
  expect(await next(events)).toBe('added b');

  await rm(join(root, 'a'), { recursive: true });
  expect(await next(events)).toBe('removed a');

  await events.return(undefined);
});

test('excluded dirs produce no events', async () => {
  const events = Watcher.watch([auto(['*'], ['skip'])]);
  await mkdir(join(root, 'skip'));
  await mkdir(join(root, 'keep'));
  expect(await next(events)).toBe('added keep');
  expect(await next(events)).toBe('ready');
  await events.return(undefined);
});

test('watches pattern prefixes, including ones created later', async () => {
  const events = Watcher.watch([auto(['a/*'])]);
  expect(await next(events)).toBe('ready'); // initial scan finds nothing

  await mkdir(join(root, 'a'));
  await Bun.sleep(400); // let the rescan start watching "a"
  await mkdir(join(root, 'a', 'x'));
  expect(await next(events)).toBe('added a/x');

  await events.return(undefined);
});

test('manual: the path itself appearing and disappearing', async () => {
  const path = join(root, 'm');
  const events = Watcher.watch([{ path, args: [], env: {}, connectors: {}, mode: 'manual' }]);
  expect(await next(events)).toBe('ready'); // path missing, nothing yet

  await mkdir(join(root, 'other')); // sibling, ignored
  await mkdir(path);
  expect(await next(events)).toBe('added m');

  await rm(path, { recursive: true });
  expect(await next(events)).toBe('removed m');

  await events.return(undefined);
});
