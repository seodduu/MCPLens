import { describe, it, expect, vi } from 'vitest';
import { applyCollectionResult } from '../src/collectionRefresh.js';

// computeCollection()이 실제로 부르는 지점: extension.ts는 이 함수에 vscode API를 감싼
// 콜백(applyInputs/setClients/refreshSetupKeys/refreshSetupRows)만 넘긴다. 이 모듈은 vscode를
// import하지 않으므로, 여기서 이 함수를 직접 호출해 "가드 밖에서 refreshSetupKeys/refreshSetupRows가
// 실행되는" 버그가 재발하면 실패하는 테스트를 만들 수 있다.
describe('applyCollectionResult', () => {
  it('세대가 앞서 있으면 어떤 효과도 실행하지 않는다', async () => {
    const applyInputs = vi.fn();
    const setClients = vi.fn();
    const refreshSetupKeys = vi.fn();
    const refreshSetupRows = vi.fn();

    // gen(1)이 시작될 때 이미 최신 실행이 collectionGeneration을 2로 올려놓은 상황.
    await applyCollectionResult(1, () => 2, ['inputs'], {
      applyInputs,
      setClients,
      refreshSetupKeys,
      refreshSetupRows,
    });

    expect(applyInputs).not.toHaveBeenCalled();
    expect(setClients).not.toHaveBeenCalled();
    expect(refreshSetupKeys).not.toHaveBeenCalled();
    expect(refreshSetupRows).not.toHaveBeenCalled();
  });

  it('세대가 같으면 모든 효과를 순서대로 실행한다', async () => {
    const order: string[] = [];
    const inputs = ['inputs'];

    await applyCollectionResult(1, () => 1, inputs, {
      applyInputs: (i) => { order.push('applyInputs'); expect(i).toBe(inputs); },
      setClients: (i) => { order.push('setClients'); expect(i).toBe(inputs); },
      refreshSetupKeys: (i) => { order.push('refreshSetupKeys'); expect(i).toBe(inputs); },
      refreshSetupRows: () => { order.push('refreshSetupRows'); },
    });

    expect(order).toEqual(['applyInputs', 'setClients', 'refreshSetupKeys', 'refreshSetupRows']);
  });

  it('키 갱신이 비동기여도 그 완료를 기다린 뒤 행 갱신을 한다', async () => {
    const order: string[] = [];

    await applyCollectionResult(1, () => 1, ['inputs'], {
      applyInputs: () => {},
      setClients: () => {},
      refreshSetupKeys: async () => {
        await Promise.resolve();
        order.push('refreshSetupKeys(resolved)');
      },
      refreshSetupRows: () => { order.push('refreshSetupRows'); },
    });

    expect(order).toEqual(['refreshSetupKeys(resolved)', 'refreshSetupRows']);
  });

  it('효과 실행 도중 세대가 바뀌어도 이미 시작한 실행은 끝까지 간다', async () => {
    // withGenerationGuard는 시작 시점에만 gen을 검사하고 apply() 내부에서 재검사하지 않는다.
    // 따라서 실행이 시작된 뒤 currentGeneration()이 바뀌어도(예: refreshSetupKeys가 await하는 동안
    // 새 refresh가 시작돼 collectionGeneration이 증가해도) 이번 실행의 나머지 효과는 전부 실행된다.
    // 이건 요구사항이 아니라 현재 코드의 실제 동작을 고정해 두는 것이다.
    let generation = 1;
    const order: string[] = [];

    await applyCollectionResult(1, () => generation, ['inputs'], {
      applyInputs: () => { order.push('applyInputs'); },
      setClients: () => { order.push('setClients'); },
      refreshSetupKeys: async () => {
        generation = 2; // 실행 도중 최신 refresh가 시작됐다고 가정
        order.push('refreshSetupKeys');
      },
      refreshSetupRows: () => { order.push('refreshSetupRows'); },
    });

    expect(order).toEqual(['applyInputs', 'setClients', 'refreshSetupKeys', 'refreshSetupRows']);
  });
});
