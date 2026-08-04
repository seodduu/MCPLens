import { describe, expect, it } from 'vitest';
import { clientRowPresentation, formatCollectionHealth, type CollectionHealthSnapshot } from '../src/hookStatus.js';

function snapshot(
  health: CollectionHealthSnapshot['health'],
  overrides: Partial<CollectionHealthSnapshot> = {},
): CollectionHealthSnapshot {
  return {
    health,
    hookObserved: health === 'healthy' || health === 'hook-only' || health === 'degraded',
    logObserved: health === 'healthy' || health === 'log-only' || health === 'degraded',
    consecutiveMisses: 0,
    consecutiveMatches: 0,
    waitingForCorrelation: 0,
    lastEventAt: null,
    ...overrides,
  };
}

describe('formatCollectionHealth', () => {
  it('labels healthy collection', () => {
    expect(formatCollectionHealth(snapshot('healthy')).label).toBe('Healthy');
  });

  it('labels hook-only collection and keeps the missing token detail visible', () => {
    expect(formatCollectionHealth(snapshot('hook-only'))).toMatchObject({
      label: 'Partially measured', description: 'Hook only, no token detail',
    });
  });

  it('labels log-only collection as dependent on the unofficial format', () => {
    expect(formatCollectionHealth(snapshot('log-only'))).toMatchObject({
      label: 'Partially measured', description: 'Log only, relies on an unofficial format',
    });
  });

  it('waits for the first event when hooks are configured but no evidence exists', () => {
    expect(formatCollectionHealth(snapshot('idle'), { hooksConfigured: true })).toMatchObject({
      label: 'Waiting for first event', description: 'Waiting for a hook or log event',
    });
  });

  it('marks unavailable collection as requiring review', () => {
    expect(formatCollectionHealth(snapshot('unavailable'))).toMatchObject({
      label: 'Needs review', description: 'Neither hook nor log can be confirmed',
    });
  });

  it('labels degraded collection and exposes the correlation misses', () => {
    expect(formatCollectionHealth(snapshot('degraded', { consecutiveMisses: 3 }))).toMatchObject({
      label: 'Degraded', description: '3 consecutive correlation misses',
    });
  });

  it('keeps an inactive collector idle', () => {
    expect(formatCollectionHealth(snapshot('idle'))).toMatchObject({
      label: 'Idle', description: 'No recent MCP collection events',
    });
  });
});

const healthy = { health: 'healthy', hookObserved: true, logObserved: true,
  consecutiveMisses: 0, consecutiveMatches: 1, waitingForCorrelation: 0, lastEventAt: null } as const;

describe('clientRowPresentation', () => {
  it('미설치는 미연결(설치 필요)로 표시', () => {
    const p = clientRowPresentation('not-installed', undefined);
    expect(p.label).toContain('Not connected');
    expect(p.severity).toBe('warning');
  });
  it('설치+정상은 formatCollectionHealth 결과', () => {
    const p = clientRowPresentation('installed', healthy);
    expect(p.label).toBe('Healthy');
  });
  it('설치됐지만 관측 없으면 첫 이벤트 대기', () => {
    const p = clientRowPresentation('installed', undefined);
    expect(p.label).toContain('Waiting');
  });
});
