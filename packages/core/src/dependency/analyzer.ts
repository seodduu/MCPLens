import type { LensStore } from '../store/store.js';
import type { DependencyAnalysis, InferenceProvider, ToolDefinitionBody } from '../types.js';
import { findCallChainDependencies } from './callChains.js';
import type { DependencyEvidence } from './merge.js';
import { mergeDependencyResults } from './merge.js';
import { needsCallChainReanalysis } from './reanalysisTrigger.js';
import { findSchemaFlowDependencies } from './schemaFlow.js';
import { findStateConsumers, type StateConsumerScan } from './stateConsumer.js';
import { findStaticDependencyRefs } from './staticRefs.js';
import { planInferenceBatches } from '../inference/batchPlanner.js';
import type {
  InferenceBatch,
  InferenceCallChainSummary,
  InferenceServerInput,
  PredictedPrerequisite,
} from '../inference/types.js';
import { validateInferenceOutput } from '../inference/validate.js';

const PROVIDER_BUDGETS = {
  claude: 120_000,
  codex: 200_000,
} as const;

export type ResolvedInferenceProvider = Exclude<InferenceProvider, 'auto'> | 'unavailable';

export interface AnalyzeServersInput {
  store: LensStore;
  serverNames: readonly string[];
  analysisRulesVersion: number;
  consentPolicyVersion: number;
  provider: ResolvedInferenceProvider;
  model: string;
  reanalyzeServerNames?: readonly string[];
  /**
   * How many cached verdicts the call-chain trigger may wake in this run.
   * undefined means unlimited, which is the user-initiated path. The automatic path passes a
   * finite budget so that adding one server cannot silently re-analyze the whole cache.
   * Servers with no cached row at all are never charged against this budget.
   */
  maxTriggeredReanalyses?: number;
  /** User-initiated refreshes cancel in-flight external inference. */
  signal?: AbortSignal;
  now?: string;
}

export interface InferenceRunnerRequest {
  provider: Exclude<InferenceProvider, 'auto'>;
  model: string;
  batch: InferenceBatch;
  signal?: AbortSignal;
}

export type InferenceRunnerResult =
  | { ok: true; value: unknown }
  | { ok: false; errorCode: string };

export type InferenceRunner = (
  request: InferenceRunnerRequest,
) => Promise<InferenceRunnerResult>;

export interface AnalyzeServersResult {
  status: 'complete' | 'consent-required' | 'provider-unavailable';
  analyses: DependencyAnalysis[];
  cachedServerNames: string[];
  analyzedServerNames: string[];
  failedServerNames: string[];
  batchCount: number;
}

interface PendingServer {
  serverName: string;
  definitionSetHash: string;
  bodies: ToolDefinitionBody[];
  /**
   * Counted before the analysis runs. Counting again afterwards would store a number from a
   * later moment than the verdict was reached at, and the trigger compares against exactly this.
   */
  observedSessionCount: number;
  inference: InferenceServerInput;
}

