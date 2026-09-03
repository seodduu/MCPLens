import { countTokens } from '../tokenize.js';
export const ESTIMATOR_VERSION = 'v2-2026-08-27' as const;

/**
 * Measured on the daily-batch pilot, day-01 (2026-08-26, commit 599f9df): 10 servers, eager mode,
 * Claude Code, weight measured by 12-config subtraction on real sessions.
 *
 * measured ≈ FACTOR × (tokens of {name: "mcp__<server>__<tool>", description, inputSchema}
 *                      + tokens of the server's initialize instructions)
 *
 * Least squares over the 10 servers also fits a per-tool constant of 12 tokens, which is inside
 * the noise and is therefore dropped: the harness cost scales with content, not with tool count.
 * Mean absolute error after calibration: 7.4% (was 36.8% uncalibrated). Range 0.7% to 14.1%.
 * Evidence: docs/plans/assets/2026-08-27-보정-근거-day-01.json
 *
 * Only Claude Code in eager mode has been measured. Codex and Gemini CLI reuse this factor and
 * say so through calibrationSource, rather than pretending to a measurement that does not exist.
 */
export const HARNESS_FACTOR = 1.608;
export const CALIBRATION_SOURCE = 'claude-code-eager-pilot-day-01' as const;

/** Applies the harness factor. Rounds half up so a 0-token input stays 0. */
export function calibrate(rawTokens: number): number {
  return Math.round(rawTokens * HARNESS_FACTOR);
}

export type NameListRule =
  | 'name' | 'name-full' | 'name-line1' | 'name-sent1'
  | 'name-80' | 'name-100' | 'name-150' | 'name-200' | 'json';

/**
 * Fitted on the daily-batch pilot, day-05 and day-07 (13 servers, deferred, Claude Code): the
 * weight a server adds to the first turn when its definitions are deferred, measured by
 * `all - minus_k` subtraction with instructions at 0.
 *
 * measured ~= FACTOR x (tokens of JSON.stringify({name: "mcp__<server>__<tool>", description})
 *                       plus a newline, summed over the server's tools)
 *
 * All nine candidate stub shapes in the plan were scored. `json` won on mean absolute error
 * (23.18%), ahead of `name-full` (24.77%) and `name-line1` (29.17%); the bare name loses badly
 * (61.13%), so the stub demonstrably carries description text. Mean absolute error is 23.18% and
 * the worst server is 48.39% (arxiv), both above the plan's 15% target: the per-server subtraction
 * runs are single-run measurements and the scatter between servers of similar raw size is wider
 * than the fit can follow. Fitting a per-tool constant alongside the factor made it worse
 * (27.30%), so no constant is used.
 *
 * Predicting the day-08 batch aggregate (10 servers, 47 tools, measured 4,021 by
 * `contextAll - harnessBaseline`) gives 2,388, i.e. -40.61%. That figure is not part of the fit:
 * subtraction cancels whatever fixed block the harness writes once per session, and the day-08
 * aggregate contains it, so an under-prediction of that size is expected there.
 *
 * Evidence: docs/plans/assets/2026-09-03-이름목록-보정-근거.json
 *
 * Only Claude Code has been measured. Other clients reuse this factor and say so through
 * NAME_LIST_SOURCE, as the definition-token calibration does.
 */
export const NAME_LIST_RULE: NameListRule = 'json';
export const NAME_LIST_FACTOR = 0.4149;
export const NAME_LIST_PER_TOOL = 0;
export const NAME_LIST_SOURCE = 'claude-code-deferred-pilot-day-05-07' as const;

/** The stub text the harness is modelled to keep in context for a deferred tool. */
export function nameListStub(serverName: string, toolName: string, description: string | null): string {
  return JSON.stringify({ name: `mcp__${serverName}__${toolName}`, description: description ?? '' });
}

/** Calibrated tokens of one tool's name-list stub. Rounds half up; an empty stub is never 0 because the name is always there. */
export function estimateNameListTokens(serverName: string, toolName: string, description: string | null): number {
  const raw = countTokens(`${nameListStub(serverName, toolName, description)}\n`);
  return Math.max(1, Math.round(raw * NAME_LIST_FACTOR + NAME_LIST_PER_TOOL));
}
