import { expect, test } from 'bun:test';
import { parseTopic, withStatus } from './channels';

test('updates each part of the status line, dropping unknown lines', () => {
  const cost = '12.0k cache read · 9.4k cache write · 2 in · 16 out · $0.100';
  expect(withStatus(null, { model: 'm', effort: 'low', mode: 'auto' })).toBe('m · low · auto');
  expect(withStatus(null, { cost })).toBe('');
  let topic = withStatus('notes\nold: /a\nm · auto', { model: 'm', effort: 'low', mode: 'auto' });
  expect(topic).toBe('m · low · auto');
  topic = withStatus(topic, { cost });
  expect(topic).toBe(`m · low · auto · ${cost}`);
  topic = withStatus(topic, { effort: 'high', mode: 'plan' });
  expect(parseTopic(topic)).toEqual({ model: 'm', effort: 'high', mode: 'plan', cost });
});
