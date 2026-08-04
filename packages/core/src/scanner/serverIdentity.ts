import { createHash } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerSpec } from './configs.js';
import { specTransport } from './configs.js';

export interface RawToolBody {
  toolName: string;
  description?: string | null;
  inputSchema: unknown;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function normalizedUrl(url: string): string {
  return new URL(url).toString();
}

export function computeEndpointHash(spec: McpServerSpec): string {
  const transport = specTransport(spec);
  if (transport === 'stdio') return sha256(`${spec.command ?? ''}\0${(spec.args ?? []).join('\0')}`);
  if (transport === 'http') return sha256(normalizedUrl(spec.url ?? ''));
  return sha256('unknown');
}

export function computeSourcePathHash(filePath: string): string {
  return sha256(filePath);
}

export function computeDefinitionSetHash(
  serverName: string,
  bodies: readonly RawToolBody[],
): string {
  const tools = bodies
    .map((body) => ({
      toolName: body.toolName,
      description: body.description ?? null,
      inputSchema: canonicalize(body.inputSchema),
    }))
    .sort((a, b) => a.toolName.localeCompare(b.toolName));
  return sha256(JSON.stringify({ serverName, tools }));
}

export function toolToRawBody(tool: Tool): RawToolBody {
  return {
    toolName: tool.name,
    description: tool.description ?? null,
    inputSchema: tool.inputSchema ?? {},
  };
}
