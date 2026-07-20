import type { CollectionHealthSnapshot } from '../health/collectionHealth.js';
import type { Recommendation } from '../types.js';
import { joinReason } from './engine.js';

const COLLECTION_HEALTH_CAVEAT = '수집 건강도 낮음, 확정 권고 아님';

/** Applies collection-quality safeguards without changing recommendation actions. */
export function gateRecommendation(
  recommendation: Recommendation,
  health: CollectionHealthSnapshot,
): Recommendation {
  if (health.health === 'healthy' || health.health === 'idle' || health.health === 'log-only') {
    return recommendation;
  }

  let gated = recommendation;
  if (health.health === 'hook-only') {
    const reasonParts = {
      basis: redactTokenClaims(recommendation.reasonParts.basis),
      serverBasis: redactTokenClaims(recommendation.reasonParts.serverBasis),
      effect: redactTokenClaims(recommendation.reasonParts.effect),
      caveat: redactTokenClaims(recommendation.reasonParts.caveat),
    };
    gated = {
      ...recommendation,
      reasonParts,
      reason: joinReason(reasonParts),
      evidenceLabel: '측정 불가',
      evidence: {
        ...recommendation.evidence,
        costPerSession: null,
        totalObservedCost: null,
      },
    };
  }

  const destructive = gated.action === 'remove' || gated.action === 'filter-server';
  const lowCollectionConfidence = health.health === 'degraded' || health.health === 'unavailable';
  if (!destructive || !lowCollectionConfidence) return gated;

  const reasonParts = {
    ...gated.reasonParts,
    caveat: appendCaveat(gated.reasonParts.caveat, COLLECTION_HEALTH_CAVEAT),
  };
  return {
    ...gated,
    confidence: 'low',
    reasonParts,
    reason: joinReason(reasonParts),
  };
}

function appendCaveat(existing: string | null, caveat: string): string {
  if (existing === null || existing.length === 0) return caveat;
  if (existing.includes(caveat)) return existing;
  return `${existing}; ${caveat}`;
}

function redactTokenClaims(text: string): string;
function redactTokenClaims(text: string | null): string | null;
function redactTokenClaims(text: string | null): string | null {
  if (text === null) return null;
  return text
    .replace(/절약은 작지만\s*/gu, '')
    .replace(/(?:약\s*)?[\d,]+\s*토큰(?:\s*(?:낭비|절약))?/gu, '토큰 측정 불가')
    .replace(/토큰\s*(?:낭비|절약)/gu, '토큰 측정 불가');
}
