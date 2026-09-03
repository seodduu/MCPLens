// packages/core/test/scanner/nameList.test.ts
// Guards the deferred name-list estimator against the pilot measurements it was fitted on
// (plan docs/plans/2026-09-03-deferred-이름목록-절감-근거-구현계획.md section 5).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { estimateNameListTokens, NAME_LIST_FACTOR } from '../../src/scanner/calibration.js';

const fixturePath = fileURLToPath(
  new URL('../fixtures/calibration/day-05-07-namelist.json', import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  chosenRule: string;
  factor: number;
  meanAbsError: number;
  maxAbsError: number;
  servers: Array<{
    server: string; toolCount: number; measured: number; predicted: number; error: number;
    tools: Array<{ name: string; description: string | null }>;
  }>;
  day08: {
    measured: number; predicted: number; error: number;
    tools: Array<{ server: string; name: string; description: string | null }>;
  };
};

// The recorded errors were produced with this factor; a changed factor invalidates them.
const TOLERANCE = 0.005;

describe('deferred name-list estimator', () => {
  it('fits the 13 pilot servers within the recorded mean absolute error', () => {
    expect(NAME_LIST_FACTOR).toBe(fixture.factor);
    const errors = fixture.servers.map((s) => {
      const predicted = s.tools.reduce(
        (sum, t) => sum + estimateNameListTokens(s.server, t.name, t.description), 0);
      return Math.abs(predicted - s.measured) / s.measured;
    });
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
    expect(mean).toBeLessThanOrEqual(fixture.meanAbsError + TOLERANCE);
    expect(Math.max(...errors)).toBeLessThanOrEqual(fixture.maxAbsError + TOLERANCE);
  });

  it('never returns 0 for a tool with an empty description', () => {
    expect(estimateNameListTokens('s', 't', null)).toBeGreaterThan(0);
    expect(estimateNameListTokens('s', 't', '')).toBeGreaterThan(0);
  });

  it('is deterministic across calls', () => {
    const once = estimateNameListTokens('jira', 'create_issue', 'Creates an issue.');
    expect(estimateNameListTokens('jira', 'create_issue', 'Creates an issue.')).toBe(once);
  });

  it('predicts the day-08 aggregate within the recorded error', () => {
    const predicted = fixture.day08.tools.reduce(
      (sum, t) => sum + estimateNameListTokens(t.server, t.name, t.description), 0);
    const error = Math.abs(predicted - fixture.day08.measured) / fixture.day08.measured;
    expect(error).toBeLessThanOrEqual(Math.abs(fixture.day08.error) + TOLERANCE);
  });
});
