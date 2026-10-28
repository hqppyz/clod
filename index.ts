import { stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Config } from './src/config';
import { Dirs } from './src/dirs';
import { Clod } from './src/clod';

// The bot runs in a child process, so /restart bot can exit it and get a new
// one running the latest code
if (!Bun.env.BOT_WORKER) {
  let proc: Bun.Subprocess | undefined;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => proc?.kill(signal));
  for (;;) {
    proc = Bun.spawn([process.execPath, ...process.argv.slice(1)], {
      env: { ...Bun.env, BOT_WORKER: '1' },
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    const code = await proc.exited;
    if (code !== Clod.RESTART_CODE) process.exit(code);
    console.log('restarting the bot');
  }
}

let config: Config;
let dirs: string[][];
try {
  let values: { data?: string };
  try {
    ({ values } = parseArgs({ args: Bun.argv.slice(2), options: { data: { type: 'string' } } }));
  } catch (e) {
    throw new Config.Error((e as Error).message);
  }
  if (!values.data) throw new Config.Error('--data <dir> is required');
  if (!(await stat(values.data).catch(() => null))?.isDirectory()) {
    throw new Config.Error(`--data: ${values.data} is not a directory`);
  }
  config = await Config.load(values.data);
  dirs = await Promise.all(config.paths.map(Dirs.resolve));
} catch (e) {
  if (!(e instanceof Config.Error)) throw e;
  console.error(`config error: ${e.message}`);
  process.exit(1);
}

config.paths.forEach((entry, i) => {
  console.log(`${entry.path} (${entry.mode})`);
  for (const dir of dirs[i]!) console.log(`  ${dir}`);
});

let clod: Clod;
try {
  clod = await Clod.create(config);
} catch (e) {
  if (!(e instanceof Config.Error)) throw e;
  console.error(`config error: ${e.message}`);
  process.exit(1);
}
// Disposing saves state and closes the connectors. The signal can come twice,
// from the parent and from systemd or the terminal, so later ones are ignored
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}, stopping`);
    await clod[Symbol.asyncDispose]().catch((e) => console.error('failed to stop cleanly:', e));
    process.exit(0);
  });
}
await using _ = clod;
await clod.run();
