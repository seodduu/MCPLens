import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_ACCEPT_LABEL, AUTOMATION_PROMPT_DETAIL, AUTOMATION_SCAN_ONLY_LABEL,
  automationChoiceFrom, automationSettings,
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
