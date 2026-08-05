import { describe, it, expect } from 'vitest';
import { parseDays, parseFormat } from '../src/args.js';

describe('parseDays', () => {
  it('없으면 기본값', () => {
    expect(parseDays(undefined)).toEqual({ ok: true, value: 30 });
  });
  it('양수는 통과', () => {
    expect(parseDays('7')).toEqual({ ok: true, value: 7 });
  });
  it.each(['abc', '', '0', '-3', 'NaN', 'Infinity'])('숫자가 아니거나 0 이하면 실패: %s', (raw) => {
    const result = parseDays(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('--days');
  });
});

describe('parseFormat', () => {
  it('없으면 table', () => {
    expect(parseFormat(undefined)).toEqual({ ok: true, value: 'table' });
  });
  it.each(['table', 'ai', 'json'])('알려진 형식은 통과: %s', (raw) => {
    expect(parseFormat(raw)).toEqual({ ok: true, value: raw });
  });
  it('알 수 없는 값은 조용히 table로 폴백하지 않고 안내한다', () => {
    const result = parseFormat('bogus');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('bogus');
      expect(result.message).toContain('table, ai, json');
    }
  });
});
