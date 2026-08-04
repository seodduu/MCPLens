import { describe, it, expect } from 'vitest';
import { formatStatus, wasteTooltip } from '../src/statusBar.js';

describe('formatStatus', () => {
  it('shows the clean-state message when no tools are judged wasteful', () => {
    expect(formatStatus(0, 0)).toBe('Lens: no waste ✓');
  });

  it('shows the clean-state message even when tokens are nonzero but tool count is zero', () => {
    expect(formatStatus(0, 5000)).toBe('Lens: no waste ✓');
  });

  it('formats waste tools with k-scaled tokens', () => {
    expect(formatStatus(10, 15267)).toBe('Lens: 10 wasteful tools · 15.2k');
  });

  it('formats exactly 1000 tokens as 1.0k', () => {
    expect(formatStatus(1, 1000)).toBe('Lens: 1 wasteful tools · 1.0k');
  });

  it('shows raw token values below 1000', () => {
    expect(formatStatus(3, 680)).toBe('Lens: 3 wasteful tools · 680');
  });

  it('floors to one decimal within the k range', () => {
    expect(formatStatus(2, 12345)).toBe('Lens: 2 wasteful tools · 12.3k');
  });
});

describe('wasteTooltip', () => {
  it('explains the clean state when no tools are wasteful', () => {
    expect(wasteTooltip(0, 0)).toBe('No wasteful tools found. Click for the detailed report.');
  });

  it('describes the count and per-session definition cost', () => {
    expect(wasteTooltip(10, 15267)).toBe(
      '10 wasteful tools · 15.2k tokens defined per session\n'
      + 'remove/filter-server verdicts, client attribution applied\n'
      + 'Click for the detailed report.');
  });
});
