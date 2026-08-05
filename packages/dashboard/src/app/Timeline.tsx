import { useMemo } from 'react';
import type { SessionMeta, ToolCallEvent } from '@mcp-lens/core';

export interface TimelineProps {
  sessions: SessionMeta[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  calls: ToolCallEvent[];
}

/** Formats an ISO string as "2026-08-05 14:32" (display only; the value is exactly what core gave). */
function formatStartedAt(iso: string | null): string {
  if (!iso) return 'time unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'time unknown';
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

  // Newest first. Sessions with an unknown startedAt go last.
  const ordered = useMemo(() => {
    return [...sessions].sort((a, b) => {
      if (a.startedAt == null && b.startedAt == null) return a.sessionId.localeCompare(b.sessionId);
      if (a.startedAt == null) return 1;
      if (b.startedAt == null) return -1;
      return b.startedAt.localeCompare(a.startedAt);
    });
  }, [sessions]);

  // If the selected session drops out of the list (pushed outside the 7-day window), the select
  // value no longer matches any option. This extra option covers that case.
  const selectionMissing =
    selectedSessionId != null && !ordered.some((s) => s.sessionId === selectedSessionId);

  return (
    <div className="timeline">
      <div className="timeline-controls">
        <label htmlFor="session-select">Session (newest first)</label>
        <select
          id="session-select"
          value={selectedSessionId ?? ''}
          onChange={(e) => onSelectSession(e.target.value)}
        >
          <option value="" disabled>
            Select a session
          </option>
          {selectionMissing && (
            <option value={selectedSessionId}>
              {selectedSessionId.slice(0, 8)} (session outside the list)
            </option>
          )}
          {ordered.map((s) => (
            <option key={s.sessionId} value={s.sessionId}>
              {sessionLabel(s)}
            </option>
          ))}
        </select>
        <span className="timeline-count">{ordered.length} in the last 7 days</span>
      </div>

      {selectionMissing && (
        <p className="timeline-note">
          The selected session has dropped out of the last 7 days. Pick another one.
        </p>
      )}

      {selectedSessionId && calls.length === 0 && <p>This session has no call records.</p>}

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
                {call.durationMs != null ? `${call.durationMs}ms` : 'not measurable'}
                {call.isError ? ' · failed' : ''}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
