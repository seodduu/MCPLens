import { describe, expect, it } from 'vitest';
import { formatCollectionHealth, type CollectionHealthSnapshot } from '../src/hookStatus.js';

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
    expect(formatCollectionHealth(snapshot('healthy')).label).toBe('정상');
  });

  it('labels hook-only collection and keeps the missing token detail visible', () => {
    expect(formatCollectionHealth(snapshot('hook-only'))).toMatchObject({
      label: '부분 측정', description: 'Hook only · 토큰 상세 없음',
    });
  });

  it('labels log-only collection as dependent on the unofficial format', () => {
    expect(formatCollectionHealth(snapshot('log-only'))).toMatchObject({
      label: '부분 측정', description: 'Log only · 비공식 포맷 의존',
    });
  });

  it('waits for the first event when hooks are configured but no evidence exists', () => {
    expect(formatCollectionHealth(snapshot('idle'), { hooksConfigured: true })).toMatchObject({
      label: '첫 이벤트 대기', description: 'Hook 또는 로그 이벤트를 기다리는 중',
    });
  });

  it('marks unavailable collection as requiring review', () => {
    expect(formatCollectionHealth(snapshot('unavailable'))).toMatchObject({
      label: '검토 필요', description: 'Hook과 로그를 모두 확인할 수 없음',
    });
  });

  it('labels degraded collection and exposes the correlation misses', () => {
    expect(formatCollectionHealth(snapshot('degraded', { consecutiveMisses: 3 }))).toMatchObject({
      label: '성능 저하', description: '연속 상관관계 불일치 3회',
    });
  });

  it('keeps an inactive collector idle', () => {
    expect(formatCollectionHealth(snapshot('idle'))).toMatchObject({
      label: '유휴', description: '최근 MCP 수집 이벤트 없음',
    });
  });
});
