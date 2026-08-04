import type { InferenceBatch, InferenceServerInput } from './types.js';

function serverTokens(server: InferenceServerInput): number {
  return server.tools.reduce((sum, tool) => sum + tool.definitionTokens, 0);
}

function sortedServers(servers: readonly InferenceServerInput[]): InferenceServerInput[] {
  return [...servers].sort((a, b) => a.serverName.localeCompare(b.serverName));
}

function batchId(index: number): string {
  return `batch-${String(index + 1).padStart(3, '0')}`;
}

export function planInferenceBatches(
  servers: readonly InferenceServerInput[],
  maxPayloadTokens: number,
): InferenceBatch[] {
  if (!Number.isFinite(maxPayloadTokens) || maxPayloadTokens <= 0) {
    throw new Error('maxPayloadTokens must be a positive finite number');
  }

  const batches: InferenceBatch[] = [];
  let current: InferenceServerInput[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length === 0) return;
    batches.push({
      batchId: batchId(batches.length),
      servers: current,
      payloadTokens: currentTokens,
      oversized: false,
    });
    current = [];
    currentTokens = 0;
  };

  for (const server of sortedServers(servers)) {
    const tokens = serverTokens(server);
    if (tokens > maxPayloadTokens) {
      flush();
      batches.push({
        batchId: batchId(batches.length),
        servers: [server],
        payloadTokens: tokens,
        oversized: true,
      });
      continue;
    }

    if (current.length > 0 && currentTokens + tokens > maxPayloadTokens) flush();
    current.push(server);
    currentTokens += tokens;
  }

  flush();
  return batches;
}
