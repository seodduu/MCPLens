import crypto from 'node:crypto';
import path from 'node:path';
import type {
  AdapterResult,
  LogAdapter,
  SessionMeta,
  ToolCallEvent,
  ToolLoadEvent,
  TokenUsageEvent,
} from '../../types.js';
import { clientLogRoots } from '../../paths.js';

const MCP_NAME = /^mcp__(.+?)__(.+)$/;

/** Claude Code(.claude/projects/*.jsonl) 세션 로그 어댑터. */
export class ClaudeAdapter implements LogAdapter {
  readonly client = 'claude-code' as const;

  sessionRoots(): string[] {
    return clientLogRoots('claude-code');
  }

  matches(filePath: string): boolean {
    const p = filePath.split(path.sep).join('/');
    return /\/\.claude\/projects\/[^/]+\/[^/]+\.jsonl$/.test(p);
  }

  parseFile(filePath: string, content: string): AdapterResult {
    const sessionId = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
    const toolCalls: ToolCallEvent[] = [];
    const toolLoads: ToolLoadEvent[] = [];
    const usage: TokenUsageEvent[] = [];
    const pendingUse = new Map<string, { server: string; tool: string; at: string | null }>();
    let parseErrors = 0;
    let startedAt: string | null = null;
    let sawLoadSignal = false;

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        parseErrors++;
        continue;
      }
      startedAt ??= rec.timestamp ?? null;

      const msg = rec.message;
      if (!msg || typeof msg !== 'object') continue;

      // 토큰: message.usage 4필드
      if (msg.usage && typeof msg.usage === 'object') {
        usage.push({
          sessionId,
          at: rec.timestamp ?? null,
          inputTokens: msg.usage.input_tokens ?? 0,
          outputTokens: msg.usage.output_tokens ?? 0,
          cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: msg.usage.cache_creation_input_tokens ?? 0,
        });
      }

      const parts = Array.isArray(msg.content) ? msg.content : [];
      for (const part of parts) {
        if (!part || typeof part !== 'object') continue;

        if (part.type === 'tool_use') {
          // ToolSearch 호출 자체도 로드 신호(설계문서: 지연 세션 확정) → 모드 판별에만 사용
          if (part.name === 'ToolSearch') sawLoadSignal = true;
          const m = MCP_NAME.exec(part.name ?? '');
          if (m) {
            pendingUse.set(part.id, { server: m[1], tool: m[2], at: rec.timestamp ?? null });
          }
        } else if (part.type === 'tool_result') {
          // 로드 신호(핵심): tool_result content[]의 {type:'tool_reference', tool_name:'mcp__...'}
          if (Array.isArray(part.content)) {
            for (const inner of part.content) {
              if (inner && inner.type === 'tool_reference') {
                sawLoadSignal = true;
                const load = splitName(inner.tool_name ?? '');
                toolLoads.push({
                  sessionId,
                  serverName: load.server,
                  toolName: load.tool,
                  loadedTokens: null, // Claude는 이름만 기록 → 스캐너 조인으로 산출
                });
              }
            }
          }

          // MCP 실호출 응답 매칭
          const u = pendingUse.get(part.tool_use_id);
          if (u) {
            pendingUse.delete(part.tool_use_id);
            toolCalls.push({
              sessionId,
              serverName: u.server,
              toolName: u.tool,
              calledAt: u.at,
              durationMs: null,
              isError: part.is_error === true,
              responseTokens: null,
              responseText: flattenResult(part.content),
            });
          }
        }
      }
    }

    const hasMcp = toolCalls.length > 0 || toolLoads.length > 0;
    const session: SessionMeta = {
      sessionId,
      client: this.client,
      filePath,
      startedAt,
      mode: sawLoadSignal ? 'DEFERRED_MEASURABLE' : hasMcp ? 'UPFRONT' : 'DEFERRED_OPAQUE',
    };
    return { session, toolCalls, toolLoads, usage, parseErrors };
  }
}

/** mcp__<server>__<tool> 을 분해. 매칭 안 되면 server=null, tool=원본 이름. */
function splitName(name: string): { server: string | null; tool: string } {
  const m = MCP_NAME.exec(name);
  if (m) return { server: m[1], tool: m[2] };
  return { server: null, tool: name };
}

/** tool_result 본문: 문자열이면 그대로, 배열이면 content[].text를 이어붙임. */
function flattenResult(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('');
  }
  return null;
}
