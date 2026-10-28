import { expect, test } from 'bun:test';
import { Command } from './command';

test('parses the commands', () => {
  expect(Command.parse('/restart')).toEqual({ name: 'restart', what: 'instance' });
  expect(Command.parse(' /restart  bot ')).toEqual({ name: 'restart', what: 'bot' });
  expect(Command.parse('/restart instance')).toEqual({ name: 'restart', what: 'instance' });
  expect(Command.parse('/stop')).toEqual({ name: 'stop' });
});

test('leaves everything else to Claude', () => {
  expect(Command.parse('/restart now')).toBeUndefined();
  expect(Command.parse('/stop it')).toBeUndefined();
  expect(Command.parse('/clear')).toBeUndefined();
  expect(Command.parse('please /restart')).toBeUndefined();
});
