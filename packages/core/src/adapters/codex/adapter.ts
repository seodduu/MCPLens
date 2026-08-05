import crypto from 'node:crypto';
import path from 'node:path';
import type { LogAdapter, SessionMeta, ToolCallEvent, ToolSearchAttempt,
  ToolLoadEvent, TokenUsageEvent } from '../../types.js';
import { clientLogRoots } from '../../paths.js';
import { countTokens } from '../../tokenize.js';
import type { TurnAwareAdapterResult } from '../../ingest/log-bridge.js';

export class CodexAdapter implements LogAdapter {
  readonly client = 'codex' as const;

  sessionRoots(): string[] { return clientLogRoots('codex'); }

  matches(filePath: string): boolean {
    const p = filePath.split(path.sep).join('/');
    // The real layout is sessions/YYYY/MM/DD/rollout-*.jsonl (nested date directories)
    return /\/\.codex\/sessions\/.+\/rollout-[^/]+\.jsonl$/.test(p);
  }

  parseFile(filePath: string, content: string): TurnAwareAdapterResult {
    const sessionId = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
    const toolCalls: ToolCallEvent[] = [];
    const toolLoads: ToolLoadEvent[] = [];
    const toolSearchAttempts: ToolSearchAttempt[] = [];
    const usage: TokenUsageEvent[] = [];
    let parseErrors = 0;
    let startedAt: string | null = null;
    let externalSessionId: string | null = null;
    let activeTurnId: string | null = null;
    let sawCodeModeSearch = false;

    // call_id → toolLoads index, for correlating custom_tool_call (ALL_TOOLS search
    // script) with its later custom_tool_call_output that carries the loaded text.
    const codeModeCallIds = new Map<string, number>();
    const exactSearchCallIds = new Map<string, string>();
    const toolCallTurnIds: (string | null)[] = [];

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { parseErrors++; continue; }
      startedAt ??= rec.timestamp ?? null;
      // The top-level type is a wrapper such as "event_msg"/"response_item"; the event kind lives in payload.type.
      const p = rec.payload ?? {};
      const t = p.type ?? rec.type;

      if (t === 'session_meta') {
        externalSessionId ??= nativeId(p.session_id ?? p.id ?? rec.session_id ?? rec.id);
      } else if (t === 'task_started' || t === 'turn_context') {
        activeTurnId = nativeId(p.turn_id ?? rec.turn_id);
      } else if (t === 'mcp_tool_call_end') {
        const inv = p.invocation ?? rec.invocation ?? {};
        const result = p.result ?? rec.result;
        const responseText = stringifyOrNull(result);
        toolCalls.push({
          sessionId,
          serverName: String(inv.server ?? 'unknown'),
          toolName: String(inv.tool ?? 'unknown'),
          calledAt: rec.timestamp ?? null,
          durationMs: durationToMs(p.duration ?? rec.duration),
          // Rust-style Result: success {Ok:...} / failure {Err:"..."}, so an Err key means an error.
          isError: isRustErr(result),
          // Codex does not measure tool response tokens either, so the body is estimated with tiktoken (same as the Claude adapter)
          responseTokens: responseText ? countTokens(responseText) : null,
          responseText,
          externalCallId: nativeId(p.call_id ?? rec.call_id),
        });
        toolCallTurnIds.push(activeTurnId);
      } else if (t === 'custom_tool_call') {
        const input = p.input ?? rec.input ?? '';
        const inputText = typeof input === 'string' ? input : JSON.stringify(input);
        if (inputText.includes('ALL_TOOLS')) {
          sawCodeModeSearch = true;
          const callId = p.call_id ?? rec.call_id;
          // The output (raw text of the loaded definition) lives in a separate custom_tool_call_output record, correlated by call_id.
          const idx = toolLoads.push({
            sessionId,
            serverName: null,
            toolName: '(code-mode-search)',
            loadedTokens: null,
          }) - 1;
          if (typeof callId === 'string') codeModeCallIds.set(callId, idx);
          const exactToolName = extractExactCanonicalSearch(inputText);
          if (typeof callId === 'string' && exactToolName) {
            exactSearchCallIds.set(callId, exactToolName);
          }
        }
      } else if (t === 'custom_tool_call_output') {
        const callId = p.call_id ?? rec.call_id;
        const idx = typeof callId === 'string' ? codeModeCallIds.get(callId) : undefined;
        if (idx === undefined) continue;
        const text = extractOutputText(p.output ?? rec.output);
        if (text) toolLoads[idx].loadedTokens = countTokens(text);

        const expectedExactToolName = typeof callId === 'string'
          ? exactSearchCallIds.get(callId) ?? null : null;
        const output = p.output ?? rec.output;
        const classification = classifySearchOutput(output, expectedExactToolName);
        if (classification.kind === 'success') {
          // With several tools one slot is not enough. The first tool takes the original slot and the rest are pushed after it.
          // tool_loads carries no ordering meaning (no timestamp column), so rearranging is safe.
          const [first, ...rest] = classification.tools;
          toolLoads[idx].toolName = first!.toolName;
          toolLoads[idx].loadedTokens = countTokens(first!.definitionText);
          for (const tool of rest) {
            toolLoads.push({
              sessionId,
              serverName: null,
              toolName: tool.toolName,
              loadedTokens: countTokens(tool.definitionText),
            });
          }
        } else if (classification.kind === 'no-match') {
          toolSearchAttempts.push({
            sessionId,
            exactToolName: expectedExactToolName!,
            observedAt: rec.timestamp ?? startedAt ?? '1970-01-01T00:00:00.000Z',
            noMatch: true,
          });
        }
      } else if (t === 'token_count') {
        // Adopt only the per-turn value (last_token_usage). total_token_usage is cumulative and would double count.
        const turn = p.info?.last_token_usage ?? p.last_token_usage ?? rec.info?.last_token_usage;
        if (turn) {
          usage.push({
            sessionId,
            at: rec.timestamp ?? null,
            inputTokens: turn.input_tokens ?? 0,
            outputTokens: turn.output_tokens ?? 0,
            cacheReadTokens: turn.cached_input_tokens ?? 0,
            cacheCreationTokens: 0,
          });
        }
      }
    }

