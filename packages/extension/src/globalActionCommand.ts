import { randomUUID } from 'node:crypto';
import {
  actionEligibility, type ActionMutation, type GlobalAction,
  type EligibilityResult, type GlobalActionClient, type LensStore,
} from '@mcp-lens/core';

export interface GlobalActionTarget {
  client: GlobalActionClient;
  serverName: string;
  toolName: string;
  definitionSetHash: string;
}

export interface DisableGloballyInput {
  store: LensStore;
  target: GlobalActionTarget;
  apply: () => Promise<ActionMutation>;
  refresh?: () => void;
  createAction?: () => GlobalAction;
  /** The extension rollout gate is deliberately required; a missing value blocks. */
  rolloutAllowed?: boolean;
  analysisRulesVersion?: number;
}

export interface RestoreGloballyInput {
  store: LensStore;
  action: GlobalAction;
  restore: () => Promise<ActionMutation>;
  rolloutAllowed?: boolean;
}

export type GlobalActionCommandResult = { ok: true } | { ok: false; message: string };

function currentDefinition(input: DisableGloballyInput): boolean {
  const bodies = input.store.definitionBodiesForServer(input.target.serverName);
  return bodies.some((body) => body.toolName === input.target.toolName
    && body.definitionSetHash === input.target.definitionSetHash);
}

function identityIsSafe(store: LensStore, serverName: string, client?: GlobalActionClient): boolean {
  const rows = store.serverIdentities(serverName);
  const targetRows = client === undefined ? rows : rows.filter((row) => row.client === client);
  return rows.length > 0 && targetRows.length > 0
    && rows.every((row) => row.conflictState === 'clear')
    && new Set(rows.map((row) => row.endpointHash)).size === 1
    && targetRows.every((row) => row.conflictState === 'clear')
    && new Set(targetRows.map((row) => row.endpointHash)).size === 1;
}

/** Reassembles every eligibility input from the store right before the mutation. */
export function currentActionEligibility(
  store: LensStore,
  target: GlobalActionTarget,
  analysisRulesVersion: number,
): EligibilityResult {
  const bodies = store.definitionBodiesForServer(target.serverName);
  const body = bodies.find((row) => row.toolName === target.toolName
    && row.definitionSetHash === target.definitionSetHash);
  const analysis = body && store.findDependencyAnalysis(body.definitionSetHash, analysisRulesVersion);
  const result = analysis?.results.find((row) => row.serverName === target.serverName
    && row.toolName === target.toolName);
  const identities = store.serverIdentities(target.serverName);
  const clientHasServer = store.serversByClient().get(target.client)?.has(target.serverName) === true;
  const identityConflictState = clientHasServer && identities.length > 0
    && identityIsSafe(store, target.serverName, target.client)
    ? 'clear' : 'conflict';
  return actionEligibility({
    analysisStatus: result?.status ?? 'Review required',
    identityConflictState,
    hasDefinitionBody: body !== undefined,
    hasActiveAction: store.activeActionFor(target.client, target.serverName, target.toolName) !== null,
    client: target.client,
  });
}

export async function disableGlobally(input: DisableGloballyInput): Promise<GlobalActionCommandResult> {
  if (input.rolloutAllowed !== true) {
    input.refresh?.();
    return { ok: false, message: 'Global actions are not enabled for this rollout.' };
  }
  if (!currentDefinition(input)) {
    input.refresh?.();
    return { ok: false, message: 'Analysis is stale. Refreshing the tree.' };
  }
  if (!identityIsSafe(input.store, input.target.serverName, input.target.client)
    || input.store.serversByClient().get(input.target.client)?.has(input.target.serverName) !== true) {
    input.refresh?.();
    return { ok: false, message: 'Server identity conflict prevents this global action.' };
  }
  if (input.store.activeActionFor(input.target.client, input.target.serverName, input.target.toolName)) {
    return { ok: false, message: 'This tool is already disabled globally.' };
  }
  if (!currentActionEligibility(input.store, input.target, input.analysisRulesVersion ?? -1).eligible) {
    input.refresh?.();
    return { ok: false, message: 'This tool is no longer eligible for a global action. Refreshing the tree.' };
  }
  const mutation = await input.apply();
  if (mutation.status !== 'applied' || !mutation.backupPath || !mutation.preFingerprint || !mutation.postFingerprint) {
    return { ok: false, message: 'MCP Lens could not apply the global action.' };
  }
  const action = input.createAction?.() ?? {
    actionId: randomUUID(), client: input.target.client, serverName: input.target.serverName,
    toolName: input.target.toolName, identityHash: input.store.serverIdentities(input.target.serverName)[0]!.endpointHash,
    definitionSetHash: input.target.definitionSetHash, ownedRule: mutation.rule, backupPath: mutation.backupPath,
    preFingerprint: mutation.preFingerprint, postFingerprint: mutation.postFingerprint,
    status: 'active' as const, createdAt: new Date().toISOString(), restoredAt: null,
  };
  input.store.recordGlobalAction(action);
  input.store.save();
  input.refresh?.();
  return { ok: true };
}

export async function restoreGlobally(input: RestoreGloballyInput): Promise<GlobalActionCommandResult> {
  if (input.rolloutAllowed !== true) {
    return { ok: false, message: 'Global actions are not enabled for this rollout.' };
  }
  const mutation = await input.restore();
  if (mutation.status === 'restored') {
    input.store.updateGlobalActionStatus(input.action.actionId, 'restored', new Date().toISOString());
    input.store.save();
    return { ok: true };
  }
  if (mutation.status === 'conflict') {
    input.store.updateGlobalActionStatus(input.action.actionId, 'conflict');
    input.store.save();
    return { ok: false, message: 'Configuration changed outside MCP Lens. Restore was not applied.' };
  }
  return { ok: false, message: 'MCP Lens could not restore the global action.' };
}

export function restoreRecommended(store: LensStore, action: GlobalAction): boolean {
  const signals = store.regretSignals(action.actionId);
  if (signals.some((signal) => signal.kind === 'direct')) return true;
  return new Set(signals.filter((signal) => signal.kind === 'indirect').map((signal) => signal.sessionId)).size >= 2;
}
