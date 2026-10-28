import { expect, test } from 'bun:test';
import type { Message } from 'discord.js';
import { Session } from '../../session';
import { Status } from './channels';
import { Presence } from './presence';
import { Log } from './log';

// Events as Claude writes them, read the way the bot reads them
const ev = (event: object): any => Session.parse(JSON.stringify(event));
const describe = (event: object, calls?: Map<string, Session.Tool>) => Log.describe(ev(event), calls);
const cost = (event: object) => Status.cost(ev(event));
const effortSet = (event: object) => Status.effort(ev(event));
const isThinking = (event: object) => Session.thinking(ev(event));
const session = (event: object) => Status.init(event as Session.Init);
const usage = (event: object, now?: number) => Presence.usage(ev(event), now);
const statusFor = (event: object) => Presence.status(ev(event));

test("shows Claude's text as is and tool calls as small text", () => {
  const event = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'on\n**it**' }, { type: 'tool_use', name: 'Read', input: { file_path: 'a_b.ts' } }] },
  };
  expect(describe(event)).toEqual(['on\n**it**', '-# tool Read · a\\_b.ts']);
});

test("shows a Bash call's command in a code block", () => {
  const bash = (command: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command } }] } });
  expect(describe(bash('echo `hi`\nls'))).toEqual([{ id: 'b', text: '-# bash\n```bash\n$ echo `hi`\nls\n```' }]);
  expect(describe(bash('echo ```'))).toEqual([{ id: 'b', text: '-# bash\n```bash\n$ echo `\u200b``\n```' }]);
});

test("adds the end of a Bash call's output to its command", () => {
  const calls = new Map();
  const result = (content: unknown) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content }] } });
  describe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls' } }] } }, calls);
  expect(describe(result('\x1b[32ma\x1b[0m\nb\n'), calls)).toEqual([{ id: 'b', text: '-# bash\n```bash\n$ ls\na\nb\n```' }]);
  expect(describe(result(''), calls)).toEqual([{ id: 'b', text: '-# bash\n```bash\n$ ls\n```' }]);
  const lines = Array.from({ length: 12 }, (_, i) => String(i)).join('\n');
  expect(describe(result(lines), calls)).toEqual([{ id: 'b', text: `-# bash\n\`\`\`bash\n$ ls\n…\n${[2, 3, 4, 5, 6, 7, 8, 9, 10, 11].join('\n')}\n\`\`\`` }]);
});

test('hides questions the bot asks in their own message', () => {
  const ask = (input: object) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input }] } });
  expect(describe(ask({ questions: [] }))).toEqual([]);
  expect(describe(ask({}))).toEqual(['-# tool AskUserQuestion · {}']);
  const calls = new Map();
  expect(describe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: { questions: [] } }] } }, calls)).toEqual([]);
  expect(describe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'q', content: 'answered' }] } }, calls)).toEqual([]);
  expect(describe({ type: 'control_request', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion' } })).toEqual([]);
});

test("leaves a turn's cost to the topic", () => {
  const event = {
    type: 'result',
    subtype: 'success',
    duration_ms: 2908,
    num_turns: 2,
    total_cost_usd: 0.0956,
    usage: { input_tokens: 4, cache_creation_input_tokens: 11081, cache_read_input_tokens: 26917, output_tokens: 78 },
  };
  expect(describe(event)).toEqual([]);
  expect(cost(event)).toBe('26.9k cache read · 11.1k cache write · 4 in · 78 out · $0.096');
  expect(cost({ type: 'result', duration_ms: 251, local_command: 'clear' })).toBeUndefined();
});

test('names events it has no summary for', () => {
  expect(describe({ type: 'system', subtype: 'status' })).toEqual(['-# system/status']);
});

test('tells thinking from other events', () => {
  const assistant = (...types: string[]) => ({ type: 'assistant', message: { content: types.map((type) => ({ type })) } });
  const tokens = { type: 'system', subtype: 'thinking_tokens' };
  expect(isThinking(tokens)).toBe(true);
  expect(describe(tokens)).toEqual([]);
  expect(isThinking(assistant('thinking'))).toBe(true);
  expect(describe(assistant('thinking', 'redacted_thinking'))).toEqual([]);
  expect(isThinking(assistant('thinking', 'text'))).toBe(false);
  expect(isThinking(assistant())).toBe(false);
  expect(isThinking({ type: 'system', subtype: 'status' })).toBe(false);
});

test("names the session's model and mode", () => {
  expect(describe({ type: 'system', subtype: 'init' })).toEqual([]);
  expect(session({ model: 'claude-opus-5-5', permissionMode: 'auto' })).toEqual({ model: 'claude-opus-5-5', mode: 'auto' });
});

test('reads the effort an /effort command set', () => {
  const result = (local_command: string, text: string) => ({ type: 'result', local_command, result: text });
  expect(effortSet(result('effort', 'Set effort level to low (this session only): Quick, straightforward implementation'))).toBe('low');
  expect(effortSet(result('clear', 'Set effort level to low'))).toBeUndefined();
  expect(effortSet(result('effort', 'Usage: /effort <level>'))).toBeUndefined();
});

test("shows what's left of the 5-hour window", () => {
  const now = 1_000_000_000_000;
  const at = (minutes: number) => (now + minutes * 60_000) / 1000;
  const event = {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      unifiedWindows: { five_hour: { utilization: 0.51, resetsAt: at(125) }, seven_day: { utilization: 0.59, resetsAt: at(6840) } },
    },
  };
  expect(statusFor(event)).toBe('idle');
  expect(usage(event, now)).toEqual({ percent: 49, reset: '2h05m' });
  expect(describe(event)).toEqual([]);
  expect(describe({ ...event, rate_limit_info: { ...event.rate_limit_info, status: 'allowed_warning' } })).toEqual([
    '-# rate limit · allowed\\_warning · five\\_hour 51% · seven\\_day 59%',
  ]);
});

