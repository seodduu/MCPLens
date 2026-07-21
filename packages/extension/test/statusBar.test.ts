import { describe, it, expect } from 'vitest';
import { formatStatus, wasteTooltip } from '../src/statusBar.js';

describe('formatStatus', () => {
  it('shows the clean-state message when no tools are judged wasteful', () => {
    expect(formatStatus(0, 0)).toBe('Lens: 낭비 없음 ✓');
  });

  it('shows the clean-state message even when tokens are nonzero but tool count is zero', () => {
    expect(formatStatus(0, 5000)).toBe('Lens: 낭비 없음 ✓');
  });

  it('formats waste tools with k-scaled tokens', () => {
    expect(formatStatus(10, 15267)).toBe('Lens: 낭비 10툴 · 15.2k');
  });

  it('formats exactly 1000 tokens as 1.0k', () => {
    expect(formatStatus(1, 1000)).toBe('Lens: 낭비 1툴 · 1.0k');
  });

  it('shows raw token values below 1000', () => {
    expect(formatStatus(3, 680)).toBe('Lens: 낭비 3툴 · 680');
  });

  it('floors to one decimal within the k range', () => {
    expect(formatStatus(2, 12345)).toBe('Lens: 낭비 2툴 · 12.3k');
  });
});

describe('wasteTooltip', () => {
  it('explains the clean state when no tools are wasteful', () => {
    expect(wasteTooltip(0, 0)).toBe('낭비로 판단한 툴 없음 · 클릭 → 상세 리포트');
  });

  it('describes the count and per-session definition cost', () => {
    expect(wasteTooltip(10, 15267)).toBe(
      '낭비로 판단한 툴 10개 · 세션당 정의 15.2k토큰\n'
      + 'remove/filter-server 판정 · 클라이언트 귀속 적용\n'
      + '클릭 → 상세 리포트');
  });
});
