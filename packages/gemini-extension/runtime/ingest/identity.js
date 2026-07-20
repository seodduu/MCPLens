import { createHash } from 'node:crypto';
/**
 * Serialize identity fields in a fixed order. JSON object key insertion order
 * is not part of the caller contract, so hashing the object directly would
 * produce different ids for semantically identical inputs.
 */
const canonicalIdentity = (input) => [
    input.client,
    input.externalSessionId,
    input.externalTurnId,
    input.externalCallId,
    input.phase,
    input.toolName,
    input.inputFingerprint,
];
const digest = (prefix, value) => `${prefix}${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
export function makeDeliveryId(input) { return digest(input.externalCallId ? 'native:' : 'fallback:', canonicalIdentity(input)); }
export function makeCorrelationKey(input) {
    return input.externalCallId
        ? digest('native:', [input.client, input.externalSessionId, input.externalTurnId, input.externalCallId])
        : digest('fallback:', canonicalIdentity(input));
}
//# sourceMappingURL=identity.js.map