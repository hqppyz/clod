import { expect, test } from 'bun:test';
import { Status } from './channels';

test('updates each part of the status line, dropping unknown lines', () => {
  const cost = '12.0k cache read · 9.4k cache write · 2 in · 16 out · $0.100';
  expect(Status.apply(null, { model: 'm', effort: 'low', mode: 'auto' })).toBe('m · low · auto');
  expect(Status.apply(null, { cost })).toBe('');
  let topic = Status.apply('notes\nold: /a\nm · auto', { model: 'm', effort: 'low', mode: 'auto' });
  expect(topic).toBe('m · low · auto');
  topic = Status.apply(topic, { cost });
  expect(topic).toBe(`m · low · auto · ${cost}`);
  topic = Status.apply(topic, { effort: 'high', mode: 'plan' });
  expect(Status.parse(topic)).toEqual({ model: 'm', effort: 'high', mode: 'plan', cost });
});
