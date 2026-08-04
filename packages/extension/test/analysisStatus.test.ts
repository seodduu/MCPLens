import { describe, expect, it } from 'vitest';
import { analysisFailureMessage, createAnalysisStatus, formatAnalysisStatus } from '../src/analysisStatus.js';

describe('analysis status telemetry', () => {
  it('retains only the minimal operational fields', () => {
    const status = createAnalysisStatus({
      cache: 'miss', provider: 'claude', model: 'haiku', serverCount: 2, toolCount: 4,
      estimatedDefinitionTokens: 1200, sentDefinitionTokens: 1180, durationMs: 42,
      errorCode: null,
      prompt: 'do not retain', description: 'do not retain', inputSchemaJson: '{"secret":true}',
    });
    expect(status).toEqual({
      cache: 'miss', provider: 'claude', model: 'haiku', serverCount: 2, toolCount: 4,
      estimatedDefinitionTokens: 1200, sentDefinitionTokens: 1180, durationMs: 42, errorCode: null,
    });
    expect(JSON.stringify(status)).not.toContain('secret');
  });

  it('renders safe operational status and distinct English CLI failures', () => {
    const text = formatAnalysisStatus(createAnalysisStatus({
      cache: 'hit', provider: 'codex', model: 'gpt-5.6-luna', serverCount: 1, toolCount: 3,
      estimatedDefinitionTokens: 40, sentDefinitionTokens: 0, durationMs: 5, errorCode: null,
    }));
    expect(text).toContain('Cache hit');
    expect(text).toContain('codex / gpt-5.6-luna');
    expect(analysisFailureMessage('authentication-failed')).toMatch(/authentication/i);
    expect(analysisFailureMessage('timeout')).toMatch(/timed out/i);
    expect(analysisFailureMessage('invalid-output')).toMatch(/invalid output/i);
    expect(analysisFailureMessage('provider-unavailable')).toMatch(/unavailable/i);
  });
});
