import { expect, test } from 'bun:test';
import { Command } from './command';

test('parses the commands', () => {
  expect(Command.parse('/restart')).toEqual({ name: 'restart' });
  expect(Command.parse(' /reboot ')).toEqual({ name: 'reboot' });
  expect(Command.parse('/stop')).toEqual({ name: 'stop' });
});

test('leaves everything else to Claude', () => {
  expect(Command.parse('/restart now')).toBeUndefined();
  expect(Command.parse('/stop it')).toBeUndefined();
  expect(Command.parse('/clear')).toBeUndefined();
  expect(Command.parse('please /restart')).toBeUndefined();
  expect(Command.parse('/')).toBeUndefined();
});

test('reads the prompt a hook blocked', () => {
  expect(Command.blocked('UserPromptSubmit operation blocked by hook:\nclod\n\nOriginal prompt: /reboot')).toBe('/reboot');
  expect(Command.blocked('something else')).toBeUndefined();
});