export async function analyzeUncachedServers(
  input: AnalyzeServersInput,
  run: InferenceRunner,
): Promise<AnalyzeServersResult> {
  if (input.provider === 'unavailable') return emptyResult('provider-unavailable');

  const consent = input.store.currentInferenceConsent(input.consentPolicyVersion);
  if (
    consent === null
    || consent.status !== 'accepted'
    || consent.provider !== input.provider
    || consent.model !== input.model
  ) {
    return emptyResult('consent-required');
  }

  const now = input.now ?? new Date().toISOString();
  const serverNames = [...new Set(input.serverNames)].sort();
  const bodies = serverNames.flatMap((serverName) => input.store.definitionBodiesForServer(serverName));
  const staticRefs = findStaticDependencyRefs(bodies);
  const schemaFlow = findSchemaFlowDependencies(bodies);
  const stateScan = findStateConsumers(bodies);
  const callChains = findCallChainDependencies(
    input.store.dependencyCallsSince(daysBefore(now, 90)),
    { now },
  );
  const reanalyze = new Set(input.reanalyzeServerNames ?? []);
  const analyses: DependencyAnalysis[] = [];
  const cachedServerNames: string[] = [];
  const failedServerNames: string[] = [];
  const pending: PendingServer[] = [];
  const reanalysisBudget = input.maxTriggeredReanalyses ?? Number.POSITIVE_INFINITY;
  let triggeredReanalyses = 0;

  for (const serverName of serverNames) {
    const serverBodies = bodies.filter((body) => body.serverName === serverName);
    if (serverBodies.length === 0) continue;
    const definitionSetHash = oneDefinitionSetHash(serverName, serverBodies);
    const existing = input.store.findDependencyAnalysis(
      definitionSetHash,
      input.analysisRulesVersion,
    );
    const currentSessionCount = input.store.sessionCountForServer(serverName, daysBefore(now, 90));

    if (!reanalyze.has(serverName) && existing?.status === 'complete') {
      // The budget is checked only after the trigger fires, so a run full of settled servers
      // never consumes it. Order follows the sorted serverNames, which makes the choice
      // deterministic and therefore testable; no server starves, because a rerun raises its
      // stored count above the threshold and it stops being a candidate forever.
      const staleForCallChain = needsCallChainReanalysis({
        storedSessionCount: existing.observedSessionCount,
        currentSessionCount,
      });
      if (!staleForCallChain || triggeredReanalyses >= reanalysisBudget) {
        analyses.push(existing);
        cachedServerNames.push(serverName);
        continue;
      }
      triggeredReanalyses += 1;
    }

    // A failed analysis failed regardless of how many sessions have run since; retrying it is the
    // user's call through reanalyzeServerNames, not the trigger's.
    if (!reanalyze.has(serverName) && existing?.status === 'failed') {
      analyses.push(existing);
      failedServerNames.push(serverName);
      continue;
    }

    pending.push({
      serverName,
      definitionSetHash,
      bodies: serverBodies,
      observedSessionCount: currentSessionCount,
      inference: inferenceServer(serverName, serverBodies, staticRefs, callChains, stateScan),
    });
  }

  const byServer = new Map(pending.map((server) => [server.serverName, server]));
  const batches = planInferenceBatches(
    pending.map((server) => server.inference),
    PROVIDER_BUDGETS[input.provider],
  );
  const analyzedServerNames: string[] = [];

  for (const batch of batches) {
    if (input.signal?.aborted) break;
    let runnerResult: InferenceRunnerResult;
    try {
      runnerResult = await run({
        provider: input.provider,
        model: input.model,
        batch,
        signal: input.signal,
      });
    } catch {
      runnerResult = { ok: false, errorCode: 'runner-error' };
    }

    // If the user cancelled this generation, not even a failure cache is left behind.
    // The coordinator likewise skips store.save() afterwards.
    if (input.signal?.aborted) break;

    if (!runnerResult.ok) {
      for (const server of batch.servers) {
        const pendingServer = byServer.get(server.serverName)!;
        const failed = failedAnalysis(
          input.analysisRulesVersion,
          input.provider,
          input.model,
          pendingServer.definitionSetHash,
          now,
          runnerResult.errorCode,
        );
        input.store.saveDependencyAnalysis(failed);
        analyses.push(failed);
        failedServerNames.push(server.serverName);
      }
      continue;
    }

    let validated;
    try {
      validated = validateInferenceOutput(batch, runnerResult.value);
    } catch {
      for (const server of batch.servers) {
        const pendingServer = byServer.get(server.serverName)!;
        const failed = failedAnalysis(
          input.analysisRulesVersion,
          input.provider,
          input.model,
          pendingServer.definitionSetHash,
          now,
          'schema-mismatch',
        );
        input.store.saveDependencyAnalysis(failed);
        analyses.push(failed);
        failedServerNames.push(server.serverName);
      }
      continue;
    }

    for (const server of batch.servers) {
      const pendingServer = byServer.get(server.serverName)!;
      const analysis: DependencyAnalysis = {
        definitionSetHash: pendingServer.definitionSetHash,
        analysisRulesVersion: input.analysisRulesVersion,
        provider: input.provider,
        model: input.model,
        status: 'complete',
        analyzedAt: now,
        errorCode: null,
        observedSessionCount: pendingServer.observedSessionCount,
        results: mergeDependencyResults({
          bodies: pendingServer.bodies,
          staticRefs: staticRefs.filter((row) => row.serverName === server.serverName),
          callChains: callChains.filter((row) => row.serverName === server.serverName),
          schemaFlow: schemaFlow.filter((row) => row.serverName === server.serverName),
          stateFlow: stateScan.evidence.filter((row) => row.serverName === server.serverName),
          llmPrereqs: prerequisiteEvidence(
            server.serverName,
            prerequisitesOfServer(server, validated.predictedPrerequisites),
          ),
          llmResults: validated.results.filter((row) => row.serverName === server.serverName),
        }),
      };
      input.store.saveDependencyAnalysis(analysis);
      analyses.push(analysis);
      analyzedServerNames.push(server.serverName);
    }
  }

  return {
    status: 'complete',
    analyses: analyses.sort(compareAnalyses),
    cachedServerNames: cachedServerNames.sort(),
    analyzedServerNames: analyzedServerNames.sort(),
    failedServerNames: failedServerNames.sort(),
    batchCount: batches.length,
  };
}

