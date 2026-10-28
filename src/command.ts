import { join } from 'node:path';

// Clod's own commands. Clod runs them instead of Claude, whichever
// connector or client sends them, once the sender's side allows them.
export type Command = { readonly name: keyof typeof Command.DESCRIPTIONS };

// The Claude home gets a file per command, for the app's slash menu and
// Discord's commands, and a hook that blocks them as prompts, so no model turn
// starts. Clod reads the blocked prompt from the event claude emits instead.
export namespace Command {
  // The one list of commands; the files, the hook and parse all derive from it
  export const DESCRIPTIONS = {
    restart: "Restart this session's claude process; the conversation resumes",
    reboot: 'Restart all of clod',
    stop: 'Stop all of clod',
  } as const;

  export function parse(text: string): Command | undefined {
    const prompt = text.trim();
    const name = prompt.slice(1);
    return prompt.startsWith('/') && Object.hasOwn(DESCRIPTIONS, name) ? { name: name as Command['name'] } : undefined;
  }

  export const FILES: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(DESCRIPTIONS).map(([name, description]) => [`${name}.md`, `---\ndescription: ${description}\n---\nRun by clod.\n`]),
  );

  // Matches the prompts parse takes, as the hook's stdin JSON has them: the
  // whitespace trim drops arrives as spaces or JSON escapes
  const SPACE = String.raw`( |\\[nrtf])*`;
  const PROMPT = String.raw`"prompt": *"${SPACE}/(${Object.keys(DESCRIPTIONS).join('|')})${SPACE}"`;

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
