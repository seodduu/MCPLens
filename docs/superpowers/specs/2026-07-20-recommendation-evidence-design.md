# 권고 증거·확신 등급 설계 (Recommendation Evidence & Confidence)

2026-07-20 승인. 브레인스토밍 결론: 삭제 권고의 설득력 문제(근거 빈약)를
"판정 정교화"가 아닌 **"증거의 구조화·투명화"**로 해결한다.

## 문제

현재 엔진(`packages/core/src/engine/engine.ts`)의 remove 판정은 사실상
"호출 0회면 삭제" 하나다. `reason` 문자열 한 줄("정의 812토큰, 호출 0회")만으로는
사용자가 "정말 지워도 되나?"를 판단할 수 없다:

- 세션 2개 관찰과 3주 47세션 관찰이 같은 "0회"로 표시된다 (관찰량 불명).
- 한 번도 안 쓴 툴과 예전엔 쓰다가 요즘 안 쓰는 툴이 구분되지 않는다.
- 지우면 실제로 얼마나 아끼는지 누적 수치가 없다.

## 결정 사항 (브레인스토밍에서 확정)

1. **action 5종(`remove`/`filter-server`/`inspect`/`keep`/`unknown`)은 불변.**
   `confidence`를 직교 축으로 추가한다. action = "무엇을 하라", confidence = "얼마나 믿을 수 있나".
   `watch` 같은 새 action은 만들지 않는다 (상태 폭발·의미 왜곡·계약 파급 때문).
2. 확신 낮은 remove는 **판정 강등이 아니라 표시 강등** — 데이터는
   `action: 'remove', confidence: 'low'`, 표면이 "후보"로 렌더링한다.
3. 점수 모델(0~100)은 채택하지 않는다 — "왜 그 점수인가"를 설명 못 해
   설득력 문제를 오히려 악화시킨다. 규칙은 표 하나로 설명 가능한 수준을 유지한다.

## 1. 계약 변경 — `packages/core/src/types.ts` (공유 계약)

```ts
export interface RecommendationEvidence {
  /** 이 툴을 관찰한 것으로 인정되는 세션 수 */
  observedSessions: number;
  /** 관찰 창 길이 (일). 산정 불가 시 null */
  observedDays: number | null;
  /** 마지막 호출 시각 (ISO). 호출 이력 전무면 null */
  lastCalledAt: string | null;
  /** 세션당 부담 토큰 (= definitionTokens, 미확보 시 null) */
  costPerSession: number | null;
  /** 관찰 기간 누적 부담 (= costPerSession × observedSessions) */
  totalObservedCost: number | null;
}

export interface Recommendation {
  action: 'remove' | 'filter-server' | 'keep' | 'unknown' | 'inspect'; // 불변
  confidence: 'high' | 'medium' | 'low';   // 신규
  reason: string;
  evidenceLabel: '실측' | '하한 추정' | '전량 가정' | '측정 불가';
  evidence: RecommendationEvidence;        // 신규
}
```

`evidence`는 집계 과정에서 공짜로 나오므로 **모든 action에 균일하게 채운다**
(keep 행에서도 `lastCalledAt`은 유용하다).

## 2. 스키마 변경 — `tool_definitions.first_scanned_at`

현재 `scanned_at`은 upsert마다 덮어써져(`store.ts` `upsertDefinitions`)
"정의를 언제 처음 봤는지" 이력이 없다.

- `schema.sql`: `first_scanned_at TEXT` 컬럼 추가.
- **마이그레이션**: 스키마가 `CREATE TABLE IF NOT EXISTS`라 기존 DB엔 컬럼이 안 생긴다
  → 스토어 초기화 시 `PRAGMA table_info(tool_definitions)` 검사 후
  `ALTER TABLE ... ADD COLUMN`, 기존 행은 `scanned_at` 값으로 백필.
- **upsert 보존**: `ON CONFLICT ... DO UPDATE`에
  `first_scanned_at = COALESCE(tool_definitions.first_scanned_at, excluded.first_scanned_at)`
  — 최초 관찰값 영구 보존.
