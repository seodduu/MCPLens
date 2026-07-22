import { join } from 'node:path';
import type { InstallResult, InstallState } from '../hookInstall.js';
import { absent, BaseHookInstaller } from './base.js';

/** `packages/gemini-extension/gemini-extension.json`의 `name`과 일치해야 한다. */
export const GEMINI_EXT_NAME = 'mcp-lens';

/** `gemini extensions list -o json`의 실측 스키마 (gemini-cli 0.51.0) — 항목은 객체다. */
interface GeminiExtensionEntry { name?: string }

/**
 * Gemini CLI 훅 설치기.
 *
 * 실측 기준(gemini-cli 0.51.0):
 * - 감지: `gemini extensions list -o json` → 최상위가 배열이고 항목은 `{ name, version, path, ... }` 객체.
 *   미설치 상태의 출력은 정확히 `[]`. (`-o|--output-format` 은 `text`|`json` 만 받는다.)
 * - 설치: `gemini extensions install <source>` — source는 git URL 또는 **로컬 경로 위치인자**.
 *   마켓플레이스 개념이 없어 번들 디렉터리를 그대로 넘긴다(복사 단계 없음).
 *   `--consent` 가 없으면 훅 포함 확장은 `Do you want to continue? [Y/n]` 프롬프트에서 **무한 대기**한다.
 *   비대화형 실행이 전제이므로 `--consent`와 `--skip-settings`를 함께 넘긴다.
 * - 제거: `gemini extensions uninstall <name>` — 경로가 아니라 확장 이름을 받는다.
 *   미설치 상태면 exit 1 + stderr `Failed to uninstall "mcp-lens": Extension not found.`
 */
export class GeminiHookInstaller extends BaseHookInstaller {
  readonly client = 'gemini-cli' as const;

  async detect(): Promise<InstallState> {
    const bin = this.bin('gemini');
    if (bin === null) return 'client-missing';
    const r = await this.run(bin, ['extensions', 'list', '-o', 'json']);
    if (r.code !== 0) return 'not-installed';
    try {
      // gemini-cli 0.51.0은 TTY 없이 spawn되면 `-o json` 출력을 stdout이 아니라
      // stderr로 보낸다(stdout 빈 문자열). 확장은 항상 비TTY로 spawn하므로 stderr 폴백이 실사용 경로다.
      const raw = r.stdout.trim() !== '' ? r.stdout : r.stderr;
      const parsed: unknown = JSON.parse(raw);
      const has = Array.isArray(parsed)
        && (parsed as GeminiExtensionEntry[]).some((e) => e?.name === GEMINI_EXT_NAME);
      return has ? 'installed' : 'not-installed';
    } catch { return 'not-installed'; }
  }

  async install(): Promise<InstallResult> {
    const bin = this.bin('gemini');
    if (bin === null) return { kind: 'client-missing' };
    if (await this.detect() === 'installed') return { kind: 'ok', alreadyInstalled: true };

    // --consent 로도 프롬프트가 하나 더 남는다: 로컬 경로 설치는 "Do you trust the
    // files in this folder? [y/N]" 를 띄우고, 이걸 끄는 플래그가 없다(0.51.0
    // `extensions install --help` 실측). stdin을 닫아도 종료되지 않으므로 유일한
    // 비대화형 경로는 소스 폴더를 미리 신뢰 목록에 넣는 것이다. 반드시 install 전에.
    this.trustBundledDir();

    // --consent is required or `gemini extensions install` blocks on an
    // interactive [Y/n] prompt and hangs forever, even with stdin closed
    // (measured on gemini-cli 0.51.0) — see class JSDoc above.
    const ins = await this.run(bin, ['extensions', 'install', this.deps.bundledDir, '--consent', '--skip-settings']);
    if (ins.code !== 0 && !alreadyInstalled(ins.stderr)) {
      return { kind: 'failed', step: 'install', stderr: ins.stderr };
    }
    // detect() may have missed a stale/failed `list`; if install then reports
    // the plugin is already there, reflect that instead of claiming a fresh
    // install happened (unlike Claude/Codex, where the alreadyPresent match
    // is about the marketplace, not the plugin itself).
    if (ins.code !== 0 && alreadyInstalled(ins.stderr)) {
      return { kind: 'ok', alreadyInstalled: true };
    }
    return { kind: 'ok', alreadyInstalled: false };
  }

  /**
   * 번들 디렉터리를 `~/.gemini/trustedFolders.json` 에 등록한다. 우리가 배포한
   * 디렉터리 하나만 대상이고 다른 항목은 보존한다. 실패는 삼킨다 — 이미 신뢰된
   * 폴더일 수도 있고, 이 단계 때문에 설치가 막히면 안 된다(fail-open).
   */
  private trustBundledDir(): void {
    const path = join(this.deps.home, '.gemini', 'trustedFolders.json');
    try {
      let trusted: Record<string, string> = {};
      try {
        const parsed: unknown = JSON.parse(this.deps.fs.readFile(path));
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          trusted = parsed as Record<string, string>;
        }
      } catch {
        // 파일이 없거나 깨졌다 — 새로 쓴다. 기존 내용이 깨진 경우까지 살릴 수는 없다.
      }
      trusted[this.deps.bundledDir] = 'TRUST_FOLDER';
      this.deps.fs.writeFile(path, `${JSON.stringify(trusted, null, 2)}\n`);
    } catch {
      // 쓰기 불가 — 설치를 계속 시도한다.
    }
  }

  async uninstall(): Promise<InstallResult> {
    const bin = this.bin('gemini');
    if (bin === null) return { kind: 'client-missing' };
    const un = await this.run(bin, ['extensions', 'uninstall', GEMINI_EXT_NAME]);
    if (un.code !== 0 && !absent(un.stderr)) {
      return { kind: 'failed', step: 'uninstall', stderr: un.stderr };
    }
    return { kind: 'ok', alreadyInstalled: false };
  }
}

function alreadyInstalled(s: string): boolean { return /already installed/i.test(s); }