    const session: SessionMeta = {
      sessionId, client: this.client, filePath, externalSessionId, startedAt,
      mode: sawCodeModeSearch ? 'DEFERRED_MEASURABLE'
          : toolCalls.length > 0 ? 'UPFRONT' : 'DEFERRED_OPAQUE',
    };
    return {
      session,
      toolCalls,
      toolLoads,
      usage,
      parseErrors,
      toolCallTurnIds,
      ...(toolSearchAttempts.length > 0 ? { toolSearchAttempts } : {}),
    };
  }
}

type SearchOutputClassification =
  // tools is guaranteed to hold at least one entry. Zero entries means generic.
  | { kind: 'success'; tools: Array<{ toolName: string; definitionText: string }> }
  | { kind: 'no-match' }
  | { kind: 'generic' };

/** Output is classified purely by per-block structure. It never concatenates raw text or hunts for sentinel substrings. */
function classifySearchOutput(
  output: unknown, expectedExactToolName: string | null,
): SearchOutputClassification {
  const parts = outputParts(output);
  let malformed = false;
  let cancellationOrError = false;
  let ambiguousJson = parts.hasUnsupportedPart;
  const evidence: Array<'definition' | 'empty-array' | 'sentinel'> = [];
  let definition: unknown[] | null = null;

  for (const text of parts.texts) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      if (evidence.length > 0) { ambiguousJson = true; continue; }
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          if (parsed.length === 0) evidence.push('empty-array');
          else { evidence.push('definition'); definition = parsed; }
        } else {
          // An object wrapper or a nested metadata name is not evidence of a definition.
          ambiguousJson = true;
        }
      } catch { malformed = true; }
    } else {
      // The description of a JSON definition may contain the ordinary words error or cancelled.
      if (hasCancellationOrError(text)) cancellationOrError = true;
      else if (isNeutralExecutionMetadata(text)) {
        if (evidence.length > 0) ambiguousJson = true;
      } else if (isAllowedNoMatchSentinel(text)) {
        if (evidence.length > 0) ambiguousJson = true;
        else evidence.push('sentinel');
      }
      else ambiguousJson = true;
    }
  }

  if (malformed || cancellationOrError || ambiguousJson) return { kind: 'generic' };
  if (evidence.length !== 1) return { kind: 'generic' };
  if (evidence[0] === 'definition') {
    const elements = definition ?? [];
    if (expectedExactToolName !== null) {
      // Exact search: there is exactly one target. Loosening it brings back the false positives that fix E removed.
      if (elements.length !== 1) return { kind: 'generic' };
      const name = validDefinitionName(elements[0], expectedExactToolName);
      return name === null
        ? { kind: 'generic' }
        : { kind: 'success', tools: [{ toolName: name, definitionText: JSON.stringify(elements[0]) }] };
    }
    // Substring search: accept only canonical MCP definitions and count all of them as loads. If the
    // output carries N definitions, those N tools really were loaded and the tokens of each raw definition are the real cost.
    const tools: Array<{ toolName: string; definitionText: string }> = [];
    const seen = new Set<string>();
    for (const element of elements) {
      const name = validDefinitionName(element, null);
      // An output carrying the same tool twice counts once.
      if (name === null || seen.has(name)) continue;
      seen.add(name);
      tools.push({ toolName: name, definitionText: JSON.stringify(element) });
    }
    return tools.length === 0 ? { kind: 'generic' } : { kind: 'success', tools };
  }
  // Sentinel (TOOL_NOT_FOUND) evidence only means something when we know what was being looked up.
  // Without expectedExactToolName the input pattern is unknown, so there is nothing to record as a no-match.
  return expectedExactToolName !== null ? { kind: 'no-match' } : { kind: 'generic' };
}

