import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Clod } from './clod';


export class ConfigError extends Error {}

export function fail(where: string, msg: string): never {
  throw new ConfigError(`${where}: ${msg}`);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function checkKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(where ? `${where}.${key}` : key, `unknown key${obj.mode ? ` in ${obj.mode} mode` : ''}`);
  }
}

export function str(v: unknown, where: string): string {
  if (v === undefined || v === null) fail(where, 'required');
  if (typeof v !== 'string' || v === '') fail(where, 'expected a non-empty string');
  return v;
}

// Optional, fallback when missing
export function bool(v: unknown, where: string, fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') fail(where, 'expected true or false');
  return v;
}



function patterns(v: unknown, where: string): readonly string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return [str(v, where)];
  return v.map((p, i) => str(p, `${where}[${i}]`));
}

// Optional list of strings
function args(v: unknown, where: string): readonly string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(where, 'expected a list');
  return v.map((arg, i) => str(arg, `${where}[${i}]`));
}

// Optional mapping of strings
function env(v: unknown, where: string): Readonly<Record<string, string>> {
  if (v === undefined || v === null) return {};
  if (!isRecord(v)) fail(where, 'expected a mapping');
  // Empty values are allowed, as a path's way to clear one from claude.env
  return Object.fromEntries(
    Object.entries(v).map(([key, value]) => {
      if (typeof value !== 'string') fail(`${where}.${key}`, 'expected a string');
      return [key, value];
    }),
  );
}


function parsePath(entry: unknown, where: string, connectorIds: readonly string[]): Clod.Path {
  if (!isRecord(entry) || Object.keys(entry).length !== 1) {
    fail(where, 'expected a single `<path>: { ... }` mapping');
  }
  const [path, opts] = Object.entries(entry)[0]!;
  where = `${where} (${path})`;
  if (!isAbsolute(path)) fail(where, 'path must be absolute');
  if (!isRecord(opts)) fail(where, 'expected a mapping');
  const connectors = opts.connectors ?? {};
  if (!isRecord(connectors)) fail(`${where}.connectors`, 'expected a mapping');
  for (const id of Object.keys(connectors)) {
    if (!connectorIds.includes(id)) fail(`${where}.connectors.${id}`, 'no such connector');
  }
  const common = { path, args: args(opts.args, `${where}.args`), env: env(opts.env, `${where}.env`), connectors };

  switch (opts.mode) {
    case 'auto':
      checkKeys(opts, ['mode', 'include', 'exclude', 'args', 'env', 'connectors'], where);
      return { ...common, mode: 'auto', include: patterns(opts.include, `${where}.include`), exclude: patterns(opts.exclude, `${where}.exclude`) };
    case 'manual':
      checkKeys(opts, ['mode', 'args', 'env', 'connectors'], where);
      return { ...common, mode: 'manual' };
    default:
      fail(`${where}.mode`, 'expected "auto" or "manual"');
  }
}

function parseConnector(raw: unknown, where: string): Clod.ConnectorConfig {
  if (!isRecord(raw)) fail(where, 'expected a mapping');
  const { type, enabled, ...rest } = raw;
  return { type: str(type, `${where}.type`), enabled: bool(enabled, `${where}.enabled`, false), raw: rest };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export async function loadConfig(dataDir: string): Promise<Clod.Config> {
  dataDir = resolve(dataDir);
  const configPath = join(dataDir, 'config.yaml');
  const file = Bun.file(configPath);
  const raw: unknown = (await file.exists()) ? (Bun.YAML.parse(await file.text()) ?? {}) : {};
  if (!isRecord(raw)) fail(configPath, 'expected a mapping at top level');
  checkKeys(raw, ['paths', 'claude', 'connectors'], configPath);

  const claude = raw.claude ?? {};
  if (!isRecord(claude)) fail('claude', 'expected a mapping');
  checkKeys(claude, ['args', 'env'], 'claude');

  const connectors = raw.connectors ?? {};
  if (!isRecord(connectors)) fail('connectors', 'expected a mapping');

  const { paths } = raw;
  if (!Array.isArray(paths) || paths.length === 0) fail('paths', 'expected a non-empty list');

  return deepFreeze({
    dataDir,
    paths: paths.map((p, i) => parsePath(p, `paths[${i}]`, Object.keys(connectors))),
    connectors: Object.fromEntries(Object.entries(connectors).map(([id, c]) => [id, parseConnector(c, `connectors.${id}`)])),
    claude: {
      args: args(claude.args, 'claude.args'),
      env: env(claude.env, 'claude.env'),
    },
  });
}

// The deepest entry holding dir
export function entryFor(config: Clod.Config, dir: string): Clod.Path | undefined {
  const holds = (entry: Clod.Path) => !relative(entry.path, dir).startsWith('..');
  return config.paths.filter(holds).sort((a, b) => b.path.length - a.path.length)[0];
}
