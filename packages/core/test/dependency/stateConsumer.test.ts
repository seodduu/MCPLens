import { describe, it, expect } from 'vitest';
import { findStateConsumers } from '../../src/dependency/stateConsumer.js';
import type { ToolDefinitionBody } from '../../src/types.js';

function body(
  serverName: string,
  toolName: string,
  description: string | null,
  required: string[],
): ToolDefinitionBody {
  return {
    serverName,
    toolName,
    description,
    inputSchemaJson: JSON.stringify({
      type: 'object',
      properties: Object.fromEntries(required.map((key) => [key, { type: 'string' }])),
      required,
    }),
    outputSchemaJson: null,
    definitionTokens: 1,
    definitionSetHash: 'h',
    scannedAt: '2026-08-08T00:00:00.000Z',
  };
}

describe('findStateConsumers', () => {
  it('detects a no-input tool that speaks of the current page', () => {
    const scan = findStateConsumers([
      body('s', 'read_page', 'Read the visible text of the current page.', []),
    ]);

    expect(scan.hintsByServer['s'].length).toBe(1);
    expect(scan.hintsByServer['s'][0].toolName).toBe('read_page');
    expect(scan.hintsByServer['s'][0].deicticPhrase).toBe('current page');
  });

  it('does not detect a no-input tool without a deictic phrase', () => {
    const scan = findStateConsumers([body('s', 'list_servers', 'List every configured server.', [])]);

    expect(scan.hintsByServer).toEqual({});
  });

  it('does not detect a tool that has required input', () => {
    const scan = findStateConsumers([
      body('s', 'read_page', 'Read the visible text of the current page.', ['url']),
    ]);

    expect(scan.hintsByServer).toEqual({});
  });

  it('attributes the producer when the noun is in its tool name', () => {
    const scan = findStateConsumers([
      body('s', 'get_current_document', 'Return the current document.', []),
      body('s', 'open_document', 'Open a document at the given path.', ['path']),
    ]);

    expect(scan.evidence.length).toBe(1);
    expect(scan.evidence[0].toolName).toBe('open_document');
    expect(scan.evidence[0].dependedOnBy).toEqual(['get_current_document']);
    expect(scan.evidence[0].evidence).toEqual(['state-flow:get_current_document:document']);
  });

  it('emits a hint but no evidence when the noun matches nothing', () => {
    const scan = findStateConsumers([
      body('s', 'read_page', 'Read the visible text of the current page.', []),
      body('s', 'navigate', 'Go to a URL.', ['url']),
    ]);

    expect(scan.evidence).toEqual([]);
    expect(scan.hintsByServer['s'].length).toBe(1);
  });

  it('emits no evidence when two tools carry the noun', () => {
    const scan = findStateConsumers([
      body('s', 'get_current_document', 'Return the current document.', []),
      body('s', 'open_document', 'Open a document at the given path.', ['path']),
      body('s', 'import_document', 'Import a document from a URL.', ['url']),
    ]);

    expect(scan.evidence).toEqual([]);
    expect(scan.hintsByServer['s'].length).toBe(1);
  });

  it('does not treat another state consumer as the producer', () => {
    const scan = findStateConsumers([
      body('s', 'get_current_document', 'Return the current document.', []),
      body('s', 'describe_document', 'Describe the currently loaded document.', []),
    ]);

    expect(scan.evidence).toEqual([]);
  });

  it('does not cross the server boundary', () => {
    const scan = findStateConsumers([
      body('x', 'get_current_document', 'Return the current document.', []),
      body('y', 'open_document', 'Open a document at the given path.', ['path']),
    ]);

    expect(scan.evidence).toEqual([]);
  });

  it('singularizes the noun before matching', () => {
    const scan = findStateConsumers([
      body('s', 'read_selection', 'Read the selected files.', []),
      body('s', 'open_file', 'Open a file at the given path.', ['path']),
    ]);

    expect(scan.evidence[0].toolName).toBe('open_file');
  });

  it('groups hints by server', () => {
    const scan = findStateConsumers([
      body('x', 'read_page', 'Read the visible text of the current page.', []),
      body('y', 'get_current_document', 'Return the current document.', []),
    ]);

    expect(Object.keys(scan.hintsByServer).sort()).toEqual(['x', 'y']);
  });
});
