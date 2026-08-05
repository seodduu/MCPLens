import type { CollectionHealthSnapshot } from '../health/collectionHealth.js';
import type { Recommendation } from '../types.js';
import { joinReason } from './engine.js';

const COLLECTION_HEALTH_CAVEAT = 'collection health is low, not a confirmed recommendation';

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
      evidenceLabel: 'not measurable',
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
    .replace(/small savings, but\s*/gu, '')
    .replace(/(?:about\s*)?\d[\d,]*\s*tokens?(?:\s+(?:wasted|saved))?/gu, 'token count unavailable')
    .replace(/tokens?\s+(?:wasted|saved)/gu, 'token count unavailable');
}
