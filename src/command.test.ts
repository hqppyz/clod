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

test('the hook blocks exactly the prompts parse takes', async () => {
  const hook = Command.SETTINGS.hooks.UserPromptSubmit[0]!.hooks[0]!.command;
  const prompts = ['/restart', ' /reboot ', '/stop\n', '\t/stop\r\n', '/stop it', '/clear', 'please /restart', '/', 'stop'];
  for (const prompt of prompts) {
    const stdin = new Response(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt }));
    const output = await new Response(Bun.spawn(['sh', '-c', hook], { stdin }).stdout).text();
    expect([prompt, output.includes('"block"')]).toEqual([prompt, Command.parse(prompt) !== undefined]);
  }
});

test('writes a file per command', () => {
  expect(Object.keys(Command.FILES)).toEqual(['restart.md', 'reboot.md', 'stop.md']);
  expect(Command.FILES['stop.md']).toBe('---\ndescription: Stop all of clod\n---\nRun by clod.\n');
});

test('reads the prompt a hook blocked', () => {
  expect(Command.blocked('UserPromptSubmit operation blocked by hook:\nclod\n\nOriginal prompt: /reboot')).toBe('/reboot');
  expect(Command.blocked('something else')).toBeUndefined();
});
