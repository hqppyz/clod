import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Instance } from './claude';

export interface Config {
  // Absolute; holds config.yaml
  readonly data: string;
  // Claude Code keeps settings, credentials and transcripts under
  // CLAUDE_CONFIG_DIR, so pointing it into the data dir keeps the bot's
  // sessions out of the user's ~/.claude
  readonly home: string;
  readonly paths: readonly Config.Path[];
  readonly connectors: Readonly<Record<string, Config.Block>>;
  readonly claude: {
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
  };
}

export namespace Config {
  // auto: one session per directory matched by include - exclude.
  // manual: the path itself.
  // args go after claude.args, and env merges over claude.env. connectors holds
  // each connector's block for this path, raw, for the connector to parse.
  export type Path = {
    readonly path: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly connectors: Readonly<Record<string, unknown>>;
  } & (
    | {
        readonly mode: 'auto';
        readonly include: readonly string[];
        readonly exclude: readonly string[];
      }
    | { readonly mode: 'manual' }
  );

  export namespace Path {
    export type Auto = Extract<Path, { mode: 'auto' }>;
  }

  // A connector's block, raw but for its type and whether it's on
  export interface Block {
    readonly type: string;
    readonly enabled: boolean;
    readonly raw: Readonly<Record<string, unknown>>;
  }

  export class Error extends globalThis.Error {}

  export function fail(where: string, msg: string): never {
    throw new Error(`${where}: ${msg}`);
  }

  export function record(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }

  export function keys(obj: Record<string, unknown>, allowed: readonly string[], where: string) {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) fail(where ? `${where}.${key}` : key, `unknown key${obj.mode ? ` in ${obj.mode} mode` : ''}`);
    }
  }

  export function text(v: unknown, where: string): string {
    if (v === undefined || v === null) fail(where, 'required');
    if (typeof v !== 'string' || v === '') fail(where, 'expected a non-empty string');
    return v;
  }

  export function bool(v: unknown, where: string, fallback: boolean): boolean {
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'boolean') fail(where, 'expected true or false');
    return v;
  }

  // A single pattern needs no list
  function patterns(v: unknown, where: string): readonly string[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) return [text(v, where)];
    return v.map((p, i) => text(p, `${where}[${i}]`));
  }

  function list(v: unknown, where: string): readonly string[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) fail(where, 'expected a list');
    return v.map((arg, i) => text(arg, `${where}[${i}]`));
  }

  function env(v: unknown, where: string): Readonly<Record<string, string>> {
    if (v === undefined || v === null) return {};
    if (!record(v)) fail(where, 'expected a mapping');
    // Empty values are allowed, as a path's way to clear one from claude.env
    return Object.fromEntries(
      Object.entries(v).map(([key, value]) => {
        if (typeof value !== 'string') fail(`${where}.${key}`, 'expected a string');
        return [key, value];
      }),
    );
  }

  function freeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
      for (const v of Object.values(value)) freeze(v);
      Object.freeze(value);
    }
    return value;
  }

  export async function load(dir: string): Promise<Config> {
    const data = resolve(dir);
    const path = join(data, 'config.yaml');
    const file = Bun.file(path);
    const raw: unknown = (await file.exists()) ? (Bun.YAML.parse(await file.text()) ?? {}) : {};
    if (!record(raw)) fail(path, 'expected a mapping at top level');
    keys(raw, ['paths', 'claude', 'connectors'], path);

    const claude = raw.claude ?? {};
    if (!record(claude)) fail('claude', 'expected a mapping');
    keys(claude, ['args', 'env'], 'claude');

    const connectors = raw.connectors ?? {};
    if (!record(connectors)) fail('connectors', 'expected a mapping');
    const ids = Object.keys(connectors);

    const { paths } = raw;
    if (!Array.isArray(paths) || paths.length === 0) fail('paths', 'expected a non-empty list');

    return freeze({
      data,
      home: join(data, '.claude'),
      paths: paths.map((entry, i): Path => {
        let where = `paths[${i}]`;
        if (!record(entry) || Object.keys(entry).length !== 1) fail(where, 'expected a single `<path>: { ... }` mapping');
        const [path, opts] = Object.entries(entry)[0]!;
        where = `${where} (${path})`;
        if (!isAbsolute(path)) fail(where, 'path must be absolute');
        if (!record(opts)) fail(where, 'expected a mapping');
        const connectors = opts.connectors ?? {};
        if (!record(connectors)) fail(`${where}.connectors`, 'expected a mapping');
        for (const id of Object.keys(connectors)) {
          if (!ids.includes(id)) fail(`${where}.connectors.${id}`, 'no such connector');
        }
        const common = { path, args: list(opts.args, `${where}.args`), env: env(opts.env, `${where}.env`), connectors };
        switch (opts.mode) {
          case 'auto':
            keys(opts, ['mode', 'include', 'exclude', 'args', 'env', 'connectors'], where);
            return { ...common, mode: 'auto', include: patterns(opts.include, `${where}.include`), exclude: patterns(opts.exclude, `${where}.exclude`) };
          case 'manual':
            keys(opts, ['mode', 'args', 'env', 'connectors'], where);
            return { ...common, mode: 'manual' };
          default:
            fail(`${where}.mode`, 'expected "auto" or "manual"');
        }
      }),
      connectors: Object.fromEntries(
        Object.entries(connectors).map(([id, raw]): [string, Block] => {
          const where = `connectors.${id}`;
          if (!record(raw)) fail(where, 'expected a mapping');
          const { type, enabled, ...rest } = raw;
          return [id, { type: text(type, `${where}.type`), enabled: bool(enabled, `${where}.enabled`, false), raw: rest }];
        }),
      ),
      claude: { args: list(claude.args, 'claude.args'), env: env(claude.env, 'claude.env') },
    });
  }

  // Nested entries override their parents
  export function entry(config: Config, dir: string): Path | undefined {
    const holds = (entry: Path) => !relative(entry.path, dir).startsWith('..');
    return config.paths.filter(holds).sort((a, b) => b.path.length - a.path.length)[0];
  }

  // What an instance in dir starts with, before connectors add theirs
  export function options(config: Config, dir: string): Instance.Options {
    const found = entry(config, dir);
    return { args: [...config.claude.args, ...(found?.args ?? [])], env: { ...config.claude.env, ...found?.env } };
  }
}
