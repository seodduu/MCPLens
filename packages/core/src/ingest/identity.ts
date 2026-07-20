import { createHash } from 'node:crypto';
import type { ClientId } from '../types.js';
export type IdentityInput = { client: ClientId; externalSessionId: string; externalTurnId: string | null; externalCallId: string | null; phase: string; toolName: string | null; inputFingerprint: string | null };
/**
 * Serialize identity fields in a fixed order. JSON object key insertion order
 * is not part of the caller contract, so hashing the object directly would
 * produce different ids for semantically identical inputs.
 */
const canonicalIdentity = (input: IdentityInput): readonly unknown[] => [
  input.client,
  input.externalSessionId,
  input.externalTurnId,
  input.externalCallId,
  input.phase,
  input.toolName,
  input.inputFingerprint,
];
const digest = (prefix: string, value: readonly unknown[]) => `${prefix}${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
export function makeDeliveryId(input: IdentityInput): string { return digest(input.externalCallId ? 'native:' : 'fallback:', canonicalIdentity(input)); }
export function makeCorrelationKey(input: IdentityInput): string {
  return input.externalCallId
    ? digest('native:', [input.client, input.externalSessionId, input.externalTurnId, input.externalCallId])
    : digest('fallback:', canonicalIdentity(input));
}
