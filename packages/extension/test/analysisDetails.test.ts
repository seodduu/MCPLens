import { describe, expect, it } from 'vitest';
import { buildAnalysisDetails } from '../src/analysisDetails.js';

const independent = {
  serverName: 'github', toolName: 'search', status: 'Independent' as const,
  dependedOnBy: [], rationale: 'No observed dependency.', displaySummary: 'Searches repositories.',
  whatYouLose: 'Repository search.', riskWithoutTool: 'Search workflows need another tool.',
};

describe('buildAnalysisDetails', () => {
  it('builds every independent detail label and global scope notice in English', () => {
    const details = buildAnalysisDetails(independent, '{"type":"object"}');
    expect(details.sections.map((section) => section.label)).toEqual([
      'What it does', 'What you lose', 'Risk without this tool',
      'Why Lens considers it independent', 'View original definition',
    ]);
    expect(details.notices).toEqual([
      'Applies to all projects',
      'Takes effect in new Claude Code / Codex sessions',
    ]);
  });

  it('keeps non-independent details read-only and omits generated summary fields', () => {
    const details = buildAnalysisDetails({ ...independent, status: 'Dependent', displaySummary: null });
    expect(details.canDisableGlobally).toBe(false);
    expect(details.sections.map((section) => section.label)).toEqual(['Rationale']);
  });
});
