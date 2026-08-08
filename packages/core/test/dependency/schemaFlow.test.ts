import { describe, it, expect } from 'vitest';
import { findSchemaFlowDependencies } from '../../src/dependency/schemaFlow.js';
import type { ToolDefinitionBody } from '../../src/types.js';

interface ToolSpec {
  serverName?: string;
  toolName: string;
  description?: string | null;
  properties?: Record<string, unknown>;
  required?: string[];
  outputSchema?: unknown;
}

function body(spec: ToolSpec): ToolDefinitionBody {
  return {
    serverName: spec.serverName ?? 's',
    toolName: spec.toolName,
    description: spec.description ?? null,
    inputSchemaJson: JSON.stringify({
      type: 'object',
      properties: spec.properties ?? {},
      required: spec.required ?? [],
    }),
    outputSchemaJson: spec.outputSchema === undefined ? null : JSON.stringify(spec.outputSchema),
    definitionTokens: 10,
    definitionSetHash: 'h',
    scannedAt: '2026-08-08T00:00:00.000Z',
  };
}

describe('findSchemaFlowDependencies', () => {
  it('finds the sole producer by output schema field name', () => {
    const result = findSchemaFlowDependencies([
      body({ toolName: 'A', outputSchema: { type: 'object', properties: { venue_ref: { type: 'string' } } } }),
      body({ toolName: 'B', properties: { venue_ref: { type: 'string' } }, required: ['venue_ref'] }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].toolName).toBe('A');
    expect(result[0].dependedOnBy).toEqual(['B']);
    expect(result[0].evidence).toEqual(['schema-flow:output:B:venue_ref']);
  });

  it('falls back to stem matching when the producer has no output schema', () => {
    const result = findSchemaFlowDependencies([
      body({ toolName: 'search_restaurants' }),
      body({ toolName: 'B', properties: { restaurant_id: { type: 'string' } }, required: ['restaurant_id'] }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].toolName).toBe('search_restaurants');
    expect(result[0].evidence).toEqual(['schema-flow:stem:B:restaurant_id']);
  });

  it('prefers an exact output match over a stem match', () => {
    const result = findSchemaFlowDependencies([
      body({ toolName: 'A1', outputSchema: { type: 'object', properties: { restaurant_id: { type: 'string' } } } }),
      body({ toolName: 'A2', description: 'Search restaurants nearby.' }),
      body({ toolName: 'B', properties: { restaurant_id: { type: 'string' } }, required: ['restaurant_id'] }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].toolName).toBe('A1');
  });

  it('emits nothing when two tools can produce the field', () => {
    const result = findSchemaFlowDependencies([
      body({ toolName: 'A1', outputSchema: { type: 'object', properties: { restaurant_id: { type: 'string' } } } }),
      body({ toolName: 'A2', outputSchema: { type: 'object', properties: { restaurant_id: { type: 'string' } } } }),
      body({ toolName: 'B', properties: { restaurant_id: { type: 'string' } }, required: ['restaurant_id'] }),
    ]);

    expect(result).toEqual([]);
  });

  it('emits nothing when the field is only optional', () => {
    const result = findSchemaFlowDependencies([
      body({ toolName: 'A', outputSchema: { type: 'object', properties: { restaurant_id: { type: 'string' } } } }),
      body({ toolName: 'B', properties: { restaurant_id: { type: 'string' } }, required: [] }),
    ]);

    expect(result).toEqual([]);
  });

  it('ignores api_key as a user-supplied secret', () => {
    const result = findSchemaFlowDependencies([
      body({ toolName: 'create_api_key', outputSchema: { type: 'object', properties: { api_key: { type: 'string' } } } }),
      body({ toolName: 'B', properties: { api_key: { type: 'string' } }, required: ['api_key'] }),
    ]);

    expect(result).toEqual([]);
  });

  it('ignores an enum field', () => {
    const result = findSchemaFlowDependencies([
      body({ toolName: 'list_regions', outputSchema: { type: 'object', properties: { region_id: { type: 'string' } } } }),
      body({
        toolName: 'B',
        properties: { region_id: { type: 'string', enum: ['us', 'eu'] } },
        required: ['region_id'],
      }),
    ]);

    expect(result).toEqual([]);
  });

  it('ignores a date-formatted field', () => {
    const result = findSchemaFlowDependencies([
      body({ toolName: 'A', outputSchema: { type: 'object', properties: { start_date_id: { type: 'string' } } } }),
      body({
        toolName: 'B',
        properties: { start_date_id: { type: 'string', format: 'date' } },
        required: ['start_date_id'],
      }),
    ]);

    expect(result).toEqual([]);
  });

  it('does not treat a co-consumer as a producer', () => {
    const result = findSchemaFlowDependencies([
      body({ toolName: 'B1', properties: { restaurant_id: { type: 'string' } }, required: ['restaurant_id'] }),
      body({ toolName: 'B2', properties: { restaurant_id: { type: 'string' } }, required: ['restaurant_id'] }),
    ]);

    expect(result).toEqual([]);
  });

  it('gives up stem matching when the field name is only a suffix', () => {
    const result = findSchemaFlowDependencies([
      body({ toolName: 'search_restaurants' }),
      body({ toolName: 'list_venues' }),
      body({ toolName: 'get_weather' }),
      body({ toolName: 'send_notification' }),
      body({ toolName: 'B', properties: { id: { type: 'string' } }, required: ['id'] }),
    ]);

    expect(result).toEqual([]);
  });

  it('does not cross the server boundary', () => {
    const result = findSchemaFlowDependencies([
      body({
        serverName: 'X',
        toolName: 'A',
        outputSchema: { type: 'object', properties: { restaurant_id: { type: 'string' } } },
      }),
      body({
        serverName: 'Y',
        toolName: 'B',
        properties: { restaurant_id: { type: 'string' } },
        required: ['restaurant_id'],
      }),
    ]);

    expect(result).toEqual([]);
  });

  it('normalizes camelCase field and tool names', () => {
    const result = findSchemaFlowDependencies([
      body({ toolName: 'searchRestaurants' }),
      body({ toolName: 'B', properties: { restaurantId: { type: 'string' } }, required: ['restaurantId'] }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].toolName).toBe('searchRestaurants');
  });

  it('walks nested output schema properties', () => {
    const result = findSchemaFlowDependencies([
      body({
        toolName: 'A',
        outputSchema: { properties: { results: { items: { properties: { venue_ref: {} } } } } },
      }),
      body({ toolName: 'B', properties: { venue_ref: { type: 'string' } }, required: ['venue_ref'] }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].toolName).toBe('A');
  });

  it('returns a deterministic order', () => {
    const tools = ['alpha', 'beta'].flatMap((serverName) => [
      body({
        serverName,
        toolName: 'find_venue',
        outputSchema: { type: 'object', properties: { venue_ref: { type: 'string' } } },
      }),
      body({
        serverName,
        toolName: 'find_spot',
        outputSchema: { type: 'object', properties: { spot_ref: { type: 'string' } } },
      }),
      body({
        serverName,
        toolName: 'book',
        properties: { venue_ref: { type: 'string' }, spot_ref: { type: 'string' } },
        required: ['venue_ref', 'spot_ref'],
      }),
    ]);

    const result = findSchemaFlowDependencies(tools);

    expect(result.map((entry) => [entry.serverName, entry.toolName])).toEqual([
      ['alpha', 'find_spot'],
      ['alpha', 'find_venue'],
      ['beta', 'find_spot'],
      ['beta', 'find_venue'],
    ]);
  });
});