function outputParts(output: unknown): { texts: string[]; hasUnsupportedPart: boolean } {
  if (typeof output === 'string') return { texts: [output], hasUnsupportedPart: false };
  if (!Array.isArray(output)) return { texts: [], hasUnsupportedPart: true };
  if (output.length === 0) return { texts: [], hasUnsupportedPart: true };
  const texts: string[] = [];
  let hasUnsupportedPart = false;
  for (const part of output) {
    if (part && typeof part === 'object'
      && (part as any).type === 'input_text' && typeof (part as any).text === 'string') {
      texts.push((part as any).text);
    } else {
      hasUnsupportedPart = true;
    }
  }
  return {
    texts,
    hasUnsupportedPart,
  };
}

/**
 * Checks that the returned definition is a single valid MCP tool definition and returns its name.
 *
 * When expectedExactToolName is present (the input was a single literal exact search) the name must
 * match it exactly, as before. When it is absent (input recognition failed, or the search was broad
 * to begin with) only definition.name itself is validated as the canonical `mcp__server__tool`
 * shape. Server and tool are not split here because a name like `mcp__atlas__deep__lookup` can be
 * split two ways and is only safe to resolve against the list of actually configured servers,
 * a comparison store.attributeCodexLoadName already performs.
 */
function validDefinitionName(value: unknown, expectedExactToolName: string | null): string | null {
  if (value === null || typeof value !== 'object') return null;
  const definition = value as Record<string, unknown>;
  if (typeof definition.name !== 'string') return null;
  if (expectedExactToolName !== null) {
    if (definition.name !== expectedExactToolName) return null;
  } else if (!isCanonicalMcpToolName(definition.name)) {
    return null;
  }
  const hasSchema = typeof definition.description === 'string'
    || hasObjectSchema(definition.inputSchema) || hasObjectSchema(definition.input_schema)
    || hasObjectSchema(definition.schema);
  return hasSchema ? definition.name : null;
}

