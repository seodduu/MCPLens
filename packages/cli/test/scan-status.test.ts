import { describe, it, expect } from 'vitest';
import { classifyScanFailure } from '../src/scan-status.js';

describe('classifyScanFailure', () => {
  it('classifies auth-required messages as auth-required with no errorCode', () => {
    const record = classifyScanFailure(new Error('auth-required: 401 from server'));
    expect(record).toEqual({ status: 'auth-required' });
  });

  it('classifies token-expired messages as auth-required too', () => {
    const record = classifyScanFailure(new Error('token-expired: refresh failed'));
    expect(record).toEqual({ status: 'auth-required' });
  });

  it('classifies other exceptions as failed and carries an errorCode', () => {
    const record = classifyScanFailure(new Error('spawn ENOENT'));
    expect(record).toEqual({ status: 'failed', errorCode: 'spawn ENOENT' });
  });

  it('never lets errorCode exceed 120 characters', () => {
    const longMessage = 'x'.repeat(300);
    const record = classifyScanFailure(new Error(longMessage));
    expect(record.status).toBe('failed');
    expect(record.errorCode).toHaveLength(120);
    expect(record.errorCode).toBe(longMessage.slice(0, 120));
  });

  it('classifies string exceptions too', () => {
    const record = classifyScanFailure('spawn ENOENT');
    expect(record).toEqual({ status: 'failed', errorCode: 'spawn ENOENT' });
  });

  it('classifies non-Error objects too', () => {
    // scanServer rethrows SDK exceptions verbatim, so non-Error values can arrive.
    // They must still be normalized with String(err) and classified without a TypeError.
    const record = classifyScanFailure({ code: 'ECONNRESET' });
    expect(record.status).toBe('failed');
    expect(record.errorCode).toBeTruthy();

    const authRecord = classifyScanFailure('auth-required: token missing');
    expect(authRecord).toEqual({ status: 'auth-required' });
  });
});
