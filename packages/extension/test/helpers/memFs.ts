import type { InstallerDeps } from '../../src/hookInstall.js';

/**
 * InstallerDeps['fs'] stub that never touches the real file system.
 * The default is "an empty home": readFile throws like ENOENT and writes stay in memory.
 * To change one behaviour, spread over it: `{ ...memFsStub(), copyDir: ... }`
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
