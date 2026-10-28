// The bot's own commands. Clod runs them instead of Claude, whichever
// connector or client sends them, once the sender's side allows them.
export type Command = { readonly name: 'restart'; readonly what: 'instance' | 'bot' } | { readonly name: 'stop' };

export namespace Command {
  // The prompt as a command, if it is one: /restart [instance|bot] or /stop
  export function parse(text: string): Command | undefined {
    const [name, arg, ...rest] = text.trim().split(/\s+/);
    if (rest.length > 0) return undefined;
    if (name === '/restart' && (arg === undefined || arg === 'instance' || arg === 'bot')) return { name: 'restart', what: arg ?? 'instance' };
    if (name === '/stop' && arg === undefined) return { name: 'stop' };
    return undefined;
  }
}
