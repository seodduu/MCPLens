import { describe, expect, it, vi } from 'vitest';
import {
  AUTOMATION_ACCEPT_LABEL, AUTOMATION_PROMPT_DETAIL, AUTOMATION_SCAN_ONLY_LABEL,
  automationChoiceFrom, automationSettings, ensureAutomationConsent,
} from '../src/automationConsent.js';

describe('automationChoiceFrom', () => {
  it('turns on both scanning and analysis when both are accepted', () => {
    expect(automationChoiceFrom(AUTOMATION_ACCEPT_LABEL))
      .toEqual({ autoScan: true, autoAnalyze: true });
  });

  it('leaves analysis off when only scanning is chosen', () => {
    expect(automationChoiceFrom(AUTOMATION_SCAN_ONLY_LABEL))
      .toEqual({ autoScan: true, autoAnalyze: false });
  });

  // Reading "asked and dismissed" as approval would not be consent.
  it('treats dismissal (undefined) the same as a refusal', () => {
    expect(automationChoiceFrom(undefined))
      .toEqual({ autoScan: false, autoAnalyze: false });
  });

  it('treats an unknown answer as a refusal too', () => {
    expect(automationChoiceFrom('something'))
      .toEqual({ autoScan: false, autoAnalyze: false });
  });
});

describe('automationSettings', () => {
  it('converts autoScan into the string enum of the setting', () => {
    expect(automationSettings({ autoScan: true, autoAnalyze: true }))
      .toEqual({ autoScan: 'always', autoAnalyze: true });
    expect(automationSettings({ autoScan: false, autoAnalyze: false }))
      .toEqual({ autoScan: 'never', autoAnalyze: false });
  });
});

describe('consent wording', () => {
  // Automatic analysis spends the tokens of the user's account. Consent that hides that is not consent.
  it('states that tokens are spent and what is transmitted', () => {
    expect(AUTOMATION_PROMPT_DETAIL).toContain('spends that account');
    expect(AUTOMATION_PROMPT_DETAIL).toContain('tool definitions');
    expect(AUTOMATION_PROMPT_DETAIL).toContain('No LLM tokens are spent');   // it also states that scanning is free
  });

  it('says how to change it later', () => {
    expect(AUTOMATION_PROMPT_DETAIL).toContain('mcpLens.autoScan');
    expect(AUTOMATION_PROMPT_DETAIL).toContain('mcpLens.autoAnalyze');
  });
});

describe('ensureAutomationConsent', () => {
  const GLOBAL_TARGET = 1;

  function makeConfig(globalValue: unknown, update = vi.fn()) {
    return {
      inspect: (key: string) => key === 'autoAnalyze' ? { globalValue } : { globalValue: undefined },
      update,
    };
  }

  it('asks and returns true when autoAnalyze was never written and the user accepts', async () => {
    const update = vi.fn();
    const config = makeConfig(undefined, update);
    const ask = vi.fn().mockResolvedValue(AUTOMATION_ACCEPT_LABEL);

    const result = await ensureAutomationConsent(config, ask, GLOBAL_TARGET);

    expect(result).toBe(true);
    expect(update).toHaveBeenCalledWith('autoScan', 'always', GLOBAL_TARGET);
    expect(update).toHaveBeenCalledWith('autoAnalyze', true, GLOBAL_TARGET);
  });

  it('asks and returns false when the user picks scan only', async () => {
    const update = vi.fn();
    const config = makeConfig(undefined, update);
    const ask = vi.fn().mockResolvedValue(AUTOMATION_SCAN_ONLY_LABEL);

    const result = await ensureAutomationConsent(config, ask, GLOBAL_TARGET);

    expect(result).toBe(false);
    expect(update).toHaveBeenCalledWith('autoScan', 'always', GLOBAL_TARGET);
    expect(update).toHaveBeenCalledWith('autoAnalyze', false, GLOBAL_TARGET);
  });

  it('treats dismissal as refusal and writes it', async () => {
    const update = vi.fn();
    const config = makeConfig(undefined, update);
    const ask = vi.fn().mockResolvedValue(undefined);

    const result = await ensureAutomationConsent(config, ask, GLOBAL_TARGET);

    expect(result).toBe(false);
    expect(update).toHaveBeenCalledWith('autoScan', 'never', GLOBAL_TARGET);
    expect(update).toHaveBeenCalledWith('autoAnalyze', false, GLOBAL_TARGET);
  });

  it('does not ask when autoAnalyze is already false', async () => {
    const update = vi.fn();
    const config = makeConfig(false, update);
    const ask = vi.fn();

    const result = await ensureAutomationConsent(config, ask, GLOBAL_TARGET);

    expect(ask).not.toHaveBeenCalled();
    expect(result).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('does not ask when autoAnalyze is already true', async () => {
    const update = vi.fn();
    const config = makeConfig(true, update);
    const ask = vi.fn();

    const result = await ensureAutomationConsent(config, ask, GLOBAL_TARGET);

    expect(ask).not.toHaveBeenCalled();
    expect(result).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });
});
