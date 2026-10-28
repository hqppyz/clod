import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Config } from '../../config';
import { Path } from '.';

test('include: first matching pattern, unmatched last', () => {
  const root = '/srv';
  const entry: Config.Path = { path: root, args: [], env: {}, connectors: {}, mode: 'auto', include: ['b', '.', 'a/*', '*'], exclude: [] };
  const path = new Path(undefined as never, entry, false);
  expect(path.include(join(root, 'b'))).toBe(0);
  expect(path.include(root)).toBe(1);
  expect(path.include(join(root, 'a', 'x'))).toBe(2);
  expect(path.include(join(root, 'c'))).toBe(3);
  expect(path.include(join(root, 'a', 'x', 'deep'))).toBe(4);
});
