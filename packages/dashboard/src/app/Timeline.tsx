import { useMemo } from 'react';
import type { SessionMeta, ToolCallEvent } from '@mcp-lens/core';

export interface TimelineProps {
  sessions: SessionMeta[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  calls: ToolCallEvent[];
}

export function Timeline({ sessions, selectedSessionId, onSelectSession, calls }: TimelineProps) {
  const maxDuration = useMemo(
    () => Math.max(1, ...calls.map((c) => c.durationMs ?? 0)),
    [calls],
  );

  return (
    <div className="timeline">
      <label htmlFor="session-select">세션</label>
      <select
        id="session-select"
        value={selectedSessionId ?? ''}
        onChange={(e) => onSelectSession(e.target.value)}
      >
        <option value="" disabled>
          세션을 선택하세요
        </option>
        {sessions.map((s) => (
          <option key={s.sessionId} value={s.sessionId}>
            {s.sessionId} ({s.client})
          </option>
        ))}
      </select>

      {selectedSessionId && calls.length === 0 && <p>이 세션에는 호출 기록이 없습니다.</p>}

      <ul className="timeline-bars">
        {calls.map((call, idx) => {
          const widthPct = Math.max(2, ((call.durationMs ?? 0) / maxDuration) * 100);
          return (
            <li key={`${call.sessionId}-${call.toolName}-${idx}`} className="timeline-row">
              <span className="timeline-label">
                {call.serverName}/{call.toolName}
              </span>
              <span
                className="timeline-bar"
                style={{
                  width: `${widthPct}%`,
                  backgroundColor: call.isError ? '#d64545' : '#3b7ddd',
                }}
                title={`${call.durationMs ?? '?'}ms`}
              />
              <span className="timeline-duration">
                {call.durationMs != null ? `${call.durationMs}ms` : '측정 불가'}
                {call.isError ? ' · 실패' : ''}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
