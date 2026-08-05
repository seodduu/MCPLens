/**
 * DB 열기 실패를 활성화 실패로 번지지 않게 막는 복구 경로.
 *
 * `~/.mcplens/lens.db`가 손상되면 sql.js가 그대로 throw하고, 그 예외가 activate 밖으로
 * 나가면 VS Code는 "activation failed" 한 줄만 보여준다. 그 뒤 등록될 커맨드가 전부
 * 사라져 사용자는 조치할 방법이 없다. 그래서 손상 파일을 타임스탬프 붙여 백업하고
 * 빈 DB로 다시 시작하며, 그마저 안 되면 메모리 DB로 내려가 확장은 살려 둔다.
 */

export const MEMORY_DB_PATH = ':memory:';

export interface StoreOpenDeps<S> {
  /** 실제로는 LensStore.open. 테스트에서는 가짜를 넣는다. */
  open(filePath: string): Promise<S>;
  exists(filePath: string): boolean;
  rename(from: string, to: string): void;
  now(): Date;
}

export type StoreOpenOutcome<S> =
  | { kind: 'ok'; store: S }
  | { kind: 'recovered'; store: S; backupPath: string; message: string }
  | { kind: 'degraded'; store: S; message: string }
  | { kind: 'failed'; message: string };

/**
 * 백업 경로. ISO 시각의 콜론은 Windows 파일명에 못 쓰므로 하이픈으로 바꾼다.
 */
export function corruptBackupPath(filePath: string, now: Date): string {
  return `${filePath}.corrupt-${now.toISOString().replace(/:/g, '-')}`;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function openStoreWithRecovery<S>(
  filePath: string, deps: StoreOpenDeps<S>,
): Promise<StoreOpenOutcome<S>> {
  try {
    return { kind: 'ok', store: await deps.open(filePath) };
  } catch (firstError) {
    if (deps.exists(filePath)) {
      const backupPath = corruptBackupPath(filePath, deps.now());
      try {
        deps.rename(filePath, backupPath);
        const store = await deps.open(filePath); // 파일이 사라졌으므로 빈 DB로 열린다
        return {
          kind: 'recovered', store, backupPath,
          message: `MCP Lens: 데이터베이스가 손상되어 백업하고 새로 시작했습니다. `
            + `백업 위치는 ${backupPath} 입니다. 지난 수집 기록은 스캔과 훅 수집으로 다시 채워집니다.`,
        };
      } catch (backupError) {
        return memoryFallback(deps, `${reasonOf(firstError)} / ${reasonOf(backupError)}`);
      }
    }
    return memoryFallback(deps, reasonOf(firstError));
  }
}

async function memoryFallback<S>(deps: StoreOpenDeps<S>, reason: string): Promise<StoreOpenOutcome<S>> {
  try {
    const store = await deps.open(MEMORY_DB_PATH);
    return {
      kind: 'degraded', store,
      message: `MCP Lens: 데이터베이스 파일을 쓸 수 없어 메모리에서만 동작합니다(원인: ${reason}). `
        + `이번 창에서 수집한 내용은 저장되지 않습니다. `
        + `~/.mcplens 디렉터리의 권한을 확인하거나 lens.db를 직접 옮긴 뒤 창을 다시 여세요.`,
    };
  } catch (memoryError) {
    return {
      kind: 'failed',
      message: `MCP Lens: 데이터베이스를 열지 못했습니다(원인: ${reason} / ${reasonOf(memoryError)}). `
        + `~/.mcplens 디렉터리 권한을 확인한 뒤 창을 다시 여세요.`,
    };
  }
}
