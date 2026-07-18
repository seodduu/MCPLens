// packages/core/src/adapters/gemini/adapter.ts
import crypto from 'node:crypto';
import { clientLogRoots } from '../../paths.js';
import type {
  AdapterResult,
  LogAdapter,
  ToolCallEvent,
  TokenUsageEvent,
} from '../../types.js';

/**
 * Gemini의 평탄화된 MCP 툴 이름(`mcp_<server>_<tool>`)을 서버/툴로 분해한다.
 * `mcp_` 접두어가 없으면 내장 툴 → null.
 * 잔여 문자열에 `_`가 없으면 server=tool=rest.
 */
export function splitFlattenedName(
  name: string,
): { server: string; tool: string } | null {
  const m = /^mcp_(.+)$/.exec(name);
  if (!m) return null;
  const rest = m[1];
  const i = rest.indexOf('_');
  if (i === -1) return { server: rest, tool: rest };
  return { server: rest.slice(0, i), tool: rest.slice(i + 1) };
}

function sessionIdFromPath(filePath: string): string {
  return crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
}

/** functionResponse.response.output → responseText (문자열이면 그대로, 아니면 JSON.stringify) */
function outputToText(response: unknown): string | null {
  if (response == null || typeof response !== 'object') return null;
  const output = (response as Record<string, unknown>).output;
  if (output == null) return null;
  return typeof output === 'string' ? output : JSON.stringify(output);
}

interface GeminiToolCall {
  id?: string;
  name?: string;
  args?: unknown;
  status?: string;
  timestamp?: string;
}

interface FunctionResponseItem {
  functionResponse?: {
    id?: string;
    name?: string;
    response?: unknown;
  };
}

export const geminiAdapter: LogAdapter = {
  client: 'gemini-cli',

  sessionRoots(): string[] {
    return clientLogRoots('gemini-cli');
  },

  matches(filePath: string): boolean {
    const norm = filePath.replace(/\\/g, '/');
    return /\/\.gemini\/tmp\/.+\/chats\/[^/]+\.jsonl?$/.test(norm);
  },

  parseFile(filePath: string, content: string): AdapterResult {
    const sessionId = sessionIdFromPath(filePath);
    let parseErrors = 0;
    let startedAt: string | null = null;

    const usage: TokenUsageEvent[] = [];
    const seenGeminiIds = new Set<string>();

    // toolCall id → 조립 중인 이벤트 (responseText는 functionResponse에서 나중에 채움)
    const toolCallById = new Map<string, ToolCallEvent>();
    const toolCallOrder: string[] = [];
    // functionResponse id → 응답 본문 (레코드 순서상 앞뒤 어디에 있어도 매칭)
    const responseTextById = new Map<string, string>();

    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (line === '') continue;

      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // 파싱 실패는 throw 대신 계수
        parseErrors++;
        continue;
      }

      // {$set: {...}} 패치 레코드는 방어적으로 스킵
      if ('$set' in rec) continue;

      // 세션 메타 레코드의 startTime을 startedAt 후보로 사용
      if (startedAt == null && typeof rec.startTime === 'string' && 'sessionId' in rec) {
        startedAt = rec.startTime;
      }

      const type = rec.type;

      if (type === 'gemini') {
        const recId = typeof rec.id === 'string' ? rec.id : null;
        const tokens = rec.tokens as
          | { input?: number; output?: number; cached?: number; tool?: number }
          | undefined;

        // 스트리밍 중복 레코드: 같은 id의 gemini 레코드가 2번 나타난다 → usage는 1회만
        if (recId != null && !seenGeminiIds.has(recId)) {
          seenGeminiIds.add(recId);
          usage.push({
            sessionId,
            at: typeof rec.timestamp === 'string' ? rec.timestamp : null,
            inputTokens: tokens?.input ?? 0,
            outputTokens: tokens?.output ?? 0,
            cacheReadTokens: tokens?.cached ?? 0,
            cacheCreationTokens: 0,
          });
        }

        const toolCalls = Array.isArray(rec.toolCalls)
          ? (rec.toolCalls as GeminiToolCall[])
          : [];
        const responseTokens = tokens?.tool ?? null;

        for (const tc of toolCalls) {
          if (typeof tc.name !== 'string') continue;
          const split = splitFlattenedName(tc.name);
          if (split == null) continue; // 내장 툴 → 무시
          const tcId = typeof tc.id === 'string' ? tc.id : null;
          // toolCall id 기준 dedup (중복 레코드 방지)
          if (tcId != null && toolCallById.has(tcId)) continue;

          const event: ToolCallEvent = {
            sessionId,
            serverName: split.server,
            toolName: split.tool,
            calledAt: typeof tc.timestamp === 'string' ? tc.timestamp : null,
            durationMs: null,
            isError: tc.status !== 'success',
            responseTokens,
            responseText: null,
          };
          const key = tcId ?? `__noid_${toolCallOrder.length}`;
          toolCallById.set(key, event);
          toolCallOrder.push(key);
        }
      } else if (type === 'user') {
        const contentArr = Array.isArray(rec.content)
          ? (rec.content as FunctionResponseItem[])
          : [];
        for (const item of contentArr) {
          const fr = item?.functionResponse;
          if (fr == null || typeof fr.id !== 'string') continue;
          const text = outputToText(fr.response);
          if (text != null) responseTextById.set(fr.id, text);
        }
      }
    }

    // functionResponse.id ↔ toolCall.id 매칭으로 responseText 채움
    for (const [key, event] of toolCallById) {
      const text = responseTextById.get(key);
      if (text != null) event.responseText = text;
    }

    const toolCalls = toolCallOrder.map((k) => toolCallById.get(k)!);

    // Gemini는 지연 로드 신호가 없다 → MCP toolCall이 1개라도 있으면 UPFRONT
    const mode = toolCalls.length > 0 ? 'UPFRONT' : 'DEFERRED_OPAQUE';

    return {
      session: {
        sessionId,
        client: 'gemini-cli',
        filePath,
        startedAt,
        mode,
      },
      toolCalls,
      toolLoads: [],
      usage,
      parseErrors,
    };
  },
};

// 공유 계약(LogAdapter 구현체는 class) 복원용 래퍼 — 표면들은 new GeminiAdapter()를 사용한다.
export class GeminiAdapter implements LogAdapter {
  readonly client = 'gemini-cli' as const;
  sessionRoots(): string[] { return geminiAdapter.sessionRoots(); }
  matches(filePath: string): boolean { return geminiAdapter.matches(filePath); }
  parseFile(filePath: string, content: string): AdapterResult {
    return geminiAdapter.parseFile(filePath, content);
  }
}
