// packages/core/src/index.ts
export * from './types.js';
export * from './ingest/contracts.js';
export * from './ingest/identity.js';
export * from './ingest/coordinator.js';
export * from './ingest/lease.js';
export * from './health/collectionHealth.js';
export * from './dependency/analyzer.js';
export * from './dependency/eligibility.js';
export * from './dependency/rollout.js';
export * from './dependency/schemaFlow.js';
export * from './dependency/stateConsumer.js';
export * from './dependency/reanalysisTrigger.js';
export * from './inference/costEstimate.js';
export * from './paths.js';
export { countTokens } from './tokenize.js';
export * from './engine/engine.js';
export * from './engine/evidence.js';
export * from './engine/cost.js';
export * from './engine/serverVerdict.js';
export * from './report/index.js';
export { ClaudeAdapter } from './adapters/claude/adapter.js';
export { CodexAdapter } from './adapters/codex/adapter.js';
export { GeminiAdapter, splitFlattenedName } from './adapters/gemini/adapter.js';
export { LensStore } from './store/store.js';
export { materializeSession } from './store/observations.js';
export type { CollectorReceipt, ServerScanStatus, ServerScanStatusKind } from './store/store.js';
export { scanServer } from './scanner/scanner.js';
export { applyClaudeGlobalDeny, restoreClaudeGlobalDeny, claudeDenyRule, type ActionFileSystem, type ActionMutation, type ActionRequest } from './actions/claude.js';
export { applyCodexDisabledTool, restoreCodexDisabledTool } from './actions/codex.js';
export {
  loadStoredOAuth,
  saveStoredOAuth,
  clearStoredOAuth,
  storedTokenProvider,
  authenticateServer,
  startCallbackServer,
  readOAuthClients,
  saveOAuthClient,
  oauthClientsFile,
  ClientRegistrationRequiredError,
  type StoredOAuth,
  type CallbackServer,
  type PreregisteredClient,
} from './scanner/oauth.js';
export { readClaudeMcpConfig, specTransport, type McpServerSpec } from './scanner/configs.js';
export { collectServerSpecs, type CollectResult } from './scanner/configs.js';
export { configSources, collectFromSource, collectAllSpecs, collectFromSources, type ConfigSource } from './scanner/sources.js';
export { clientForSourceKind, attributeServers, type SourceRead } from './scanner/attribution.js';
export { detectClients, type ClientStatus } from './detect/detector.js';
export { LogWatcher } from './watch/watcher.js';
export { claudeSettingsPath, mcpDenyRule, readDeniedMcpTools, denyMcpTool, allowMcpTool } from './permissions/claudeSettings.js';
export { defaultClaudeConfigPaths, listManagedServers, disableServer, enableServer, type ClaudeConfigPaths, type ManagedServer, type StashedServer, type StashOrigin } from './permissions/claudeServers.js';