function hasObjectSchema(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAllowedNoMatchSentinel(text: string): boolean {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.at(-1) === 'TOOL_NOT_FOUND'
    && lines.slice(0, -1).every(isNeutralExecutionMetadataLine);
}

function isNeutralExecutionMetadata(text: string): boolean {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every(isNeutralExecutionMetadataLine);
}

function isNeutralExecutionMetadataLine(line: string): boolean {
  return line === 'Script completed' || line === 'Output:' || line === 'Process exited with code 0'
    // Real Codex prints "Wall time 0.0 seconds" without a colon. Requiring one would stop this line
    // from counting as neutral metadata, dropping a successful exact lookup all the way to generic.
    || /^Wall time:? \d+(?:\.\d+)? (?:ms|milliseconds|s|seconds)$/.test(line);
}

function hasCancellationOrError(text: string): boolean {
  return /\b(cancelled|canceled|error)\b/i.test(text);
}

function isCanonicalMcpToolName(value: string): boolean {
  return /^mcp__[A-Za-z0-9][A-Za-z0-9_-]*__[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

function nativeId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** payload.duration = {secs, nanos} (Rust Duration) -> milliseconds. A number is used as is. */
function durationToMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object') {
    const d = v as { secs?: unknown; nanos?: unknown };
    const secs = typeof d.secs === 'number' ? d.secs : 0;
    const nanos = typeof d.nanos === 'number' ? d.nanos : 0;
    const ms = secs * 1000 + nanos / 1e6;
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** Rust Result: failure {Err:...}, success {Ok:...}. An Err key means an error. */
function isRustErr(v: unknown): boolean {
  return typeof v === 'object' && v !== null && 'Err' in (v as object);
}

/** custom_tool_call_output.output: a string, or an array of [{type:"input_text", text}]. */
function extractOutputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as any).text === 'string') {
          return (part as any).text;
        }
        return '';
      })
      .join('');
  }
  if (output == null) return '';
  return JSON.stringify(output);
}

/** Allows exactly one literal equality in a real ALL_TOOLS.filter/find arrow search. */
function extractExactCanonicalSearch(inputText: string): string | null {
  const { code, literals } = maskJavaScript(inputText);
  const matches = [...code.matchAll(/\bALL_TOOLS\s*\.\s*(?:filter|find)\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*\1\s*\.\s*name\s*={2,3}\s*(__LIT\d+__)\s*\)/g)];
  if (matches.length !== 1) return null;
  const index = Number(matches[0]![2].slice('__LIT'.length, -'__'.length));
  const name = literals[index];
  const normalized = name === undefined ? null : normalizeExactToolName(name);
  return normalized !== null && isCanonicalMcpToolName(normalized) ? normalized : null;
}

function maskJavaScript(input: string): { code: string; literals: string[] } {
  const literals: string[] = [];
  let code = '';
  for (let i = 0; i < input.length;) {
    const current = input[i]!;
    const next = input[i + 1];
    if (current === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') { code += ' '; i++; }
      continue;
    }
    if (current === '/' && next === '*') {
      code += '  '; i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) {
        code += input[i] === '\n' ? '\n' : ' '; i++;
      }
      if (i >= input.length) return { code: '', literals: [] };
      code += '  '; i += 2;
      continue;
    }
    if (current === '`') {
      code += ' ';
      i++;
      while (i < input.length && input[i] !== '`') {
        if (input[i] === '\\' && i + 1 < input.length) { code += '  '; i += 2; }
        else { code += input[i] === '\n' ? '\n' : ' '; i++; }
      }
      if (input[i] !== '`') return { code: '', literals: [] };
      code += ' '; i++;
      continue;
    }
    if (current === '/') {
      // It does not safely distinguish regex from division. A slash outside a string rejects the whole extractor.
      return { code: '', literals: [] };
    }
    if (current === '"' || current === "'") {
      const quote = current;
      let literal = '';
      i++;
      while (i < input.length && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < input.length) i++;
        literal += input[i]!;
        i++;
      }
      if (input[i] !== quote) return { code: '', literals: [] };
      i++;
      const marker = `__LIT${literals.length}__`;
      literals.push(literal);
      code += marker;
      continue;
    }
    code += current;
    i++;
  }
  return { code, literals };
}

function normalizeExactToolName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || /\s/.test(trimmed)) return null;
  return trimmed;
}

function stringifyOrNull(v: unknown): string | null {
  if (v == null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}
