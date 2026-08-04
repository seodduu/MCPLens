import { describe, it, expect, vi } from 'vitest';
import { withGenerationGuard } from '../src/collectionRefresh.js';

describe('withGenerationGuard', () => {
  it('현재 세대와 같으면 apply를 실행한다', async () => {
    const apply = vi.fn();
    await withGenerationGuard(1, () => 1, apply);
    expect(apply).toHaveBeenCalledOnce();
  });

  it('더 최신 실행이 이미 시작돼 세대가 어긋나면 apply를 건너뛴다', async () => {
    // extension.ts의 computeCollection()이 재현하는 시나리오: detect()가 도는 동안
    // 새 refresh가 시작돼 collectionGeneration이 증가하면, 늦게 끝난 이 실행은
    // lastCollectionInputs/hookStatusProvider/setContext 키/markStepIncomplete를 전부 건너뛰어야
    // 낡은 값으로 최신 상태를 덮어쓰지 않는다.
    const apply = vi.fn();
    await withGenerationGuard(1, () => 2, apply);
    expect(apply).not.toHaveBeenCalled();
  });

  it('apply 콜백 하나로 여러 부수효과를 묶어, 세대가 맞을 때만 전부 실행되게 한다', async () => {
    const sideEffects: string[] = [];
    await withGenerationGuard(5, () => 5, () => {
      sideEffects.push('lastCollectionInputs');
      sideEffects.push('hookStatusProvider.setClients');
      sideEffects.push('refreshSetupKeys');
      sideEffects.push('refreshSetupRows');
    });
    expect(sideEffects).toEqual([
      'lastCollectionInputs', 'hookStatusProvider.setClients', 'refreshSetupKeys', 'refreshSetupRows',
    ]);
  });

  it('apply가 비동기 함수여도 완료를 기다린다', async () => {
    let done = false;
    await withGenerationGuard(1, () => 1, async () => {
      await Promise.resolve();
      done = true;
    });
    expect(done).toBe(true);
  });
});
