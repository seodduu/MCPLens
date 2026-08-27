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
