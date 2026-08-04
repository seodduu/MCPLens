import { describe, expect, it, vi } from 'vitest';
import { buildConsentDialog, readProviderConfig, requestInferenceConsent, resolveProvider, withdrawConsent } from '../src/inferenceConsent.js';

const estimate = {
  inputTokens: { min: 1_200, max: 2_400 },
  outputTokens: { min: 1_000, max: 2_000 },
  totalUsd: { min: 0.00144, max: 0.00288 },
  rateDate: '2026-08-03',
  disclaimer: 'Rates are API-equivalent estimates dated 2026-08-03; actual CLI billing may differ.',
} as const;

describe('inference consent', () => {
  it('does not persist consent until an explicit accept and renders complete boundaries in English', () => {
    const dialog = buildConsentDialog({ provider: 'claude', model: 'haiku', estimate });
    expect(dialog.canPersist).toBe(false);
    expect(dialog.title).toBe('Allow dependency analysis?');
    expect(dialog.detail).toContain('Selected provider and model: claude / haiku.');
    expect(dialog.detail).toContain('Estimated input tokens: 1,200–2,400.');
    expect(dialog.detail).toContain('Estimated output tokens: 1,000–2,000.');
    expect(dialog.detail).toContain('Estimated API-equivalent cost: $0.001440–$0.002880 (rates dated 2026-08-03).');
    expect(dialog.detail).toContain('Actual billing depends on your CLI account and plan.');
    expect(dialog.detail).toContain(estimate.disclaimer);
    expect(dialog.detail).toContain('Data sent for analysis: MCP tool definitions and aggregated usage statistics.');
    expect(dialog.detail).toContain('Data never sent for analysis: prompts, tool inputs, tool outputs, source code, project paths, credentials.');
    expect(dialog.detail).toContain('Cache is reused only for the same server definition set and analysis rules version; it is invalidated when definitions or rules change.');
    expect(dialog.detail).toContain('You can withdraw consent at any time from MCP Lens.');
    expect(`${dialog.title}\n${dialog.detail}`).not.toMatch(/[가-힣]/);
  });

  it('passes modal detail to the prompt boundary and only accepts the exact Accept action', async () => {
    const prompt = vi.fn().mockResolvedValue('Accept');
    const clock = vi.fn(() => '2026-08-03T00:00:00Z');
    const consent = await requestInferenceConsent(
      { provider: 'codex', model: 'gpt-5.6-luna', estimate },
      prompt,
      clock,
    );

    const dialog = buildConsentDialog({ provider: 'codex', model: 'gpt-5.6-luna', estimate });
    expect(prompt).toHaveBeenCalledWith(dialog.title, { modal: true, detail: dialog.detail }, 'Accept');
    expect(clock).toHaveBeenCalledTimes(1);
    expect(consent).toEqual({ policyVersion: 1, provider: 'codex', model: 'gpt-5.6-luna', status: 'accepted', acceptedAt: '2026-08-03T00:00:00Z', revokedAt: null });
  });

  it.each([undefined, 'Cancel', 'accepts'])('returns null when the prompt result is %j', async (choice) => {
    const prompt = vi.fn().mockResolvedValue(choice);
    const clock = vi.fn(() => '2026-08-03T00:00:00Z');
    await expect(requestInferenceConsent({ provider: 'claude', model: 'haiku', estimate }, prompt, clock)).resolves.toBeNull();
    expect(clock).not.toHaveBeenCalled();
  });

  it('requires a choice in auto mode when both CLIs are available and stores that choice on acceptance', () => {
    expect(resolveProvider({ provider: 'auto', claudeModel: 'haiku', codexModel: 'gpt-5.6-luna' }, { claude: true, codex: true })).toMatchObject({ kind: 'choose', choices: ['claude', 'codex'] });
    expect(buildConsentDialog({ provider: 'codex', model: 'gpt-5.6-luna', estimate }).accept('2026-08-03T00:00:00Z')).toEqual({ policyVersion: 1, provider: 'codex', model: 'gpt-5.6-luna', status: 'accepted', acceptedAt: '2026-08-03T00:00:00Z', revokedAt: null });
  });

  it('uses defaults and automatically resolves only one available CLI', () => {
    const config = readProviderConfig({ get: <T>(key: string, fallback: T) => fallback });
    expect(config).toEqual({ provider: 'auto', claudeModel: 'haiku', codexModel: 'gpt-5.6-luna' });
    expect(resolveProvider(config, { claude: false, codex: true })).toEqual({ kind: 'resolved', provider: 'codex', model: 'gpt-5.6-luna' });
  });

  it('revokes only future inference consent without deleting the accepted record', () => {
    const accepted = buildConsentDialog({ provider: 'claude', model: 'haiku', estimate })
      .accept('2026-08-03T00:00:00Z');
    expect(withdrawConsent(accepted, '2026-08-04T00:00:00Z')).toEqual({
      ...accepted, status: 'revoked', revokedAt: '2026-08-04T00:00:00Z',
    });
  });
});
