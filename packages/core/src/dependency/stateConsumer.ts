import type { StateConsumerHint, ToolDefinitionBody } from '../types.js';
import type { DependencyEvidence } from './merge.js';

export interface StateConsumerScan {
  /** Blockers, emitted only when the producer is uniquely identified. */
  evidence: DependencyEvidence[];
  /** Always emitted for every detected consumer. Keyed by server name. Fed to the LLM tier. */
  hintsByServer: Record<string, StateConsumerHint[]>;
}

/**
 * Phrases that presuppose an already-established referent. A tool that takes no required input and
 * still speaks of "the current page" is reading state some other tool set up.
 */
const DEICTIC_RE =
  /\b(current|currently|active|already[ -]open|this (page|session|document|file|window|tab|context|conversation)|the (open|opened|loaded|selected|focused|active) [a-z]+|previously (opened|selected|loaded|used)|last (opened|selected|used)|in progress)\b/i;

/** "the current page" -> "page". First capture only; a second deictic phrase is ignored. */
const STATE_NOUN_RE =
  /\b(?:current|currently|active|open|opened|loaded|selected|focused|this)\s+([a-z][a-z0-9_-]*)/i;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requiredKeys(inputSchemaJson: string): string[] {
  try {
    const parsed = JSON.parse(inputSchemaJson) as { required?: unknown };
    return Array.isArray(parsed.required) ? parsed.required.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/** Drops a plural "s" so "files" and "file" match the same producer name. */
function singularize(noun: string): string {
  return noun.length > 3 && noun.endsWith('s') && !noun.endsWith('ss') ? noun.slice(0, -1) : noun;
}

/** Tool names are snake/kebab cased; flatten separators so a noun can be matched on word boundaries. */
function normalizeToolName(toolName: string): string {
  return toolName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function nameCarriesNoun(toolName: string, noun: string): boolean {
  return new RegExp(`\\b${escapeRegex(noun)}s?\\b`).test(normalizeToolName(toolName));
}

interface Consumer {
  body: ToolDefinitionBody;
  hint: StateConsumerHint;
  /** The state noun the producer must carry, when one could be extracted. */
  noun: string | null;
}

/**
 * A tool is a state consumer only when it takes no required input AND speaks deictically.
 * Either condition alone is not enough: `list_all_servers` takes no input yet needs no prior state.
 */
function asConsumer(body: ToolDefinitionBody): Consumer | null {
  if (requiredKeys(body.inputSchemaJson).length > 0) return null;
  if (body.description === null) return null;

  const deictic = DEICTIC_RE.exec(body.description);
  if (deictic === null) return null;

  const stateNoun = STATE_NOUN_RE.exec(body.description);
  const phrase = (stateNoun !== null ? stateNoun[0] : deictic[0]).toLowerCase().replace(/\s+/g, ' ');

  return {
    body,
    hint: { toolName: body.toolName, deicticPhrase: phrase },
    noun: stateNoun !== null ? singularize(stateNoun[1].toLowerCase()) : null,
  };
}

/**
 * Detects tools that read ambient state, and attributes the producer when exactly one tool of the
 * same server can plausibly have set that state up. Zero candidates is a normal outcome, not a
 * failure: `read_page` is fed by `navigate`, whose name carries no "page". The hint still goes out
 * so the LLM tier can make that call.
 */
export function findStateConsumers(bodies: readonly ToolDefinitionBody[]): StateConsumerScan {
  const byServer = new Map<string, ToolDefinitionBody[]>();
  for (const body of bodies) {
    const list = byServer.get(body.serverName) ?? [];
    list.push(body);
    byServer.set(body.serverName, list);
  }

  const evidence = new Map<string, DependencyEvidence>();
  const hintsByServer: Record<string, StateConsumerHint[]> = {};

  for (const [serverName, tools] of byServer) {
    const consumers = new Map<string, Consumer>();
    for (const body of tools) {
      const consumer = asConsumer(body);
      if (consumer !== null) consumers.set(body.toolName, consumer);
    }
    if (consumers.size === 0) continue;

    hintsByServer[serverName] = [...consumers.values()]
      .map((consumer) => consumer.hint)
      .sort((a, b) => a.toolName.localeCompare(b.toolName));

    for (const consumer of consumers.values()) {
      const noun = consumer.noun;
      if (noun === null) continue;

      // A state consumer cannot be the producer of another one; something outside must set the state.
      const candidates = tools.filter(
        (body) =>
          !consumers.has(body.toolName) &&
          requiredKeys(body.inputSchemaJson).length > 0 &&
          nameCarriesNoun(body.toolName, noun),
      );
      if (candidates.length !== 1) continue;

      const producer = candidates[0];
      const key = `${serverName}\0${producer.toolName}`;
      const current = evidence.get(key) ?? {
        serverName,
        toolName: producer.toolName,
        dependedOnBy: [],
        evidence: [],
      };
      const reason = `state-flow:${consumer.body.toolName}:${noun}`;
      if (!current.dependedOnBy.includes(consumer.body.toolName)) {
        current.dependedOnBy.push(consumer.body.toolName);
      }
      if (!current.evidence.includes(reason)) current.evidence.push(reason);
      evidence.set(key, current);
    }
  }

  return {
    evidence: [...evidence.values()]
      .map((entry) => ({
        ...entry,
        dependedOnBy: entry.dependedOnBy.sort(),
        evidence: entry.evidence.sort(),
      }))
      .sort((a, b) => a.serverName.localeCompare(b.serverName) || a.toolName.localeCompare(b.toolName)),
    hintsByServer,
  };
}
