import { describe, it, expect } from 'vitest';
import { reportOptions } from '../src/reportCommand.js';

describe('reportOptions', () => {
  it('reportDetail 설정을 ReportOptions.detail로 전달한다', () => {
    expect(reportOptions({ reportDays: 30, reportDetail: 'full' }).detail).toBe('full');
  });
  it('reportDetail 미설정 시 summary가 기본값', () => {
    expect(reportOptions({ reportDays: 30 }).detail).toBe('summary');
  });
  it('reportDays를 days로 전달한다', () => {
    expect(reportOptions({ reportDays: 7 }).days).toBe(7);
  });
  it('reportDays가 0 이하면 1로 보정한다', () => {
    expect(reportOptions({ reportDays: 0 }).days).toBe(1);
  });
});
