import { describe, expect, it } from 'vitest';
import { joinReason } from '../../src/engine/engine.js';
import { gateRecommendation } from '../../src/engine/healthGate.js';
import type { CollectionHealthSnapshot } from '../../src/health/collectionHealth.js';
import type { Recommendation } from '../../src/types.js';

function recommendation(action: Recommendation['action']): Recommendation {
  const reasonParts: Recommendation['reasonParts'] = action === 'inspect'
    ? {
        basis: '3 of 4 calls failed (75%), 120 tokens wasted on failed responses',
        serverBasis: null,
        effect: 'inspect or replace',
        caveat: null,
      }
    : action === 'filter-server'
      ? {
          basis: '',
          serverBasis: 'Only 1 of 10 tools used on server github. Tool filtering recommended.',
          effect: 'about 900 tokens saved per session when removed',
          caveat: null,
        }
      : action === 'remove'
        ? {
            basis: 'definition 900 tokens, 0 calls',
            serverBasis: null,
            effect: 'about 900 tokens saved per session when removed',
            caveat: null,
          }
        : action === 'keep'
          ? { basis: 'called 7 times', serverBasis: null, effect: null, caveat: null }
          : {
              basis: 'definition tokens unavailable (not covered by the scanner)',
              serverBasis: null,
              effect: null,
              caveat: null,
            };
  return {
    action,
    confidence: 'high',
    reason: joinReason(reasonParts),
    reasonParts,
    evidenceLabel: 'measured',
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
      expect(gated.reasonParts.caveat).toContain('collection health is low');
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
    expect(gated.evidenceLabel).toBe('not measurable');
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

      expect(gated.evidenceLabel).toBe('not measurable');
      expect(gated.evidence.costPerSession).toBeNull();
      expect(gated.evidence.totalObservedCost).toBeNull();
      expect(renderedParts).not.toMatch(/(?:about\s*)?\d[\d,]*\s*tokens?(?:\s+(?:wasted|saved))?/u);
      expect(renderedParts).not.toContain('small savings, but');
      expect(gated.reason).toBe(joinReason(gated.reasonParts));
    },
  );

  it('redacts token claims wherever they occur in structured reason text', () => {
    const original = recommendation('filter-server');
    original.reasonParts = {
      ...original.reasonParts,
      serverBasis: 'server github definition 1,200 tokens, only 1 of 10 tools used',
      effect: 'small savings, but cleans up the search space',
    };
    original.reason = joinReason(original.reasonParts);

    const gated = gateRecommendation(original, health('hook-only'));

    expect(gated.reasonParts.serverBasis).toBe('server github definition token count unavailable, only 1 of 10 tools used');
    expect(gated.reasonParts.effect).toBe('cleans up the search space');
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
