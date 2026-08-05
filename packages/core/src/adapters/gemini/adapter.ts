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
 * Splits Gemini's flattened MCP tool name (`mcp_<server>_<tool>`) into server and tool.
 * Without the `mcp_` prefix it is a builtin tool, so null.
 * If the remainder has no `_`, server=tool=rest.
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

function nativeId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** functionResponse.response.output -> responseText (a string is used as is, otherwise JSON.stringify) */
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
    let externalSessionId: string | null = null;

    const usage: TokenUsageEvent[] = [];
    const seenGeminiIds = new Set<string>();

    // toolCall id -> the event being assembled (responseText is filled later from functionResponse)
    const toolCallById = new Map<string, ToolCallEvent>();
    const toolCallOrder: string[] = [];
    // functionResponse id -> the response body (matched wherever it sits in record order)
    const responseTextById = new Map<string, string>();

    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (line === '') continue;

      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // Count parse failures instead of throwing
        parseErrors++;
        continue;
      }

      // Defensively skip {$set: {...}} patch records
      if ('$set' in rec) continue;

      // Use startTime from the session metadata record as the startedAt candidate
      if (startedAt == null && typeof rec.startTime === 'string' && 'sessionId' in rec) {
        startedAt = rec.startTime;
      }
      if ('sessionId' in rec) externalSessionId ??= nativeId(rec.sessionId);

      const type = rec.type;

      if (type === 'gemini') {
        const recId = typeof rec.id === 'string' ? rec.id : null;
        const tokens = rec.tokens as
          | { input?: number; output?: number; cached?: number; tool?: number }
          | undefined;

        // Streaming duplicates: the same gemini record id appears twice, so usage counts once
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
        // tokens.tool is the tool token count for the whole turn. The engine sums per call, so
        // putting it on every call would multiply it by the call count. Decide first which MCP
        // calls this record actually adopts, then divide across that many.
        const accepted: { split: { server: string; tool: string }; tc: GeminiToolCall; id: string | null }[] = [];
        for (const tc of toolCalls) {
          if (typeof tc.name !== 'string') continue;
          const split = splitFlattenedName(tc.name);
          if (split == null) continue; // builtin tool, ignore
          const tcId = nativeId(tc.id);
          // Dedup by toolCall id (guards against duplicate records)
          if (tcId != null && toolCallById.has(tcId)) continue;
          accepted.push({ split, tc, id: tcId });
        }

        // To avoid integer skew, hand out the quotient evenly and add 1 of the remainder to the
        // earlier calls. The record total then equals tokens.tool exactly.
        const turnToolTokens = tokens?.tool ?? null;
        const share = turnToolTokens == null || accepted.length === 0
          ? null
          : Math.trunc(turnToolTokens / accepted.length);
        const remainder = turnToolTokens == null || share == null
          ? 0
          : turnToolTokens - share * accepted.length;

        accepted.forEach(({ split, tc, id: tcId }, index) => {
          const event: ToolCallEvent = {
            sessionId,
            serverName: split.server,
            toolName: split.tool,
            calledAt: typeof tc.timestamp === 'string' ? tc.timestamp : null,
            durationMs: null,
            isError: tc.status !== 'success',
            responseTokens: share == null ? null : share + (index < remainder ? 1 : 0),
            responseText: null,
            externalCallId: tcId,
          };
          const key = tcId ?? `__noid_${toolCallOrder.length}`;
          toolCallById.set(key, event);
          toolCallOrder.push(key);
        });
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

    // Fill responseText by matching functionResponse.id to toolCall.id
    for (const [key, event] of toolCallById) {
      const text = responseTextById.get(key);
      if (text != null) event.responseText = text;
    }

    const toolCalls = toolCallOrder.map((k) => toolCallById.get(k)!);

    // Gemini has no deferred-load signal, so a single MCP toolCall means UPFRONT
    const mode = toolCalls.length > 0 ? 'UPFRONT' : 'DEFERRED_OPAQUE';

    return {
      session: {
        sessionId,
        client: 'gemini-cli',
        filePath,
        externalSessionId,
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

// Wrapper restoring the shared contract (LogAdapter implementations are classes); surfaces use new GeminiAdapter().
export class GeminiAdapter implements LogAdapter {
  readonly client = 'gemini-cli' as const;
  sessionRoots(): string[] { return geminiAdapter.sessionRoots(); }
  matches(filePath: string): boolean { return geminiAdapter.matches(filePath); }
  parseFile(filePath: string, content: string): AdapterResult {
    return geminiAdapter.parseFile(filePath, content);
  }
}