- `ToolDefinition`에 `firstScannedAt: string` 추가, `allDefinitions()` 매핑 갱신.

## 3. 관찰 창 산정 규칙 (엔진)

툴별 관찰 창:

- **시작** = min(정의 `firstScannedAt`, 그 서버의 활동(호출 또는 로드)이 있는
  가장 이른 세션의 `startedAt`)
- **끝** = 스코프 내 최대 세션 `startedAt`

근거: 스캔 전 세션이라도 그 서버의 호출/로드가 있으면 "서버가 구성돼 있었다"는
증거이므로 창을 확장한다. 활동 증거가 없으면 `firstScannedAt`부터만 인정 —
방금 추가된 서버가 과거 세션 이력으로 과대평가되는 것을 막는다 (성급함 방지의 핵심).

- `observedSessions` = 창 안에 `startedAt`이 있는 세션 수.
  `startedAt`이 null인 세션은 창 판정 불가 → **포함** (과소평가 방지, 한계로 문서화).
- `observedDays` = 창 시작~끝 일수. 대상 세션 0개면 null.
- `lastCalledAt` = 해당 툴 호출의 `calledAt` 최댓값 (null 가능).

## 4. 확신 등급 규칙

remove / filter-server:

| confidence | 조건 |
|---|---|
| high | observedSessions ≥ 10 **그리고** observedDays ≥ 7, lastCalledAt 없음 |
| medium | observedSessions ≥ 10이지만 과거 호출 이력 있음, **또는** observedSessions 5~9 |
| low | observedSessions < 5 **또는** observedDays < 3 (null 포함) |

- `inspect`: 기존 게이트(호출 ≥3회, 에러율 ≥50%) 유지. 표본 ≥10회면 high, 3~9회면 medium.
- `keep`: 호출 있음 = 자기 증명 → high 고정.
- `unknown`: low 고정.

경계 중첩 시 낮은 쪽이 이긴다 (예: observedSessions 5~9이면서 observedDays < 3 → low).

### reason 문구

- low ∧ (remove | filter-server): "관찰 부족 — N세션 누적 시 확정" 문구 포함, 확정 권고 아님을 명시.
- medium remove + 과거 호출 이력: 마지막 호출일 명시
  ("마지막 호출 YYYY-MM-DD — 저빈도 툴일 수 있음, 삭제보다 지연 로딩 유지 검토").
- high remove: 관찰량·누적 부담·복구 용이함(설정 한 줄) 포함.

## 5. 표면 반영

- **CLI `packages/cli/src/report.ts`**: table/ai 포맷에 `확신` 컬럼 추가.
  ai 포맷의 "## 권고"는 confidence 내림차순 정렬, low는
  "### 후보 (관찰 부족)" 하위 섹션으로 분리. json 포맷은 구조가 그대로 노출되므로 자동.
- **확장 사이드바**: remove 배지를 high/medium만 강조, low는 "후보" 라벨.
  구체 렌더링은 계획 단계에서 확장 코드 확인 후 확정.
- **대시보드**: 동결 표면(`packages/dashboard/README.md`) — 손대지 않는다.
  Recommendation을 소비만 하므로 필드 추가는 무영향이어야 하며, 빌드 통과만 확인.

## 6. 테스트

픽스처 + `:memory:` DB 원칙 유지 (CLAUDE.md).

- **엔진**: 확신 3케이스 (충분 관찰 remove-high / 관찰 부족 remove-low /
  과거 사용 remove-medium), 서버 활동 기반 창 확장, startedAt null 세션 처리,
  keep/unknown/inspect의 confidence 고정값.
- **스토어**: 구스키마 DB를 신스토어로 열 때 컬럼 추가·백필 검증,
  upsert 2회 후 `first_scanned_at` 보존 검증.
- **CLI**: 확신 컬럼·후보 섹션 출력 검증.

## 7. 비범위 (YAGNI)

- 점수 모델, 새 action 값.
- 세션 빈도 예측("주당 N토큰 절약" 환산).
- 대시보드 반영.
- 서버별 세션 귀속 정밀화 — `sessionCount`는 기존 근사(전체 세션 수) 유지.
