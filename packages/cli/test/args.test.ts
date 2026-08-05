import { describe, it, expect } from 'vitest';
import { parseDays, parseFormat } from '../src/args.js';

describe('parseDays', () => {
  it('falls back to the default when absent', () => {
    expect(parseDays(undefined)).toEqual({ ok: true, value: 30 });
  });
  it('accepts positive numbers', () => {
    expect(parseDays('7')).toEqual({ ok: true, value: 7 });
  });
  it.each(['abc', '', '0', '-3', 'NaN', 'Infinity'])('rejects non-numbers and values <= 0: %s', (raw) => {
    const result = parseDays(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('--days');
  });
});

describe('parseFormat', () => {
  it('defaults to table when absent', () => {
    expect(parseFormat(undefined)).toEqual({ ok: true, value: 'table' });
  });
  it.each(['table', 'ai', 'json'])('accepts known formats: %s', (raw) => {
    expect(parseFormat(raw)).toEqual({ ok: true, value: raw });
  });
  it('reports unknown values instead of silently falling back to table', () => {
    const result = parseFormat('bogus');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('bogus');
      expect(result.message).toContain('table, ai, json');
    }
  });
});
