import type { ToolDefinitionBody } from '../types.js';
import type { DependencyEvidence } from './merge.js';

/** Suffixes that name a value produced elsewhere rather than authored by a person. */
const OPAQUE_SUFFIX_RE = /(^|_)(id|ids|uuid|guid|key|keys|ref|refs|handle|token|cursor|slug)$/;

/**
 * Words that make an opaque-looking name a user-supplied secret instead of a tool output.
 * api_key and access_token match OPAQUE_SUFFIX_RE but nothing in the server produces them.
 */
const SECRET_HINT_RE = /(^|_)(api|secret|password|passwd|auth|bearer|access|refresh|client|private|public|license)(_|$)/;

/**
 * Formats a person can type. A field carrying one is authorable, so it is not an opaque handle.
 * uuid is deliberately absent: a uuid is the most opaque handle there is.
 */
const AUTHORABLE_FORMATS = new Set([
  'date', 'date-time', 'time', 'duration', 'email', 'idn-email',
  'hostname', 'idn-hostname', 'ipv4', 'ipv6', 'uri', 'url', 'iri', 'regex',
]);

/** Types an opaque handle can be carried in. Anything else is structured data the caller composes. */
const OPAQUE_TYPES = new Set(['string', 'integer', 'number']);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');
}

/** 'restaurant_id' -> 'restaurant'. Returns '' when the name is nothing but the suffix. */
function stemOf(normalizedField: string): string {
  return normalizedField.replace(OPAQUE_SUFFIX_RE, '');
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function requiredFields(body: ToolDefinitionBody): string[] {
  const schema = asRecord(parseJson(body.inputSchemaJson));
  const required = schema?.required;
  if (!Array.isArray(required)) return [];
  return required.filter((field): field is string => typeof field === 'string');
}

function propertySchema(body: ToolDefinitionBody, field: string): Record<string, unknown> | null {
  const schema = asRecord(parseJson(body.inputSchemaJson));
  const properties = asRecord(schema?.properties);
  if (properties === null) return null;
  return asRecord(properties[field]);
}

/**
 * A field is opaque when its name reads as a handle and nothing in the schema lets a person
 * author the value: no enum to pick from, no typeable format, no default to fall back on.
 */
function isOpaqueField(normalizedField: string, property: Record<string, unknown> | null): boolean {
  if (!OPAQUE_SUFFIX_RE.test(normalizedField)) return false;
  if (SECRET_HINT_RE.test(normalizedField)) return false;
  if (property === null) return true;
  if (property.type !== undefined && !(typeof property.type === 'string' && OPAQUE_TYPES.has(property.type))) {
    return false;
  }
  if (property.enum !== undefined) return false;
  if (property.format !== undefined && (typeof property.format !== 'string' || AUTHORABLE_FORMATS.has(property.format))) {
    return false;
  }
  if (property.default !== undefined) return false;
  return true;
}

/** Every `properties` key anywhere in the schema, normalized. Walks into items and nested objects. */
function collectSchemaPropertyNames(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectSchemaPropertyNames(item, into);
    return;
  }
  const record = asRecord(node);
  if (record === null) return;
  for (const [key, value] of Object.entries(record)) {
    if (key === 'properties') {
      const properties = asRecord(value);
      if (properties !== null) {
        for (const name of Object.keys(properties)) into.add(normalizeName(name));
      }
    }
    collectSchemaPropertyNames(value, into);
  }
}

function outputPropertyNames(body: ToolDefinitionBody): Set<string> {
  const names = new Set<string>();
  collectSchemaPropertyNames(parseJson(body.outputSchemaJson), names);
  return names;
}

function mentionsStem(stem: string, body: ToolDefinitionBody): boolean {
  const haystack = `${normalizeName(body.toolName)} ${normalizeName(body.description ?? '')}`;
  return new RegExp(`(^|_|\\s)${escapeRegex(stem)}(e?s)?($|_|\\s)`).test(haystack);
}

/**
 * Layers A + B: a tool that demands an opaque handle it cannot have been told is blocked by
 * whichever sibling tool hands that handle out. Only a unique producer counts; with two of them
 * disabling one still leaves the other, so calling it a blocker would cost a real saving.
 */
export function findSchemaFlowDependencies(
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
    const requiredByTool = new Map<string, Set<string>>();
    const outputNamesByTool = new Map<string, Set<string>>();
    for (const body of tools) {
      requiredByTool.set(body.toolName, new Set(requiredFields(body).map(normalizeName)));
      outputNamesByTool.set(body.toolName, outputPropertyNames(body));
    }

    for (const consumer of tools) {
      for (const field of requiredFields(consumer)) {
        const normalized = normalizeName(field);
        if (!isOpaqueField(normalized, propertySchema(consumer, field))) continue;

        const stem = stemOf(normalized);
        const exact: ToolDefinitionBody[] = [];
        const stemMatches: ToolDefinitionBody[] = [];
        for (const producer of tools) {
          if (producer.toolName === consumer.toolName) continue;
          // A tool that demands the same handle is a fellow consumer, not the source of it.
          if (requiredByTool.get(producer.toolName)?.has(normalized)) continue;
          if (producer.outputSchemaJson !== null) {
            if (outputNamesByTool.get(producer.toolName)?.has(normalized)) exact.push(producer);
          } else if (stem !== '' && mentionsStem(stem, producer)) {
            stemMatches.push(producer);
          }
        }

        // An exact schema match beats a guess; mixing them lets stem noise in on servers that
        // publish output schemas.
        const kind = exact.length > 0 ? 'output' : 'stem';
        const candidates = exact.length > 0 ? exact : stemMatches;
        if (candidates.length !== 1) continue;
        add(serverName, candidates[0].toolName, consumer.toolName, `schema-flow:${kind}:${consumer.toolName}:${field}`);
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
