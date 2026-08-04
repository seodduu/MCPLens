import { describe, it, expect } from 'vitest';
import {
  evaluateSetupKeys,
  stepsToUncheck,
  stepsToComplete,
  SETUP_STEP_IDS,
} from '../src/setupContextKeys.js';

const base = {
  installs: [] as { install: string }[],
  definitionCount: 0,
  consentAccepted: false,
  analyzedServerCount: 0,
  rollout: undefined as string | undefined,
};

describe('evaluateSetupKeys', () => {
  it('정의가 0개면 scanReady는 거짓', () => {
    expect(evaluateSetupKeys({ ...base }).scanReady).toBe(false);
  });

  it('정의가 1개 이상이면 scanReady는 참', () => {
    expect(evaluateSetupKeys({ ...base, definitionCount: 3 }).scanReady).toBe(true);
  });

  it('클라이언트가 하나도 감지되지 않으면 hooksReady는 거짓', () => {
    expect(evaluateSetupKeys({ ...base, installs: [] }).hooksReady).toBe(false);
  });

  it('감지된 클라이언트가 모두 installed면 hooksReady는 참', () => {
    const installs = [{ install: 'installed' }, { install: 'installed' }];
    expect(evaluateSetupKeys({ ...base, installs }).hooksReady).toBe(true);
  });

  it('하나라도 needs-approval이면 hooksReady는 거짓', () => {
    const installs = [{ install: 'installed' }, { install: 'needs-approval' }];
    expect(evaluateSetupKeys({ ...base, installs }).hooksReady).toBe(false);
  });

  it('client-missing인 클라이언트는 판정에서 제외한다', () => {
    const installs = [{ install: 'installed' }, { install: 'client-missing' }];
    expect(evaluateSetupKeys({ ...base, installs }).hooksReady).toBe(true);
  });

  it('client-missing뿐이면 hooksReady는 거짓', () => {
    const installs = [{ install: 'client-missing' }];
    expect(evaluateSetupKeys({ ...base, installs }).hooksReady).toBe(false);
  });

  it('동의가 없으면 분석 결과가 있어도 analysisReady는 거짓', () => {
    expect(evaluateSetupKeys({ ...base, analyzedServerCount: 2 }).analysisReady).toBe(false);
  });

  it('동의가 있고 분석 결과가 1개 이상이면 analysisReady는 참', () => {
    expect(evaluateSetupKeys({
      ...base, consentAccepted: true, analyzedServerCount: 1 }).analysisReady).toBe(true);
  });

  it('동의만 있고 분석 결과가 없으면 analysisReady는 거짓', () => {
    expect(evaluateSetupKeys({ ...base, consentAccepted: true }).analysisReady).toBe(false);
  });

  it('rollout이 shadow면 globalActionsReady는 거짓', () => {
    expect(evaluateSetupKeys({ ...base, rollout: 'shadow' }).globalActionsReady).toBe(false);
  });

  it('rollout이 설정되지 않았으면 globalActionsReady는 거짓', () => {
    expect(evaluateSetupKeys({ ...base, rollout: undefined }).globalActionsReady).toBe(false);
  });

  it('rollout이 claude면 globalActionsReady는 참', () => {
    expect(evaluateSetupKeys({ ...base, rollout: 'claude' }).globalActionsReady).toBe(true);
  });

  it('rollout이 stable이면 globalActionsReady는 참', () => {
    expect(evaluateSetupKeys({ ...base, rollout: 'stable' }).globalActionsReady).toBe(true);
  });
});

describe('stepsToUncheck', () => {
  const on = { scanReady: true, hooksReady: true, analysisReady: true, globalActionsReady: true };
  const off = { scanReady: false, hooksReady: false, analysisReady: false, globalActionsReady: false };

  it('참에서 거짓으로 바뀐 키의 스텝 id를 돌려준다', () => {
    expect(stepsToUncheck(on, { ...on, hooksReady: false })).toEqual([SETUP_STEP_IDS.hooksReady]);
  });

  it('거짓에서 거짓이면 아무것도 돌려주지 않는다', () => {
    expect(stepsToUncheck(off, off)).toEqual([]);
  });

  it('거짓에서 참이면 아무것도 돌려주지 않는다', () => {
    expect(stepsToUncheck(off, on)).toEqual([]);
  });

  it('이전 상태가 없으면(최초 판정) 아무것도 돌려주지 않는다', () => {
    expect(stepsToUncheck(undefined, off)).toEqual([]);
  });

  it('스텝 id는 확장 식별자와 워크스루 id로 정규화된다', () => {
    expect(SETUP_STEP_IDS.hooksReady).toBe('seodduu.mcp-context-lens#mcpLens.setup#hooks');
    expect(SETUP_STEP_IDS.scanReady).toBe('seodduu.mcp-context-lens#mcpLens.setup#scan');
    expect(SETUP_STEP_IDS.analysisReady).toBe('seodduu.mcp-context-lens#mcpLens.setup#analyze');
  });

  it('actions 스텝 id는 seodduu.mcp-context-lens#mcpLens.setup#actions 이다', () => {
    expect(SETUP_STEP_IDS.globalActionsReady).toBe('seodduu.mcp-context-lens#mcpLens.setup#actions');
  });

  it('globalActionsReady가 참에서 거짓이 되면 actions 스텝 id를 해제 대상으로 돌려준다', () => {
    expect(stepsToUncheck(on, { ...on, globalActionsReady: false }))
      .toEqual([SETUP_STEP_IDS.globalActionsReady]);
  });
});

describe('stepsToComplete', () => {
  const on = { scanReady: true, hooksReady: true, analysisReady: true, globalActionsReady: true };
  const off = { scanReady: false, hooksReady: false, analysisReady: false, globalActionsReady: false };

  it('거짓에서 참으로 바뀌면 해당 스텝 id를 돌려준다', () => {
    expect(stepsToComplete(off, { ...off, hooksReady: true })).toEqual([SETUP_STEP_IDS.hooksReady]);
  });

  it('참에서 참이면 아무것도 돌려주지 않는다', () => {
    expect(stepsToComplete(on, on)).toEqual([]);
  });

  it('참에서 거짓이면 아무것도 돌려주지 않는다', () => {
    expect(stepsToComplete(on, { ...on, hooksReady: false })).toEqual([]);
  });

  it('이전 상태가 없으면 아무것도 돌려주지 않는다', () => {
    expect(stepsToComplete(undefined, on)).toEqual([]);
  });

  it('여러 키가 동시에 켜지면 모두 돌려준다', () => {
    const result = stepsToComplete(off, { ...off, hooksReady: true, scanReady: true });
    expect(result.sort()).toEqual(
      [SETUP_STEP_IDS.hooksReady, SETUP_STEP_IDS.scanReady].sort(),
    );
  });

  it('stepsToComplete와 stepsToUncheck는 같은 전이에서 동시에 비지 않는다', () => {
    const prev = { ...off, hooksReady: true };
    const next = { ...off, scanReady: true };
    expect(stepsToUncheck(prev, next)).toEqual([SETUP_STEP_IDS.hooksReady]);
    expect(stepsToComplete(prev, next)).toEqual([SETUP_STEP_IDS.scanReady]);
  });
});
