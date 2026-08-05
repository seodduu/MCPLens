import { describe, expect, it } from 'vitest';
import { joinReason } from '../../src/engine/engine.js';
import { gateRecommendation } from '../../src/engine/healthGate.js';
import type { CollectionHealthSnapshot } from '../../src/health/collectionHealth.js';
import type { Recommendation } from '../../src/types.js';

function recommendation(action: Recommendation['action']): Recommendation {
  const reasonParts: Recommendation['reasonParts'] = action === 'inspect'
    ? {
        basis: '4회 중 3회 실패(75%), 실패 응답 120토큰 낭비',
        serverBasis: null,
        effect: '점검·대체 권장',
        caveat: null,
      }
    : action === 'filter-server'
      ? {
          basis: '',
          serverBasis: '서버 github의 10툴 중 1개만 사용. 툴 필터링 권장.',
          effect: '제거 시 매 세션 약 900토큰 절약',
          caveat: null,
        }
      : action === 'remove'
        ? {
            basis: '정의 900토큰, 호출 0회',
            serverBasis: null,
            effect: '제거 시 매 세션 약 900토큰 절약',
            caveat: null,
          }
        : action === 'keep'
          ? { basis: '7회 호출됨', serverBasis: null, effect: null, caveat: null }
          : {
              basis: '정의 토큰 미확보 (스캐너 미커버)',
              serverBasis: null,
              effect: null,
              caveat: null,
            };
  return {
    action,
    confidence: 'high',
    reason: joinReason(reasonParts),
    reasonParts,
    evidenceLabel: '실측',
    evidence: {
      observedSessions: 12,
      datedObservedSessions: 12,
      observedDays: 10,
      lastCalledAt: null,
      costPerSession: 900,
      totalObservedCost: 10_800,
    },
  };
}

const health = (value: CollectionHealthSnapshot['health']): CollectionHealthSnapshot => ({
  health: value,
  hookObserved: value !== 'log-only' && value !== 'idle' && value !== 'unavailable',
  logObserved: value !== 'hook-only' && value !== 'idle' && value !== 'unavailable',
  consecutiveMisses: 0,
  consecutiveMatches: 0,
  waitingForCorrelation: 0,
  lastEventAt: null,
});

describe('gateRecommendation', () => {
  it.each(['remove', 'filter-server'] as const)(
    'demotes %s to a low-confidence candidate when collection is degraded',
    (action) => {
      const gated = gateRecommendation(recommendation(action), health('degraded'));

      expect(gated.action).toBe(action);
      expect(gated.confidence).toBe('low');
      expect(gated.reasonParts.caveat).toContain('수집 건강도');
    },
  );

  it.each(['remove', 'filter-server'] as const)(
    'demotes %s to a low-confidence candidate when collection is unavailable',
    (action) => {
      expect(gateRecommendation(recommendation(action), health('unavailable')).confidence)
        .toBe('low');
    },
  );

  it('keeps observed-failure inspection visible while degraded', () => {
    const original = recommendation('inspect');
    const gated = gateRecommendation(original, health('degraded'));

    expect(gated).toBe(original);
    expect(gated.action).toBe('inspect');
  });

  it('marks transcript token evidence unavailable in hook-only mode', () => {
    const gated = gateRecommendation(recommendation('inspect'), health('hook-only'));

    expect(gated.action).toBe('inspect');
    expect(gated.evidenceLabel).toBe('측정 불가');
    expect(gated.evidence.costPerSession).toBeNull();
    expect(gated.evidence.totalObservedCost).toBeNull();
  });

  it.each(['remove', 'filter-server', 'inspect', 'keep', 'unknown'] as const)(
    'removes transcript-token claims and structured token evidence from %s in hook-only mode',
    (action) => {
      const gated = gateRecommendation(recommendation(action), health('hook-only'));
      const renderedParts = [
        gated.reasonParts.basis,
        gated.reasonParts.serverBasis,
        gated.reasonParts.effect,
      ].filter((part): part is string => part !== null).join(' ');

      expect(gated.evidenceLabel).toBe('측정 불가');
      expect(gated.evidence.costPerSession).toBeNull();
      expect(gated.evidence.totalObservedCost).toBeNull();
      expect(renderedParts).not.toMatch(/(?:약\s*)?[\d,]+\s*토큰(?:\s*(?:낭비|절약))?/u);
      expect(renderedParts).not.toContain('절약은 작지만');
      expect(gated.reason).toBe(joinReason(gated.reasonParts));
    },
  );

  it('redacts token claims wherever they occur in structured reason text', () => {
    const original = recommendation('filter-server');
    original.reasonParts = {
      ...original.reasonParts,
      serverBasis: '서버 github 정의 1,200토큰, 10툴 중 1개만 사용',
      effect: '절약은 작지만 검색 공간 정리 효과',
    };
    original.reason = joinReason(original.reasonParts);

    const gated = gateRecommendation(original, health('hook-only'));

    expect(gated.reasonParts.serverBasis).toBe('서버 github 정의 토큰 측정 불가, 10툴 중 1개만 사용');
    expect(gated.reasonParts.effect).toBe('검색 공간 정리 효과');
    expect(gated.reason).toBe(joinReason(gated.reasonParts));
  });

  it('returns the existing recommendation unchanged when collection is healthy', () => {
    const original = recommendation('remove');

    expect(gateRecommendation(original, health('healthy'))).toBe(original);
  });

  it.each(['idle', 'log-only'] as const)(
    'does not alter recommendations under %s health',
    (value) => {
      const original = recommendation('remove');
      expect(gateRecommendation(original, health(value))).toBe(original);
    },
  );
});
