import { describe, expect, it } from 'vitest';
import { runBin } from '../src/claudeCli.js';

// CLI가 대화형 프롬프트를 띄우면 자식 프로세스는 stdin을 기다리며 영원히 살아 있고,
// close 이벤트가 오지 않아 확장 UI의 "설치"가 무한 대기한다(gemini-cli 0.51.0 실측).
// 어떤 CLI가 새 프롬프트를 추가하더라도 UI가 매달리지 않도록 상한을 둔다.
describe('runBin 타임아웃', () => {
  it('상한을 넘긴 자식 프로세스는 죽이고 non-zero로 resolve한다', async () => {
    const start = Date.now();
    const result = await runBin(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/시간 초과|timed out/i);
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  it('프롬프트를 띄운 채 stdin이 닫혀도 안 죽는 프로세스를 상한으로 끝낸다', async () => {
    // gemini-cli 0.51.0의 실제 거동: stdin을 /dev/null로 닫아도 프롬프트를 띄운 채
    // 종료되지 않는다. stdin.resume()은 EOF로 바로 끝나 이 상황을 재현하지 못하므로,
    // 타이머로 살아 있는 프로세스로 흉내 낸다.
    const result = await runBin(
      process.execPath,
      ['-e', 'process.stdout.write("계속하시겠습니까? [y/N]: "); setInterval(() => {}, 1000);'],
      { timeoutMs: 300 },
    );

    expect(result.code).not.toBe(0);
    // 타임아웃 전까지 받은 출력은 진단을 위해 보존한다.
    expect(result.stdout).toContain('[y/N]');
  });

  it('상한 안에 끝나는 프로세스는 정상 결과를 그대로 돌려준다', async () => {
    const result = await runBin(process.execPath, ['-e', 'process.stdout.write("ok")'], { timeoutMs: 10_000 });
    expect(result).toEqual({ stdout: 'ok', stderr: '', code: 0 });
  });

  it('옵션을 생략해도 기본 상한이 적용된다 — 무한 대기는 선택지가 아니다', async () => {
    const result = await runBin(process.execPath, ['-e', 'process.stdout.write("ok")']);
    expect(result.code).toBe(0);
  });
});
