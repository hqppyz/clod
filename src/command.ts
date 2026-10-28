import { join } from 'node:path';

// Clod's own commands. Clod runs them instead of Claude, whichever
// connector or client sends them, once the sender's side allows them.
export type Command = { readonly name: 'restart' | 'reboot' | 'stop' };

// The Claude home gets a file per command, for the app's slash menu and
// Discord's commands, and a hook that blocks them as prompts, so no model turn
// starts. Clod reads the blocked prompt from the event claude emits instead.
export namespace Command {
  const NAMES = new Set<string>(['restart', 'reboot', 'stop']);

  export function parse(text: string): Command | undefined {
    const name = text.trim();
    return name.startsWith('/') && NAMES.has(name.slice(1)) ? { name: name.slice(1) as Command['name'] } : undefined;
  }

  export const FILES: Readonly<Record<string, string>> = {
    'restart.md': "---\ndescription: Restart this session's claude process; the conversation resumes\n---\nRun by clod.\n",
    'reboot.md': '---\ndescription: Restart all of clod\n---\nRun by clod.\n',
    'stop.md': '---\ndescription: Stop all of clod\n---\nRun by clod.\n',
  };

  // Matches the prompts parse takes, as the hook's stdin JSON has them
  const PROMPT = String.raw`"prompt": *" */(restart|reboot|stop) *"`;

  export const SETTINGS = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `grep -qE '${PROMPT}' && echo '{"decision":"block","reason":"clod"}'; exit 0` }] }],
    },
  };

  // Passed with --settings
  export const settings = (home: string) => join(home, 'clod-settings.json');

  export async function install(home: string) {
    for (const [name, text] of Object.entries(FILES)) await Bun.write(join(home, 'commands', name), text);
    await Bun.write(settings(home), `${JSON.stringify(SETTINGS, null, 2)}\n`);
  }

  export const blocked = (content: string): string | undefined => /Original prompt: ([\s\S]*)$/.exec(content)?.[1];
}
