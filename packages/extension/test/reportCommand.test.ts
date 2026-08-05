import { describe, it, expect } from 'vitest';
import { reportOptions } from '../src/reportCommand.js';

describe('reportOptions', () => {
  it('passes the reportDetail setting through as ReportOptions.detail', () => {
    expect(reportOptions({ reportDays: 30, reportDetail: 'full' }).detail).toBe('full');
  });
  it('defaults to summary when reportDetail is unset', () => {
    expect(reportOptions({ reportDays: 30 }).detail).toBe('summary');
  });
  it('passes reportDays through as days', () => {
    expect(reportOptions({ reportDays: 7 }).days).toBe(7);
  });
  it('clamps reportDays to 1 when it is 0 or less', () => {
    expect(reportOptions({ reportDays: 0 }).days).toBe(1);
  });
});
