import type { InstallerDeps } from '../../src/hookInstall.js';

/**
 * 실 파일 시스템을 건드리지 않는 InstallerDeps['fs'] 스텁.
 * 기본값은 "아무것도 없는 홈" — readFile은 ENOENT처럼 throw하고, 쓰기는 메모리에 남는다.
 * 특정 동작만 바꾸고 싶으면 스프레드로 덮어쓴다: `{ ...memFsStub(), copyDir: ... }`
 */
export function memFsStub(seed: Record<string, string> = {}): InstallerDeps['fs'] {
  const files = new Map(Object.entries(seed));
  return {
    copyDir: () => {},
    exists: (p: string) => files.has(p),
    readDir: () => [],
    readFile: (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFile: (p: string, content: string) => { files.set(p, content); },
  };
}
