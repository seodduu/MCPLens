import type { ClientHookInstaller, InstallerDeps, InstallResult, InstallState, RunResult } from '../hookInstall.js';

/** 훅 설치기 공통 에러 메시지 헬퍼. */
export function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

/**
 * "대상이 이미 없다"는 CLI stderr를 판정한다. uninstall 멱등성의 단일 판정점 —
 * 이미 제거된 대상의 재제거는 실패가 아니다. 3사 실측 문구를 모두 커버한다:
 *   claude: "...not found in installed plugins"
 *   gemini: 'Failed to uninstall "mcp-lens": Extension not found.'
 *   codex : not installed / no such
 * 새 문구를 만나면 각 설치기가 아니라 여기에 추가한다.
 */
export function absent(s: string): boolean { return /not installed|not found|no such/i.test(s); }

/**
 * 모든 `ClientHookInstaller` 구현이 공유하는 never-throw 메커니즘.
 *
 * 수집기 설치·실패가 사용자의 MCP 호출로 전파되지 않는다: 설치기는 throw 대신
 * `InstallResult` 유니온을 반환하고, 감지는 fail-open(`not-installed`/`client-missing`)이다.
 * 이 보장은 각 서브클래스가 개별적으로 지키는 관례가 아니라, 여기서 구조적으로 강제한다.
 */
export abstract class BaseHookInstaller implements ClientHookInstaller {
  abstract readonly client: ClientHookInstaller['client'];

  constructor(protected deps: InstallerDeps) {}

  abstract detect(): Promise<InstallState>;
  abstract install(): Promise<InstallResult>;
  abstract uninstall(): Promise<InstallResult>;

  /** findBinary는 절대 throw를 전파하지 않는다 — 던지면 client-missing으로 취급한다. */
  protected bin(name: string): string | null {
    try { return this.deps.findBinary(name); }
    catch { return null; }
  }

  /** run은 절대 throw를 전파하지 않는다 — 실패를 non-zero RunResult로 정규화한다. */
  protected async run(bin: string, args: string[]): Promise<RunResult> {
    try { return await this.deps.run(bin, args); }
    catch (e) { return { stdout: '', stderr: msg(e), code: 1 }; }
  }
}
