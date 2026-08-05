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
  it('states what is lost in the body and offers a confirm button', () => {
    const confirmation = buildDisableConfirmation(independent());
    expect(confirmation.message).toContain('github/list_gists');
    expect(confirmation.detail).toContain('You can no longer list gists from the assistant.');
    expect(confirmation.confirmLabel).toBe('Disable globally');
  });

  it('states that it can be undone and when it takes effect', () => {
    const detail = buildDisableConfirmation(independent()).detail;
    expect(detail).toContain('new');   // applies from new sessions
    expect(detail.toLowerCase()).toContain('restore');
  });

  // Never show a blank when the analysis produced no value.
  it('uses fallback wording when whatYouLose is absent', () => {
    const detail = buildDisableConfirmation(independent({ whatYouLose: null })).detail;
    expect(detail).toContain('Not available.');
  });

  it('shows the risk wording when present', () => {
    expect(buildDisableConfirmation(independent()).detail)
      .toContain('Low. Gist listing is available on the web.');
  });
});
