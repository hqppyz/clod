import {
  ApplicationCommandOptionType,
  type ApplicationCommandAutocompleteStringOptionData,
  type ApplicationCommandStringOptionData,
  type ChatInputApplicationCommandData,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Instance } from '../../claude';
import { cut } from './text';

// Claude's commands as Discord chat input commands
export namespace Commands {
  // Discord's limits for chat input commands
  const MAX_COMMANDS = 100;
  const MAX_NAME = 32;
  const MAX_DESCRIPTION = 100;
  const MAX_CHOICES = 25;
  const MAX_OPTIONS = 25;

  // The option for commands whose hint doesn't name their arguments
  const ARGS = 'args';

  export interface Suggestion {
    readonly name: string;
    readonly value: string;
  }

  // By option name
  export type Suggestions = Readonly<Record<string, readonly Suggestion[]>>;

  export interface Arg {
    readonly name: string;
    readonly description: string;
    readonly required: boolean;
    readonly choices?: string[];
  }

  export interface Registered {
    readonly data: ChatInputApplicationCommandData[];
    // Discord command name to the Claude command it runs and its option names in order
    readonly names: Map<string, { readonly name: string; readonly args: readonly string[] }>;
  }

  export function suggestions(listed: { readonly models: readonly Instance.Model[] }): Suggestions {
    return {
      model: listed.models.map((m) => ({ name: cut(`${m.displayName} (${m.value})`, MAX_DESCRIPTION), value: m.value })),
    };
  }

  export const suggest = (options: readonly Suggestion[], typed: string): Suggestion[] =>
    options.filter((o) => `${o.name} ${o.value}`.toLowerCase().includes(typed.toLowerCase())).slice(0, MAX_CHOICES);

  // Lowercase letters, digits, - and _ only
  const name = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^\p{Ll}\p{Lo}\p{N}_-]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_NAME);

  // One argument per placeholder: "<x>" is required, "[x]" optional. A
  // placeholder is named, like "[name]" or "[issue description]", or a set of
  // choices, like "<low|high>". Anything else, like "[auto|<tokens>]" or a bare
  // "consent | revoke", is undefined: the hint doesn't spell out the arguments.
  export function hint(text: string): Arg[] | undefined {
    // The option for a placeholder that's only a set of choices, like "[on|off]"
    const VALUE = 'value';
    const args: Arg[] = [];
    const rest = text.trim().replace(/\s*(<([^<>[\]]*)>|\[([^<>[\]]*)\])\s*/gy, (group, _, required, optional) => {
      const needed = required !== undefined;
      const inner = ((needed ? required : optional) as string).trim();
      const choices = inner.split('|').map((c) => c.trim());
      if (choices.length > 1) {
        if (choices.length > MAX_CHOICES || !choices.every((c) => /^[\w.-]+$/.test(c))) return group;
        args.push({ name: VALUE, description: group.trim(), required: needed, choices });
      } else if (/^--[\w-]+$/.test(inner)) {
        // A flag is a single choice, so it can't be mistyped
        args.push({ name: name(inner), description: group.trim(), required: false, choices: [inner] });
      } else {
        // "project hint, e.g. ..." is named by what comes before the comma;
        // "<optional ...>" is optional despite the brackets
        const label = inner.replace(/^optional\s+/i, '').split(',')[0]!;
        args.push({ name: name(label), description: group.trim(), required: needed && !/^optional\s/i.test(inner) });
      }
      return '';
    });
    if (rest || args.length === 0 || args.length > MAX_OPTIONS) return undefined;
    const names = args.map((a) => a.name);
    if (names.some((n, i) => !n || names.indexOf(n) !== i)) return undefined;
    // Discord lists required options first, which would reorder the arguments
    if (args.some((a, i) => a.required && i > 0 && !args[i - 1]!.required)) return undefined;
    return args;
  }

  export function build(commands: readonly Instance.Command[], suggestions: Suggestions = {}): Registered {
    const data: ChatInputApplicationCommandData[] = [];
    const names: Registered['names'] = new Map();
    for (const command of commands) {
      const named = name(command.name);
      if (!named || names.has(named)) continue;
      if (data.length === MAX_COMMANDS) {
        console.error(`discord allows ${MAX_COMMANDS} commands, skipping /${command.name} and later ones`);
        break;
      }
      // Builtins without a hint take no arguments; skills and custom commands always may
      const given = command.argumentHint.trim();
      const args = given
        ? (hint(given) ?? [{ name: ARGS, description: given, required: given.startsWith('<') }])
        : command.builtin
          ? []
          : [{ name: ARGS, description: 'Arguments', required: false }];
      names.set(named, { name: command.name, args: args.map((a) => a.name) });
      data.push({
        name: named,
        description: cut(command.description.trim() || `/${command.name}`, MAX_DESCRIPTION),
        options: args.map((arg: Arg): ApplicationCommandStringOptionData | ApplicationCommandAutocompleteStringOptionData => {
          const base = { type: ApplicationCommandOptionType.String as const, name: arg.name, description: cut(arg.description, MAX_DESCRIPTION), required: arg.required };
          if (arg.choices) return { ...base, choices: arg.choices.map((c) => ({ name: c, value: c })) };
          return arg.name in suggestions ? { ...base, autocomplete: true } : base;
        }),
      });
    }
    return { data, names };
  }

  // Its arguments in hint order
  export function prompt(command: { name: string; args: readonly string[] }, interaction: ChatInputCommandInteraction): string {
    const values = command.args.map((arg) => interaction.options.getString(arg)?.trim()).filter(Boolean);
    return [`/${command.name}`, ...values].join(' ');
  }
}
