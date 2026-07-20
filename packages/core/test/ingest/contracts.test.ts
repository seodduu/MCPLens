import { describe, expect, it } from 'vitest';
import { makeCorrelationKey, makeDeliveryId } from '../../src/ingest/identity.js';
import { LensStore } from '../../src/store/store.js';
describe('hook observation contract', () => { it('stable native ids', () => { const base = { client: 'codex' as const, externalSessionId: 's1', externalTurnId: 't1', externalCallId: 'c1', phase: 'tool-after', toolName: 'mcp__github__get_issue', inputFingerprint: null }; expect(makeDeliveryId(base)).toBe(makeDeliveryId(base)); expect(makeCorrelationKey(base)).toMatch(/^native:/); }); it('creates tables', async () => { const store = await LensStore.open(':memory:'); expect(store.observationCount()).toBe(0); store.close(); }); });
describe('hook identity canonicalization', () => {
  it('does not depend on caller property insertion order', () => {
    const first = { client: 'codex' as const, externalSessionId: 's1', externalTurnId: 't1', externalCallId: null, phase: 'tool-after', toolName: 'search', inputFingerprint: 'fp' };
    const reordered = { inputFingerprint: 'fp', toolName: 'search', phase: 'tool-after', externalCallId: null, externalTurnId: 't1', externalSessionId: 's1', client: 'codex' as const };
    expect(makeDeliveryId(first)).toBe(makeDeliveryId(reordered));
    expect(makeCorrelationKey(first)).toBe(makeCorrelationKey(reordered));
  });
});
