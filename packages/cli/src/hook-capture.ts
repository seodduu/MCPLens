import type {
  ClientId,
  HookDecoder,
  HookNormalizationResult,
} from '@mcp-lens/core';
import { decodeClaudeHook } from '@mcp-lens/core/dist/ingest/clients/claude/decoder.js';
import { decodeCodexHook } from '@mcp-lens/core/dist/ingest/clients/codex/decoder.js';
import { decodeGeminiHook } from '@mcp-lens/core/dist/ingest/clients/gemini/decoder.js';
import {
  enqueueEnvelope,
  type InboxOptions,
} from '@mcp-lens/core/dist/ingest/inbox.js';

const MAX_INPUT_BYTES = 1024 * 1024;

export interface CaptureResult {
  stdout: '{}\n';
  exitCode: 0;
}

export interface CaptureReceipt {
  client: ClientId;
  kind: 'hook-capture';
  status: 'invalid' | 'ignored' | 'queued' | 'duplicate';
  observedAt: string;
  errorCode?: string;
}

export interface CaptureDependencies {
  inbox?: InboxOptions;
  decoders?: Record<ClientId, HookDecoder>;
  enqueue?: typeof enqueueEnvelope;
  recordReceipt?: (receipt: CaptureReceipt) => void;
  /** Deliberately unused: tests can prove capture never opens a store. */
  openStore?: (...args: never[]) => unknown;
}

export const decoderRegistry: Record<ClientId, HookDecoder> = {
  'claude-code': decodeClaudeHook,
  codex: decodeCodexHook,
  'gemini-cli': decodeGeminiHook,
};

const SUCCESS: CaptureResult = { stdout: '{}\n', exitCode: 0 };

export function captureHook(
  client: ClientId,
  stdin: string | Uint8Array,
  now: Date | string,
  dependencies: CaptureDependencies = {},
): CaptureResult {
  const record = (receipt: CaptureReceipt): void => {
    try {
      dependencies.recordReceipt?.(receipt);
    } catch {
      // Hook capture is fail-open even when optional diagnostics fail.
    }
  };
  let observedAt: string;
  try {
    observedAt = typeof now === 'string' ? now : now.toISOString();
  } catch {
    return SUCCESS;
  }

  try {
    const byteLength = typeof stdin === 'string'
      ? Buffer.byteLength(stdin, 'utf8')
      : stdin.byteLength;
    if (byteLength > MAX_INPUT_BYTES) {
      record(invalidReceipt(client, observedAt, 'payload-too-large'));
      return SUCCESS;
    }

    const raw = typeof stdin === 'string' ? stdin : Buffer.from(stdin).toString('utf8');
    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      record(invalidReceipt(client, observedAt, 'invalid-json'));
      return SUCCESS;
    }

    const decoders: Record<ClientId, HookDecoder> = dependencies.decoders ?? decoderRegistry;
    const normalized = decoders[client](payload, observedAt);
    if (normalized.kind !== 'observation') {
      record(normalizationReceipt(client, observedAt, normalized));
      return SUCCESS;
    }

    const outcome = (dependencies.enqueue ?? enqueueEnvelope)(
      normalized.observation,
      dependencies.inbox,
    );
    record({
      client,
      kind: 'hook-capture',
      status: outcome,
      observedAt,
    });
  } catch {
    record(invalidReceipt(client, observedAt, 'capture-failed'));
  }

  return SUCCESS;
}

function invalidReceipt(
  client: ClientId,
  observedAt: string,
  errorCode: string,
): CaptureReceipt {
  return {
    client,
    kind: 'hook-capture',
    status: 'invalid',
    observedAt,
    errorCode,
  };
}

function normalizationReceipt(
  client: ClientId,
  observedAt: string,
  result: Exclude<HookNormalizationResult, { kind: 'observation' }>,
): CaptureReceipt {
  return {
    client,
    kind: 'hook-capture',
    status: result.kind,
    observedAt,
    errorCode: result.kind === 'invalid' ? result.code : result.reason,
  };
}
