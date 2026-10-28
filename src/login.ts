import { mkdir } from 'node:fs/promises';

// `claude auth login` without a TTY prints the URL and waits for the code on
// stdin; the callback page shows the code, so any machine can do the login.
export class Login {
  // claude gets this long to check a code
  private static readonly SUBMIT_MS = 30_000;

  private submitting: Promise<boolean> | undefined;

  private constructor(
    private readonly home: string,
    private readonly proc: Bun.Subprocess<'pipe', 'pipe', 'ignore'>,
    readonly url: string,
  ) {}

  // Doesn't validate the credentials, but never starts a session
  static async check(home: string): Promise<boolean> {
    await mkdir(home, { recursive: true });
    const proc = Bun.spawn(['claude', 'auth', 'status', '--json'], {
      env: { ...Bun.env, CLAUDE_CONFIG_DIR: home },
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    try {
      return JSON.parse(stdout).loggedIn === true;
    } catch {
      return false;
    }
  }

  static async start(home: string): Promise<Login> {
    await mkdir(home, { recursive: true });
    const proc = Bun.spawn(['claude', 'auth', 'login'], {
      // BROWSER=true makes the browser launch a no-op on the server
      env: { ...Bun.env, CLAUDE_CONFIG_DIR: home, BROWSER: 'true' },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
    });

    // A reader, not for-await: breaking out of that would cancel stdout
    // and the process could die writing to it later
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let output = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
      const url = output.match(/https:\/\/\S+/)?.[0];
      // The prompt follows the URL, so the URL is complete once it shows
      if (url && output.includes('Paste code')) {
        reader.releaseLock();
        return new Login(home, proc, url);
      }
    }
    throw new Error(`claude auth login exited without a URL: ${output.trim()}`);
  }

  // The login process takes one code, so later calls share the first one's result
  submit(code: string): Promise<boolean> {
    this.submitting ??= (async () => {
      this.proc.stdin.write(`${code.trim()}\n`);
      await this.proc.stdin.end();
      const timeout = setTimeout(() => this.proc.kill(), Login.SUBMIT_MS);
      await this.proc.exited;
      clearTimeout(timeout);
      return Login.check(this.home);
    })();
    return this.submitting;
  }

  cancel() {
    this.proc.kill();
  }
}
