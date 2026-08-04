import { describe, it, expect } from 'vitest';
import { classifyScanFailure } from '../src/scan-status.js';

describe('classifyScanFailure', () => {
  it('auth-required 메시지는 auth-required로 분류되고 errorCode가 없다', () => {
    const record = classifyScanFailure(new Error('auth-required: 401 from server'));
    expect(record).toEqual({ status: 'auth-required' });
  });

  it('token-expired 메시지도 auth-required로 분류된다', () => {
    const record = classifyScanFailure(new Error('token-expired: refresh failed'));
    expect(record).toEqual({ status: 'auth-required' });
  });

  it('그 외 예외는 failed로 분류되고 errorCode를 담는다', () => {
    const record = classifyScanFailure(new Error('spawn ENOENT'));
    expect(record).toEqual({ status: 'failed', errorCode: 'spawn ENOENT' });
  });

  it('errorCode는 120자를 넘지 않는다', () => {
    const longMessage = 'x'.repeat(300);
    const record = classifyScanFailure(new Error(longMessage));
    expect(record.status).toBe('failed');
    expect(record.errorCode).toHaveLength(120);
    expect(record.errorCode).toBe(longMessage.slice(0, 120));
  });

  it('문자열 예외도 분류된다', () => {
    const record = classifyScanFailure('spawn ENOENT');
    expect(record).toEqual({ status: 'failed', errorCode: 'spawn ENOENT' });
  });

  it('Error가 아닌 객체도 분류된다', () => {
    // scanServer가 SDK 예외를 그대로 재던지므로 Error가 아닌 값이 들어올 수 있다.
    // 이 경우에도 String(err)로 정규화해 TypeError 없이 분류해야 한다.
    const record = classifyScanFailure({ code: 'ECONNRESET' });
    expect(record.status).toBe('failed');
    expect(record.errorCode).toBeTruthy();

    const authRecord = classifyScanFailure('auth-required: token missing');
    expect(authRecord).toEqual({ status: 'auth-required' });
  });
});
