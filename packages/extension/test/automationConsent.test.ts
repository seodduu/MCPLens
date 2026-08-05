import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_ACCEPT_LABEL, AUTOMATION_PROMPT_DETAIL, AUTOMATION_SCAN_ONLY_LABEL,
  automationChoiceFrom, automationSettings,
} from '../src/automationConsent.js';

describe('automationChoiceFrom', () => {
  it('둘 다 승낙하면 스캔과 분석을 모두 켠다', () => {
    expect(automationChoiceFrom(AUTOMATION_ACCEPT_LABEL))
      .toEqual({ autoScan: true, autoAnalyze: true });
  });

  it('스캔만 고르면 분석은 켜지 않는다', () => {
    expect(automationChoiceFrom(AUTOMATION_SCAN_ONLY_LABEL))
      .toEqual({ autoScan: true, autoAnalyze: false });
  });

  // 묻고 닫아 버린 것을 승낙으로 읽으면 그건 동의가 아니다.
  it('닫기(undefined)는 거절과 같다', () => {
    expect(automationChoiceFrom(undefined))
      .toEqual({ autoScan: false, autoAnalyze: false });
  });

  it('알 수 없는 응답도 거절로 다룬다', () => {
    expect(automationChoiceFrom('무언가'))
      .toEqual({ autoScan: false, autoAnalyze: false });
  });
});

describe('automationSettings', () => {
  it('autoScan은 설정의 문자열 enum으로 바꾼다', () => {
    expect(automationSettings({ autoScan: true, autoAnalyze: true }))
      .toEqual({ autoScan: 'always', autoAnalyze: true });
    expect(automationSettings({ autoScan: false, autoAnalyze: false }))
      .toEqual({ autoScan: 'never', autoAnalyze: false });
  });
});

describe('동의 문안', () => {
  // 자동 분석은 사용자 계정의 토큰을 쓴다. 그 사실을 감춘 동의는 동의가 아니다.
  it('토큰이 소비된다는 사실과 전송 범위를 밝힌다', () => {
    expect(AUTOMATION_PROMPT_DETAIL).toContain('spends that account');
    expect(AUTOMATION_PROMPT_DETAIL).toContain('tool definitions');
    expect(AUTOMATION_PROMPT_DETAIL).toContain('No LLM tokens are spent');   // 스캔 쪽은 무료임도 밝힌다
  });

  it('나중에 바꾸는 방법을 알려 준다', () => {
    expect(AUTOMATION_PROMPT_DETAIL).toContain('mcpLens.autoScan');
    expect(AUTOMATION_PROMPT_DETAIL).toContain('mcpLens.autoAnalyze');
  });
});
