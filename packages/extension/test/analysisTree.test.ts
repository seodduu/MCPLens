import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAnalysisRows, globalEnforcementNotice } from '../src/analysisTree.js';

describe('buildAnalysisRows', () => {
  it('gives only independent tools a generated summary and global disable action', () => {
    const rows = buildAnalysisRows([
      { serverName: 'github', toolName: 'search', status: 'Independent', dependedOnBy: [], rationale: 'No observed dependency.', displaySummary: 'Searches repositories.', whatYouLose: 'Repository search.', riskWithoutTool: 'Search workflows need another tool.' },
      { serverName: 'github', toolName: 'get_file', status: 'Dependent', dependedOnBy: ['github/search'], rationale: 'Used after search.', displaySummary: 'Reads files.', whatYouLose: 'File reads.', riskWithoutTool: 'Follow-up reads fail.' },
    ]);

    expect(rows[0]).toMatchObject({ status: 'Independent', summary: 'Searches repositories.', action: 'Disable globally…', canDisableGlobally: true });
    expect(rows[1]).toMatchObject({ status: 'Dependent', canDisableGlobally: false });
    expect(rows[1]).not.toHaveProperty('summary');
    expect(rows[1]).not.toHaveProperty('action');
  });

  it('reports not analyzed, failed, and identity-conflict states without a disable action', () => {
    expect(buildAnalysisRows([], [
      { serverName: 'github', toolName: 'search', state: 'Not analyzed' },
      { serverName: 'gitlab', toolName: 'search', state: 'Analysis failed' },
      { serverName: 'notion', toolName: 'find', state: 'Identity conflict' },
    ])).toEqual([
      expect.objectContaining({ status: 'Not analyzed', canDisableGlobally: false }),
      expect.objectContaining({ status: 'Analysis failed', canDisableGlobally: false }),
      expect.objectContaining({ status: 'Identity conflict', canDisableGlobally: false }),
    ]);
  });

  it('explains bypassPermissions enforcement limits and policy restrictions', () => {
    expect(globalEnforcementNotice({ claudeMode: 'bypassPermissions' }))
      .toBe('Global enforcement is not guaranteed in bypassPermissions mode.');
    expect(globalEnforcementNotice({ claudeMode: 'bypassPermissions', policyWriteRestricted: true }))
      .toBe('Policy restricted');
  });

  it('keeps every Task 10 UI literal English-only', () => {
    const task10UiModules = [
      '../src/analysisTree.ts',
      '../src/analysisDetails.ts',
      '../src/inferenceConsent.ts',
      '../src/providerConfig.ts',
      '../src/matrixTree.ts',
      '../src/lensTreeProvider.ts',
    ];

    for (const modulePath of task10UiModules) {
      const source = readFileSync(new URL(modulePath, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(source, modulePath).not.toMatch(/[가-힣]/);
    }
  });
});
