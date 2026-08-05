/**
 * Consent for handling new servers automatically.
 *
 * The first run belongs to the walkthrough, but leaving the user to measure and analyze every server
 * added afterwards by hand removes the reason to use this tool. Running it automatically without a
 * word, though, spends the tokens of the user's account without permission. So onboarding asks once
 * and writes the answer to settings. It is never asked again.
 */

export interface AutomationChoice {
  /** Scan new servers automatically */
  autoScan: boolean;
  /** Analyze newly scanned tools automatically (this spends provider CLI tokens) */
  autoAnalyze: boolean;
}

export const AUTOMATION_PROMPT_TITLE = 'Keep MCP Lens up to date on its own?';

export const AUTOMATION_PROMPT_DETAIL = [
  'When you add a new MCP server later, Lens can measure it without asking again.',
  'Scan: Lens briefly starts the new server and reads its tool definitions. No LLM tokens are spent and no config file is modified.',
  'Analyze: Lens asks the provider you chose above whether each new tool can be turned off independently. This spends that account\'s tokens. Only tool definitions and aggregated usage counts are sent, and only for tools that have not been analyzed before.',
  'Servers that need a sign-in still ask you first.',
  'You can change this later with the mcpLens.autoScan and mcpLens.autoAnalyze settings, and withdrawing inference consent also stops automatic analysis.',
].join('\n\n');

export const AUTOMATION_ACCEPT_LABEL = 'Scan and analyze';
export const AUTOMATION_SCAN_ONLY_LABEL = 'Scan only';

/**
 * Dialog answer -> setting value. Dismissal (undefined) is treated the same as a refusal:
 * reading "asked and dismissed" as approval would not be consent.
 */
export function automationChoiceFrom(pick: string | undefined): AutomationChoice {
  if (pick === AUTOMATION_ACCEPT_LABEL) return { autoScan: true, autoAnalyze: true };
  if (pick === AUTOMATION_SCAN_ONLY_LABEL) return { autoScan: true, autoAnalyze: false };
  return { autoScan: false, autoAnalyze: false };
}

/** The values written to settings. autoScan is a string enum, so it is converted here. */
export function automationSettings(choice: AutomationChoice): {
  autoScan: 'always' | 'never'; autoAnalyze: boolean;
} {
  return { autoScan: choice.autoScan ? 'always' : 'never', autoAnalyze: choice.autoAnalyze };
}
