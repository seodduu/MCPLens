import { describe, expect, it } from 'vitest';
import { makeCorrelationKey, makeDeliveryId } from '../../src/ingest/identity.js';
import { LensStore } from '../../src/store/store.js';
describe('hook observation contract', () => { it('stable native ids', () => { const base = { client: 'codex' as const, externalSessionId: 's1', externalTurnId: 't1', externalCallId: 'c1', phase: 'tool-after', toolName: 'mcp__github__get_issue', inputFingerprint: null }; expect(makeDeliveryId(base)).toBe(makeDeliveryId(base)); expect(makeCorrelationKey(base)).toMatch(/^native:/); }); it('creates tables', async () => { const store = await LensStore.open(':memory:'); expect(store.observationCount()).toBe(0); store.close(); }); });
