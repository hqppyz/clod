// Clod's own commands. Clod runs them instead of Claude, whichever
// connector or client sends them, once the sender's side allows them.
// /restart restarts the session's claude process, /reboot all of clod, and
// /stop stops clod.
export type Command = { readonly name: 'restart' | 'reboot' | 'stop' };

const NAMES = new Set<string>(['restart', 'reboot', 'stop']);

export namespace Command {
  // The prompt as a command, if it is one: /restart, /reboot or /stop
  export function parse(text: string): Command | undefined {
    const name = text.trim();
    return name.startsWith('/') && NAMES.has(name.slice(1)) ? { name: name.slice(1) as Command['name'] } : undefined;
  }
}

// What the Claude home gets so claude knows the commands: a file each, for
// the app's slash menu and Discord's commands, and a hook that blocks them
// as prompts, so no model turn starts. Clod reads the blocked prompt from the
// event claude emits instead.
export namespace Command {
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

  // The prompt a hook blocked, from the event claude emits for it
  export const blocked = (content: string): string | undefined => /Original prompt: ([\s\S]*)$/.exec(content)?.[1];
}
