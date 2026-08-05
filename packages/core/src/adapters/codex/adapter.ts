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
    // 실제 레이아웃은 sessions/YYYY/MM/DD/rollout-*.jsonl (중첩 날짜 디렉토리)
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
      // 최상위 type은 "event_msg"/"response_item" 등 래퍼이고, 이벤트 종류는 payload.type에 있다.
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
          // Rust 스타일 Result: 성공 {Ok:...} / 실패 {Err:"..."} → Err 존재 시 에러.
          isError: isRustErr(result),
          // Codex도 툴 응답 토큰을 실측하지 않는다 → 본문 tiktoken 추정 (Claude 어댑터와 동일)
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
          // 출력(로드된 정의 원문)은 별도 custom_tool_call_output 레코드에 있다 → call_id로 상관.
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
          // 다중이면 슬롯 하나로 부족하다. 첫 툴은 원래 슬롯에 넣고 나머지는 뒤에 push한다.
          // tool_loads에는 순서 의미가 없으므로(시각 컬럼 없음) 재배치가 안전하다.
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
        // 턴별(last_token_usage)만 채택. total_token_usage는 누적이라 이중계상됨.
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
  // tools는 길이 1 이상을 보장한다. 0개면 generic이다.
  | { kind: 'success'; tools: Array<{ toolName: string; definitionText: string }> }
  | { kind: 'no-match' }
  | { kind: 'generic' };

/** Output은 block별 구조만 분류한다. 원문 연결이나 sentinel 부분 문자열 탐색은 하지 않는다. */
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
          // object wrapper와 nested metadata name은 definition 증거가 아니다.
          ambiguousJson = true;
        }
      } catch { malformed = true; }
    } else {
      // JSON definition의 description은 error/cancelled라는 일반 단어를 가질 수 있다.
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
      // 정확 검색: 지목 대상이 하나다. 느슨하게 하면 결함 E 보정이 막은 오탐이 돌아온다.
      if (elements.length !== 1) return { kind: 'generic' };
      const name = validDefinitionName(elements[0], expectedExactToolName);
      return name === null
        ? { kind: 'generic' }
        : { kind: 'success', tools: [{ toolName: name, definitionText: JSON.stringify(elements[0]) }] };
    }
    // 부분일치 검색: canonical MCP 정의만 골라 전부 로드로 인정한다. 출력에 정의가 N개
    // 실려 있으면 그 N개가 실제로 로드된 툴이고, 각 정의 원문의 토큰이 실지불 비용이다.
    const tools: Array<{ toolName: string; definitionText: string }> = [];
    const seen = new Set<string>();
    for (const element of elements) {
      const name = validDefinitionName(element, null);
      // 같은 툴이 두 번 실린 출력은 한 번만 센다.
      if (name === null || seen.has(name)) continue;
      seen.add(name);
      tools.push({ toolName: name, definitionText: JSON.stringify(element) });
    }
    return tools.length === 0 ? { kind: 'generic' } : { kind: 'success', tools };
  }
  // sentinel(TOOL_NOT_FOUND) evidence는 "무엇을 찾다가 없었는지"를 알 때만 의미가 있다.
  // 입력 패턴을 몰라 expectedExactToolName이 없으면 no-match로 기록할 대상이 없다.
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
 * 반환된 정의가 유효한 단일 MCP 툴 정의인지 확인하고, 유효하면 그 이름을 돌려준다.
 *
 * expectedExactToolName이 있으면(입력이 단일 리터럴 exact 검색이었으면) 그 이름과
 * 정확히 같아야 한다 — 기존 동작 그대로. 없으면(입력 인식이 실패했거나 애초에 넓은
 * 검색이었으면) definition.name 자체가 canonical `mcp__server__tool` 형태인지만
 * 검증한다. 서버/툴을 여기서 분리하지 않는 이유: `mcp__atlas__deep__lookup`처럼
 * 두 가지로 나뉠 수 있는 이름은 실제 설정된 서버 목록과 대조해야만 안전하게 풀 수
 * 있고, 그 대조는 store.attributeCodexLoadName이 이미 한다.
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
    // 실기기 Codex는 콜론 없이 "Wall time 0.0 seconds"로 출력한다. 콜론을 강제하면
    // 이 줄이 중립 메타데이터로 인정되지 않아 exact lookup 성공이 통째로 generic으로 떨어진다.
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

/** payload.duration = {secs, nanos} (Rust Duration) → 밀리초. 숫자면 그대로 사용. */
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

/** Rust Result: 실패 {Err:...}, 성공 {Ok:...}. Err 키가 있으면 에러. */
function isRustErr(v: unknown): boolean {
  return typeof v === 'object' && v !== null && 'Err' in (v as object);
}

/** custom_tool_call_output.output: string 또는 [{type:"input_text", text}] 배열. */
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

/** 실제 ALL_TOOLS.filter/find arrow search의 literal equality 하나만 허용한다. */
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
      // regex/division을 안전하게 구분하지 않는다. 문자열 밖 slash는 extractor 전체를 거부한다.
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
