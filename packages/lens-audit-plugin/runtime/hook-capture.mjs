import { createHash } from 'node:crypto';
import { decodeClaudeHook } from './ingest/clients/claude/decoder.js';
import { decodeCodexHook } from './ingest/clients/codex/decoder.js';
import { decodeGeminiHook } from './ingest/clients/gemini/decoder.js';
import { enqueueEnvelope } from './ingest/inbox.js';

const decoders = {
  claude: decodeClaudeHook,
  codex: decodeCodexHook,
  gemini: decodeGeminiHook,
};

const MAX_STDIN_BYTES = 1024 * 1024;
const STDIN_DEADLINE_MS = 1_500;

function envelopeFromObservation(observation) {
  const deliveryId = observation.externalCallId === null
    ? createHash('sha256')
      .update(`${observation.deliveryId}\0${observation.observedAt}`)
      .digest('hex')
    : observation.deliveryId;
  return {
    schemaVersion: observation.schemaVersion,
    deliveryId,
    client: observation.client,
    phase: observation.phase,
    receivedAt: observation.receivedAt,
    externalSessionId: observation.externalSessionId,
    externalTurnId: observation.externalTurnId,
    externalCallId: observation.externalCallId,
    transcriptPath: observation.transcriptPath,
    serverName: observation.serverName,
    toolName: observation.toolName,
    observedAt: observation.observedAt,
    durationMs: observation.durationMs,
    isError: observation.isError,
    inputFingerprint: observation.inputFingerprint,
  };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    let timer;

    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
      process.stdin.pause();
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_STDIN_BYTES) {
        settle(reject, new RangeError('hook payload exceeds 1 MiB'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => settle(resolve, Buffer.concat(chunks).toString('utf8'));
    const onError = (error) => settle(reject, error);

    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
    timer = setTimeout(
      () => settle(reject, new Error('hook stdin timed out')),
      STDIN_DEADLINE_MS,
    );
    process.stdin.resume();
  });
}

export async function runHookCapture(client) {
  try {
    const decoder = decoders[client];
    if (!decoder) throw new Error(`unsupported hook client: ${client}`);
    const raw = await readStdin();
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = raw;
    }
    const result = decoder(payload, new Date().toISOString());
    if (result.kind === 'observation') {
      const root = process.env.MCP_LENS_INBOX_DIR;
      enqueueEnvelope(
        envelopeFromObservation(result.observation),
        root ? { root } : undefined,
      );
    } else if (result.kind === 'invalid') {
      console.error(`mcp-lens hook ignored invalid payload: ${result.code}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`mcp-lens hook capture failed: ${message}`);
  } finally {
    process.stdout.write('{}\n');
  }
}
