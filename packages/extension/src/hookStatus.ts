import type { InstallState } from './hookInstall.js';

export type CollectionHealth =
  | 'idle'
  | 'healthy'
  | 'hook-only'
  | 'log-only'
  | 'degraded'
  | 'unavailable';

/** Public core snapshot shape consumed by the extension. */
export interface CollectionHealthSnapshot {
  health: CollectionHealth;
  hookObserved: boolean;
  logObserved: boolean;
  consecutiveMisses: number;
  consecutiveMatches: number;
  waitingForCorrelation: number;
  lastEventAt: string | null;
}

export interface CollectionHealthPresentation {
  label: string;
  description: string;
  tooltip: string;
  severity: 'ok' | 'info' | 'warning' | 'error' | 'idle';
}

export function formatCollectionHealth(
  snapshot: CollectionHealthSnapshot,
  options: { hooksConfigured?: boolean } = {},
): CollectionHealthPresentation {
  switch (snapshot.health) {
    case 'healthy':
      return present('정상', 'Hook+로그', 'Hook과 로그가 최근 호출에서 일치합니다.', 'ok');
    case 'hook-only':
      return present('부분 측정', 'Hook only · 토큰 상세 없음',
        'Hook 호출은 수집하지만 로그 토큰 상세를 아직 확인하지 못했습니다.', 'info');
    case 'log-only':
      return present('부분 측정', 'Log only · 비공식 포맷 의존',
        '로그만 수집 중입니다. Hook 설치와 신뢰 상태를 확인하세요.', 'warning');
    case 'degraded':
      return present('성능 저하', `연속 상관관계 불일치 ${snapshot.consecutiveMisses}회`,
        '수집 품질이 낮아 제거 권고를 후보로 낮춥니다.', 'warning');
    case 'unavailable':
      return present('검토 필요', 'Hook과 로그를 모두 확인할 수 없음',
        'Hook 설치·신뢰와 클라이언트 로그 접근 권한을 점검하세요.', 'error');
    case 'idle':
      if (options.hooksConfigured) {
        return present('첫 이벤트 대기', 'Hook 또는 로그 이벤트를 기다리는 중',
          '수집이 구성되었습니다. 첫 MCP 호출 뒤 상태가 갱신됩니다.', 'info');
      }
      return present('유휴', '최근 MCP 수집 이벤트 없음',
        '최근 MCP 실행 또는 로그 변화가 없어 수집 품질을 판단할 수 없습니다.', 'idle');
  }
}

export function clientRowPresentation(
  install: InstallState,
  snapshot: CollectionHealthSnapshot | undefined,
): CollectionHealthPresentation {
  if (install === 'not-installed') {
    return present('미연결', '설치 필요',
      '훅이 설치되지 않았습니다. 설치하면 이 클라이언트의 MCP 호출을 수집합니다.', 'warning');
  }
  // installed: 관측이 있으면 그 건강도, 없으면 idle(첫 이벤트 대기)
  return formatCollectionHealth(
    snapshot ?? { health: 'idle', hookObserved: false, logObserved: false,
      consecutiveMisses: 0, consecutiveMatches: 0, waitingForCorrelation: 0, lastEventAt: null },
    { hooksConfigured: true },
  );
}

function present(
  label: string,
  description: string,
  tooltip: string,
  severity: CollectionHealthPresentation['severity'],
): CollectionHealthPresentation {
  return { label, description, tooltip, severity };
}
