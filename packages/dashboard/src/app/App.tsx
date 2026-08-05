import { useEffect, useState } from 'react';
import type { MatrixRow, SessionMeta, ToolCallEvent } from '@mcp-lens/core';
import { MatrixTable } from './MatrixTable.js';
import { Timeline } from './Timeline.js';

const POLL_INTERVAL_MS = 5000;

interface MatrixResponse {
  rows: MatrixRow[];
  savings: { potentialTokens: number; actualTokens: number; savedTokens: number };
}

export default function App() {
  const [matrix, setMatrix] = useState<MatrixResponse | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [calls, setCalls] = useState<ToolCallEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const [matrixRes, sessionsRes] = await Promise.all([
          fetch('/api/matrix?days=30'),
          fetch('/api/sessions?days=7'),
        ]);
        if (!matrixRes.ok || !sessionsRes.ok) throw new Error('request failed');
        const matrixBody: MatrixResponse = await matrixRes.json();
        const sessionsBody: SessionMeta[] = await sessionsRes.json();
        if (cancelled) return;
        setMatrix(matrixBody);
        setSessions(sessionsBody);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!selectedSessionId) {
      setCalls([]);
      return;
    }
    let cancelled = false;

    async function fetchTimeline() {
      try {
        const res = await fetch(`/api/timeline/${encodeURIComponent(selectedSessionId!)}`);
        if (!res.ok) throw new Error('timeline request failed');
        const body: ToolCallEvent[] = await res.json();
        if (!cancelled) setCalls(body);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }

    fetchTimeline();
    const id = setInterval(fetchTimeline, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [selectedSessionId]);

  return (
    <main className="app">
      <h1>MCP Lens dashboard</h1>
      {error && <p className="error">Error: {error}</p>}

      <section>
        <h2>Token savings summary</h2>
        {matrix ? (
          <p>
            potential {matrix.savings.potentialTokens.toLocaleString()} tokens · actual{' '}
            {matrix.savings.actualTokens.toLocaleString()} tokens · saved{' '}
            {matrix.savings.savedTokens.toLocaleString()} tokens
          </p>
        ) : (
          <p>Loading…</p>
        )}
      </section>

      <section>
        <h2>Matrix</h2>
        <MatrixTable rows={matrix?.rows ?? []} />
      </section>

      <section>
        <h2>Timeline</h2>
        <Timeline
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          onSelectSession={setSelectedSessionId}
          calls={calls}
        />
      </section>
    </main>
  );
}