/** The batch carries no server name on a prerequisite, so ownership comes from the tool list. */
function prerequisitesOfServer(
  server: InferenceServerInput,
  prerequisites: readonly PredictedPrerequisite[],
): PredictedPrerequisite[] {
  const owned = new Set(server.tools.map((tool) => tool.toolName));
  return prerequisites.filter((entry) => owned.has(entry.toolName));
}

/** {toolName: B, requires: [A]} means A is needed by B, so the evidence lands on A. */
function prerequisiteEvidence(
  serverName: string,
  prerequisites: readonly PredictedPrerequisite[],
): DependencyEvidence[] {
  const byTool = new Map<string, DependencyEvidence>();
  for (const entry of prerequisites)
    for (const required of entry.requires) {
      const current = byTool.get(required)
        ?? { serverName, toolName: required, dependedOnBy: [], evidence: [] };
      if (!current.dependedOnBy.includes(entry.toolName)) current.dependedOnBy.push(entry.toolName);
      const reason = `llm-prereq:${entry.toolName}`;
      if (!current.evidence.includes(reason)) current.evidence.push(reason);
      byTool.set(required, current);
    }
  return [...byTool.values()].map((row) => ({
    ...row,
    dependedOnBy: row.dependedOnBy.sort(),
    evidence: row.evidence.sort(),
  })).sort((a, b) => a.toolName.localeCompare(b.toolName));
}

function inferenceServer(
  serverName: string,
  bodies: readonly ToolDefinitionBody[],
  staticRefs: readonly DependencyEvidence[],
  callChains: readonly DependencyEvidence[],
  stateScan: StateConsumerScan,
): InferenceServerInput {
  return {
    serverName,
    stateConsumers: stateScan.hintsByServer[serverName] ?? [],
    tools: bodies.map((body) => ({
      toolName: body.toolName,
      description: body.description,
      inputSchemaJson: body.inputSchemaJson,
      definitionTokens: body.definitionTokens,
      staticReferences: evidenceFor(staticRefs, body).flatMap((row) => row.dependedOnBy).sort(),
      callChainSummary: callChainSummaries(evidenceFor(callChains, body)),
    })),
  };
}

function evidenceFor(
  evidence: readonly DependencyEvidence[],
  body: ToolDefinitionBody,
): DependencyEvidence[] {
  return evidence.filter((row) => row.serverName === body.serverName && row.toolName === body.toolName);
}

function callChainSummaries(evidence: readonly DependencyEvidence[]): InferenceCallChainSummary[] {
  return evidence.flatMap((row) => row.evidence.flatMap((item) => {
    const match = /^call-chain:(.+):(\d+)\/(\d+)$/.exec(item);
    if (match === null) return [];
    const sessionCount = Number(match[3]);
    return [{
      targetServerName: row.serverName,
      targetToolName: match[1]!,
      sessionCount,
      beforeRate: Number(match[2]) / sessionCount,
    }];
  })).sort((a, b) => a.targetServerName.localeCompare(b.targetServerName)
    || a.targetToolName.localeCompare(b.targetToolName));
}

function oneDefinitionSetHash(serverName: string, bodies: readonly ToolDefinitionBody[]): string {
  const hashes = [...new Set(bodies.map((body) => body.definitionSetHash))];
  if (hashes.length !== 1) {
    throw new Error(`server ${serverName} has inconsistent definition set hashes`);
  }
  return hashes[0]!;
}

function failedAnalysis(
  analysisRulesVersion: number,
  provider: Exclude<ResolvedInferenceProvider, 'unavailable'>,
  model: string,
  definitionSetHash: string,
  analyzedAt: string,
  errorCode: string,
): DependencyAnalysis {
  return {
    definitionSetHash,
    analysisRulesVersion,
    provider,
    model,
    status: 'failed',
    analyzedAt,
    errorCode,
    observedSessionCount: 0,
    results: [],
  };
}

function daysBefore(now: string, days: number): string {
  return new Date(Date.parse(now) - days * 24 * 60 * 60 * 1000).toISOString();
}

function emptyResult(status: AnalyzeServersResult['status']): AnalyzeServersResult {
  return {
    status,
    analyses: [],
    cachedServerNames: [],
    analyzedServerNames: [],
    failedServerNames: [],
    batchCount: 0,
  };
}

function compareAnalyses(a: DependencyAnalysis, b: DependencyAnalysis): number {
  const aServer = a.results[0]?.serverName ?? '';
  const bServer = b.results[0]?.serverName ?? '';
  return aServer.localeCompare(bServer) || a.definitionSetHash.localeCompare(b.definitionSetHash);
}
