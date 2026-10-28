import { expect, test } from 'bun:test';
import { ApplicationCommandOptionType } from 'discord.js';
import { Commands } from './commands';

test('placeholders become named arguments', () => {
  expect(Commands.hint('[name]')).toEqual([{ name: 'name', description: '[name]', required: false }]);
  expect(Commands.hint('<instruction>')).toEqual([{ name: 'instruction', description: '<instruction>', required: true }]);
  expect(Commands.hint('[interval] [prompt]')!.map((a) => a.name)).toEqual(['interval', 'prompt']);
  expect(Commands.hint('[issue description]')![0]!.name).toBe('issue-description');
  expect(Commands.hint('[<project hint, e.g. "Acme DS">]')).toBeUndefined();
  expect(Commands.hint('<project hint, e.g. Acme>')![0]!.name).toBe('project-hint');
  expect(Commands.hint('<optional custom instructions>')).toEqual([
    { name: 'custom-instructions', description: '<optional custom instructions>', required: false },
  ]);
  expect(Commands.hint('[--force]')).toEqual([{ name: 'force', description: '[--force]', required: false, choices: ['--force'] }]);
});

test('bracketed alternations become choices', () => {
  expect(Commands.hint('[on|off]')).toEqual([{ name: 'value', description: '[on|off]', required: false, choices: ['on', 'off'] }]);
  expect(Commands.hint('<low|medium|high>')![0]).toMatchObject({ required: true, choices: ['low', 'medium', 'high'] });
});

test("hints that don't spell out their arguments are undefined", () => {
  expect(Commands.hint('[auto|<tokens>]')).toBeUndefined();
  expect(Commands.hint('consent | revoke')).toBeUndefined();
  expect(Commands.hint('key=value')).toBeUndefined();
  expect(Commands.hint('[a|b] [c|d]')).toBeUndefined();
  expect(Commands.hint('[a] <b>')).toBeUndefined();
});

test('builtins without a hint take no arguments, skills always may', () => {
  const { data } = Commands.build([
    { name: 'context', description: 'Show context', argumentHint: '', builtin: true },
    { name: 'pdf', description: 'PDF things', argumentHint: '' },
    { name: 'config', description: 'Config', argumentHint: 'key=value', builtin: true },
  ]);
  expect(data[0]!.options).toEqual([]);
  expect(data[1]!.options).toMatchObject([{ type: ApplicationCommandOptionType.String, name: 'args', required: false }]);
  expect(data[2]!.options).toMatchObject([{ name: 'args', description: 'key=value' }]);
});

test("names and descriptions fit discord's limits", () => {
  const { data, names } = Commands.build([
    { name: 'Plugin:Some Skill', description: 'x'.repeat(300), argumentHint: '' },
    { name: 'plugin:some-skill', description: 'duplicate', argumentHint: '' },
  ]);
  expect(data).toHaveLength(1);
  expect(data[0]!.name).toBe('plugin-some-skill');
  expect(data[0]!.description).toHaveLength(100);
  expect(names.get('plugin-some-skill')).toEqual({ name: 'Plugin:Some Skill', args: ['args'] });
});
