import type { ToolObservation } from '../ingest/contracts.js';
import type { GlobalAction, RegretSignal } from '../types.js';

const isAtOrAfter = (observedAt: string, createdAt: string): boolean => {
  const observed = Date.parse(observedAt);
  const created = Date.parse(createdAt);
  return Number.isFinite(observed) && Number.isFinite(created) && observed >= created;
};

export function directClaudeRegretSignals(
  actions: readonly GlobalAction[],
  observation: ToolObservation,
): RegretSignal[] {
  if (
    observation.client !== 'claude-code'
    || observation.serverName === null
    || observation.toolName === null
    || !isDirectAttemptEvidence(observation)
  ) {
    return [];
  }

  return actions
    .filter((action) => (
      action.client === 'claude-code'
      && action.status === 'active'
      && action.serverName === observation.serverName
      && action.toolName === observation.toolName
      && isAtOrAfter(observation.observedAt, action.createdAt)
    ))
    .map((action) => ({
      actionId: action.actionId,
      kind: 'direct',
      sessionId: observation.externalSessionId,
      observedAt: observation.observedAt,
    }));
}

function isDirectAttemptEvidence(observation: ToolObservation): boolean {
  return (observation.source === 'hook' && observation.phase === 'tool-before')
    || (observation.source === 'log'
      && (observation.phase === 'tool-failure' || observation.phase === 'tool-after'));
}
