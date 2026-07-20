import { createHash } from 'node:crypto';
import type { ClientId } from '../types.js';
export type IdentityInput = { client: ClientId; externalSessionId: string; externalTurnId: string | null; externalCallId: string | null; phase: string; toolName: string | null; inputFingerprint: string | null };
const digest = (prefix: string, value: unknown) => `${prefix}${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
export function makeDeliveryId(input: IdentityInput): string { return digest(input.externalCallId ? 'native:' : 'fallback:', input); }
export function makeCorrelationKey(input: IdentityInput): string { return input.externalCallId ? digest('native:', { client: input.client, session: input.externalSessionId, turn: input.externalTurnId, call: input.externalCallId }) : digest('fallback:', input); }
