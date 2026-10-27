import { expect, test } from 'bun:test';
import { ApplicationCommandOptionType } from 'discord.js';
import { parseHint, toDiscord } from './commands';

test('placeholders become named arguments', () => {
  expect(parseHint('[name]')).toEqual([{ name: 'name', description: '[name]', required: false }]);
  expect(parseHint('<instruction>')).toEqual([{ name: 'instruction', description: '<instruction>', required: true }]);
  expect(parseHint('[interval] [prompt]')!.map((a) => a.name)).toEqual(['interval', 'prompt']);
  expect(parseHint('[issue description]')![0]!.name).toBe('issue-description');
  expect(parseHint('[<project hint, e.g. "Acme DS">]')).toBeUndefined();
  expect(parseHint('<project hint, e.g. Acme>')![0]!.name).toBe('project-hint');
  expect(parseHint('<optional custom instructions>')).toEqual([
    { name: 'custom-instructions', description: '<optional custom instructions>', required: false },
  ]);
  expect(parseHint('[--force]')).toEqual([{ name: 'force', description: '[--force]', required: false, choices: ['--force'] }]);
});

test('bracketed alternations become choices', () => {
  expect(parseHint('[on|off]')).toEqual([{ name: 'value', description: '[on|off]', required: false, choices: ['on', 'off'] }]);
  expect(parseHint('<low|medium|high>')![0]).toMatchObject({ required: true, choices: ['low', 'medium', 'high'] });
});

test("hints that don't spell out their arguments are undefined", () => {
  expect(parseHint('[auto|<tokens>]')).toBeUndefined();
  expect(parseHint('consent | revoke')).toBeUndefined();
  expect(parseHint('key=value')).toBeUndefined();
  expect(parseHint('[a|b] [c|d]')).toBeUndefined();
  expect(parseHint('[a] <b>')).toBeUndefined();
});

test('builtins without a hint take no arguments, skills always may', () => {
  const { data } = toDiscord([
    { name: 'context', description: 'Show context', argumentHint: '', builtin: true },
    { name: 'pdf', description: 'PDF things', argumentHint: '' },
    { name: 'config', description: 'Config', argumentHint: 'key=value', builtin: true },
  ]);
  expect(data[0]!.options).toEqual([]);
  expect(data[1]!.options).toMatchObject([{ type: ApplicationCommandOptionType.String, name: 'args', required: false }]);
  expect(data[2]!.options).toMatchObject([{ name: 'args', description: 'key=value' }]);
});

test("names and descriptions fit discord's limits", () => {
  const { data, names } = toDiscord([
    { name: 'Plugin:Some Skill', description: 'x'.repeat(300), argumentHint: '' },
    { name: 'plugin:some-skill', description: 'duplicate', argumentHint: '' },
  ]);
  expect(data).toHaveLength(1);
  expect(data[0]!.name).toBe('plugin-some-skill');
  expect(data[0]!.description).toHaveLength(100);
  expect(names.get('plugin-some-skill')).toEqual({ name: 'Plugin:Some Skill', args: ['args'] });
});

test("the bot's own commands come first and win over Claude's", () => {
  const { data, names } = toDiscord(
    [
      { name: 'clean', description: "Claude's clean", argumentHint: '' },
      { name: 'clear', description: 'Clear', argumentHint: '', builtin: true },
    ],
    [{ name: 'clean', description: "The bot's clean" }],
  );
  expect(data.map((c) => c.description)).toEqual(["The bot's clean", 'Clear']);
  expect([...names.keys()]).toEqual(['clear']);
});
