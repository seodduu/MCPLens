import { describe, it, expect } from 'vitest';
import definitions from '../../../../fixtures/dependency/definitions.json' assert { type: 'json' };
import { findStaticDependencyRefs } from '../../src/dependency/staticRefs.js';
import type { ToolDefinitionBody } from '../../src/types.js';

describe('findStaticDependencyRefs', () => {
  it('finds only exact tool names of the same server in description and schema string values', () => {
    const refs = findStaticDependencyRefs(definitions as ToolDefinitionBody[]);

    expect(refs).toEqual([
      {
        serverName: 'github',
        toolName: 'get_repo',
        dependedOnBy: ['search_repos'],
        evidence: ['description:search_repos'],
      },
      {
        serverName: 'github',
        toolName: 'search_repos',
        dependedOnBy: ['get_repo'],
        evidence: ['inputSchema:get_repo'],
      },
    ]);
  });

  it('excludes self-matches, substrings and matches in schema property keys alone', () => {
    const refs = findStaticDependencyRefs([
      {
        serverName: 's',
        toolName: 'repo',
        description: 'self repo and substring xget_repo are not exact repo references',
        inputSchemaJson: JSON.stringify({
          properties: {
            repo: { type: 'string' },
            other: { description: 'Repo is case-sensitive and xget_repo is not exact.' },
          },
        }),
        definitionTokens: 1,
        definitionSetHash: 'h',
        scannedAt: '2026-08-03T00:00:00.000Z',
      },
      {
        serverName: 's',
        toolName: 'get_repo',
        description: null,
        inputSchemaJson: '{}',
        definitionTokens: 1,
        definitionSetHash: 'h',
        scannedAt: '2026-08-03T00:00:00.000Z',
      },
    ]);

    expect(refs).toEqual([]);
  });
});
