import crypto from 'node:crypto';
import path from 'node:path';
import type { LogAdapter, SessionMeta, ToolCallEvent,
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
    const usage: TokenUsageEvent[] = [];
    let parseErrors = 0;
    let startedAt: string | null = null;
    let externalSessionId: string | null = null;
    let activeTurnId: string | null = null;
    let sawCodeModeSearch = false;

    // call_id → toolLoads index, for correlating custom_tool_call (ALL_TOOLS search
    // script) with its later custom_tool_call_output that carries the loaded text.
    const codeModeCallIds = new Map<string, number>();
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
        toolCalls.push({
          sessionId,
          serverName: String(inv.server ?? 'unknown'),
          toolName: String(inv.tool ?? 'unknown'),
          calledAt: rec.timestamp ?? null,
          durationMs: durationToMs(p.duration ?? rec.duration),
          // Rust 스타일 Result: 성공 {Ok:...} / 실패 {Err:"..."} → Err 존재 시 에러.
          isError: isRustErr(result),
          responseTokens: null,
          responseText: stringifyOrNull(result),
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
        }
      } else if (t === 'custom_tool_call_output') {
        const callId = p.call_id ?? rec.call_id;
        const idx = typeof callId === 'string' ? codeModeCallIds.get(callId) : undefined;
        if (idx !== undefined) {
          const text = extractOutputText(p.output ?? rec.output);
          if (text) toolLoads[idx].loadedTokens = countTokens(text);
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
    return { session, toolCalls, toolLoads, usage, parseErrors, toolCallTurnIds };
  }
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

function stringifyOrNull(v: unknown): string | null {
  if (v == null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}
