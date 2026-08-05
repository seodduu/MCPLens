import { useMemo } from 'react';
import type { SessionMeta, ToolCallEvent } from '@mcp-lens/core';

export interface TimelineProps {
  sessions: SessionMeta[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  calls: ToolCallEvent[];
}

/** ISO 문자열을 "2026-08-05 14:32" 로 (표시 형식만 담당, 값은 core가 준 것 그대로). */
function formatStartedAt(iso: string | null): string {
  if (!iso) return '시각 미상';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '시각 미상';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sessionLabel(s: SessionMeta): string {
  return `${formatStartedAt(s.startedAt)} · ${s.client} · ${s.sessionId.slice(0, 8)}`;
}

export function Timeline({ sessions, selectedSessionId, onSelectSession, calls }: TimelineProps) {
  const maxDuration = useMemo(
    () => Math.max(1, ...calls.map((c) => c.durationMs ?? 0)),
    [calls],
  );

  // 최근 순 정렬. startedAt 미상은 뒤로 보낸다.
  const ordered = useMemo(() => {
    return [...sessions].sort((a, b) => {
      if (a.startedAt == null && b.startedAt == null) return a.sessionId.localeCompare(b.sessionId);
      if (a.startedAt == null) return 1;
      if (b.startedAt == null) return -1;
      return b.startedAt.localeCompare(a.startedAt);
    });
  }, [sessions]);

  // 선택된 세션이 목록에서 사라지면(7일 창 밖으로 밀림) select value 가 옵션과 어긋난다.
  // 그 경우를 위한 안내 옵션을 하나 붙여 둔다.
  const selectionMissing =
    selectedSessionId != null && !ordered.some((s) => s.sessionId === selectedSessionId);

  return (
    <div className="timeline">
      <div className="timeline-controls">
        <label htmlFor="session-select">세션 (최근 순)</label>
        <select
          id="session-select"
          value={selectedSessionId ?? ''}
          onChange={(e) => onSelectSession(e.target.value)}
        >
          <option value="" disabled>
            세션을 선택하세요
          </option>
          {selectionMissing && (
            <option value={selectedSessionId}>
              {selectedSessionId.slice(0, 8)} (목록 밖 세션)
            </option>
          )}
          {ordered.map((s) => (
            <option key={s.sessionId} value={s.sessionId}>
              {sessionLabel(s)}
            </option>
          ))}
        </select>
        <span className="timeline-count">최근 7일 {ordered.length}개</span>
      </div>

      {selectionMissing && (
        <p className="timeline-note">
          선택한 세션이 최근 7일 목록에서 벗어났습니다. 다른 세션을 골라 주세요.
        </p>
      )}

      {selectedSessionId && calls.length === 0 && <p>이 세션에는 호출 기록이 없습니다.</p>}

      <ul className="timeline-bars">
        {calls.map((call, idx) => {
          const widthPct = Math.max(2, ((call.durationMs ?? 0) / maxDuration) * 100);
          return (
            <li key={`${call.sessionId}-${call.toolName}-${idx}`} className="timeline-row">
              <span className="timeline-label">
                {call.serverName}/{call.toolName}
              </span>
              <span className="timeline-track">
                <span
                  className="timeline-bar"
                  style={{
                    width: `${widthPct}%`,
                    backgroundColor: call.isError ? '#d64545' : '#3b7ddd',
                  }}
                  title={`${call.durationMs ?? '?'}ms`}
                />
              </span>
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
