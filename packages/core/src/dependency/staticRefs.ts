import type { ToolDefinitionBody } from '../types.js';
import type { DependencyEvidence } from './merge.js';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactToolRegex(toolName: string): RegExp {
  return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegex(toolName)}($|[^A-Za-z0-9_])`);
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(stringValues);
  }
  return [];
}

function schemaStringValues(inputSchemaJson: string): string[] {
  try {
    return stringValues(JSON.parse(inputSchemaJson));
  } catch {
    return [];
  }
}

export function findStaticDependencyRefs(
  bodies: readonly ToolDefinitionBody[],
): DependencyEvidence[] {
  const byServer = new Map<string, ToolDefinitionBody[]>();
  for (const body of bodies) {
    const list = byServer.get(body.serverName) ?? [];
    list.push(body);
    byServer.set(body.serverName, list);
  }

  const evidence = new Map<string, DependencyEvidence>();
  const add = (serverName: string, toolName: string, dependedOnBy: string, reason: string): void => {
    const key = `${serverName}\0${toolName}`;
    const current = evidence.get(key) ?? { serverName, toolName, dependedOnBy: [], evidence: [] };
    if (!current.dependedOnBy.includes(dependedOnBy)) current.dependedOnBy.push(dependedOnBy);
    if (!current.evidence.includes(reason)) current.evidence.push(reason);
    evidence.set(key, current);
  };

  for (const [serverName, tools] of byServer) {
    for (const candidate of tools) {
      const regex = exactToolRegex(candidate.toolName);
      for (const body of tools) {
        if (body.toolName === candidate.toolName) continue;
        if (body.description !== null && regex.test(body.description)) {
          add(serverName, candidate.toolName, body.toolName, `description:${body.toolName}`);
        }
        if (schemaStringValues(body.inputSchemaJson).some((value) => regex.test(value))) {
          add(serverName, candidate.toolName, body.toolName, `inputSchema:${body.toolName}`);
        }
      }
    }
  }

  return [...evidence.values()].map((entry) => ({
    ...entry,
    dependedOnBy: entry.dependedOnBy.sort(),
    evidence: entry.evidence.sort(),
  })).sort(compareEvidence);
}

function compareEvidence(a: DependencyEvidence, b: DependencyEvidence): number {
  return a.serverName.localeCompare(b.serverName) || a.toolName.localeCompare(b.toolName);
}
