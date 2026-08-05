import { describe, expect, it } from 'vitest';
import type { ToolDependencyResult } from '@mcp-lens/core';
import { buildDisableConfirmation } from '../src/disableConfirmation.js';

const independent = (overrides: Partial<ToolDependencyResult> = {}): ToolDependencyResult => ({
  serverName: 'github', toolName: 'list_gists', status: 'Independent',
  rationale: 'No other tool consumes its output.',
  displaySummary: 'Lists gists for the authenticated user.',
  whatYouLose: 'You can no longer list gists from the assistant.',
  riskWithoutTool: 'Low. Gist listing is available on the web.',
  ...overrides,
} as ToolDependencyResult);

describe('buildDisableConfirmation', () => {
  it('무엇을 잃는지를 본문에 담고 확인 버튼을 준다', () => {
    const confirmation = buildDisableConfirmation(independent());
    expect(confirmation.message).toContain('github/list_gists');
    expect(confirmation.detail).toContain('You can no longer list gists from the assistant.');
    expect(confirmation.confirmLabel).toBe('Disable globally');
  });

  it('되돌릴 수 있다는 사실과 적용 시점을 함께 고지한다', () => {
    const detail = buildDisableConfirmation(independent()).detail;
    expect(detail).toContain('new');   // 새 세션부터 적용
    expect(detail.toLowerCase()).toContain('restore');
  });

  // 분석이 값을 안 준 경우에도 빈 칸을 보여주지 않는다.
  it('whatYouLose가 없으면 대체 문구를 쓴다', () => {
    const detail = buildDisableConfirmation(independent({ whatYouLose: null })).detail;
    expect(detail).toContain('Not available.');
  });

  it('위험도 문구가 있으면 함께 보여준다', () => {
    expect(buildDisableConfirmation(independent()).detail)
      .toContain('Low. Gist listing is available on the web.');
  });
});