test('splits text past the message limit at a newline', () => {
  const parts = Log.chunks(`${'a'.repeat(1500)}\n${'b'.repeat(1500)}`);
  expect(parts).toEqual(['a'.repeat(1500), 'b'.repeat(1500)]);
});

test('edits the last message and sends a new one when it overflows', async () => {
  const calls: string[] = [];
  const live = new Log.Reply({
    send: async (content, i) => (calls.push(`send ${i} ${content.length}`), {} as Message),
    edit: async (_, content, i) => calls.push(`edit ${i} ${content.length}`),
    report: async () => {},
  });
  live.add(ev({ type: 'system', subtype: 'status' }));
  live.add(ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(1990) }] } }));
  await live.finish({ text: 'x'.repeat(1990), failed: false });
  // The rule joins the first message, which is then full, so the text starts a second one
  expect(calls).toEqual(['send 0 16', `edit 0 ${16 + 1 + Log.RULE.length + 1}`, 'send 1 1990']);
});

test("puts a rule where log lines and Claude's text meet", async () => {
  const sent: string[] = [];
  const live = new Log.Reply({
    send: async (content) => (sent.push(content), {} as Message),
    edit: async (_, content) => sent.push(content),
    report: async () => {},
  });
  const text = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const status = { type: 'system', subtype: 'status' };
  for (const event of [text('a'), text('b'), status, status, text('c')]) live.add(ev(event));
  await live.finish({ text: 'c', failed: false });
  expect(sent.at(-1)).toBe(['a', 'b', Log.RULE, '-# system/status', '-# system/status', Log.RULE, '', 'c'].join('\n'));
});

test("edits a Bash call's message to add its output", async () => {
  const sent: string[] = [];
  const live = new Log.Reply({
    send: async (content) => (sent.push(content), {} as Message),
    edit: async (_, content) => sent.push(content),
    report: async () => {},
  });
  live.add(ev({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls' } }] } }));
  await live.settle();
  live.add(ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'a' }] } }));
  await live.finish({ text: '', failed: false });
  expect(sent).toEqual(['-# bash\n```bash\n$ ls\n```', '-# bash\n```bash\n$ ls\na\n```']);
});

test('reports a failed send once in the channel', async () => {
  const reports: string[] = [];
  const live = new Log.Reply({
    send: async () => {
      throw new Error('Missing Permissions');
    },
    edit: async () => {},
    report: async (content) => reports.push(content),
  });
  live.add(ev({ type: 'system', subtype: 'status' }));
  await live.settle();
  live.add(ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] } }));
  await live.finish({ text: 'a', failed: false });
  expect(reports).toEqual(["Failed to send Claude's reply: Missing Permissions"]);
});
