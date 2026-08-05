import { Fragment } from 'react';
import type { MatrixRow, RecommendationReason } from '@mcp-lens/core';

const ACTION_COLOR: Record<MatrixRow['recommendation']['action'], string> = {
  remove: '#d64545', // 빨강
  'filter-server': '#e08a2e', // 주황
  inspect: '#7a5cc4', // 보라 (점검)
  keep: '#2e9e5b', // 초록
  unknown: '#8a8a8a',
};

const ACTION_LABEL: Record<MatrixRow['recommendation']['action'], string> = {
  remove: '제거',
  'filter-server': '필터링',
  inspect: '점검',
  keep: '유지',
  unknown: '불명',
};

/** 툴, 정의 토큰, 호출 수, 응답 토큰, 로드된 세션, 전체 세션, 권고 */
const COLUMN_COUNT = 7;

/** 이 길이 미만의 이유 문장은 접지 않는다 (접어도 줄지 않고 뜻만 흐려진다). */
const FOLD_MIN_LENGTH = 40;

/**
 * 서버 공통 근거(serverBasis)를 뺀 "이 툴만의" 근거 문장.
 * 서버 단위 문장은 그룹 헤더에 한 번만 싣고, 행에는 툴별 내용만 남긴다.
 * 계산은 하지 않고 core가 준 조각을 고르고 잇기만 한다 (순수 표시 축약).
 */
function toolReasonText(parts: RecommendationReason): string {
  return [parts.basis, parts.effect, parts.caveat]
    .filter((p): p is string => p != null && p.trim() !== '')
    .join(' · ');
}

/**
 * 문장에서 숫자만 빼낸 "틀". 같은 틀이 이어지면 수치만 다른 같은 말이므로 접는다.
 * 예: "누적 부담 1,146,096토큰" 과 "누적 부담 854,448토큰" 은 같은 틀이다.
 */
function reasonShape(text: string): string {
  return text.replace(/[\d,]+/g, '#');
}

interface ServerGroup {
  serverName: string;
  /** 이 서버 툴들이 공유하는 권고 문장. 없으면 null */
  serverBasis: string | null;
  rows: MatrixRow[];
}

/** 행 순서(비용 내림차순)를 유지한 채 서버 단위로 묶는다. */
function groupByServer(rows: MatrixRow[]): ServerGroup[] {
  const groups = new Map<string, ServerGroup>();
  for (const row of rows) {
    let group = groups.get(row.serverName);
    if (!group) {
      group = { serverName: row.serverName, serverBasis: null, rows: [] };
      groups.set(row.serverName, group);
    }
    group.rows.push(row);
    const basis = row.recommendation.reasonParts.serverBasis;
    if (basis != null && group.serverBasis == null) group.serverBasis = basis;
  }
  return [...groups.values()];
}

/**
 * 3자리마다 쉼표. core의 문구 생성이 쓰는 것과 같은 방식이라 한 열에서 표기가 엇갈리지 않는다.
 * `toLocaleString()`은 실행 환경 로케일을 타므로 쓰지 않는다.
 */
function withThousands(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 접힌 행에 남길 한 줄. 수치는 core가 준 evidence 값을 형식만 바꿔 쓴다. */
function shortFacts(row: MatrixRow): string {
  const cost = row.recommendation.evidence.totalObservedCost;
  if (cost != null) return `누적 부담 ${withThousands(cost)}토큰 (권고 근거는 위와 같음)`;
  return '위와 같음';
}

export interface MatrixTableProps {
  rows: MatrixRow[];
}

export function MatrixTable({ rows }: MatrixTableProps) {
  if (rows.length === 0) {
    return <p>표시할 매트릭스 데이터가 없습니다.</p>;
  }

  const groups = groupByServer(rows);

  return (
    <table className="matrix-table">
      <thead>
        <tr>
          <th>툴</th>
          <th>정의 토큰</th>
          <th>호출 수</th>
          <th>응답 토큰</th>
          <th>로드된 세션</th>
          <th>전체 세션</th>
          <th>권고</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => {
          // 서버 안에서 이미 한 번 보여 준 틀은 두 번째부터 수치 한 줄로 접는다.
          // 사이에 다른 권고 행이 끼어도 접힘이 풀리지 않게 집합으로 기억한다.
          const shownShapes = new Set<string>();
          return (
            <Fragment key={group.serverName}>
              <tr className="server-group-row">
                <th colSpan={COLUMN_COUNT} scope="colgroup">
                  <span className="server-group-name">{group.serverName}</span>
                  <span className="server-group-count">툴 {group.rows.length}개</span>
                  {group.serverBasis && (
                    <span className="server-group-note">{group.serverBasis}</span>
                  )}
                </th>
              </tr>
              {group.rows.map((row) => {
                const reason = toolReasonText(row.recommendation.reasonParts);
                const shape = `${row.recommendation.action}|${reasonShape(reason)}`;
                // 짧은 문장("8회 호출됨")은 접어 봐야 얻는 것이 없고 뜻만 흐려진다.
                const folded =
                  reason.length >= FOLD_MIN_LENGTH && shownShapes.has(shape);
                shownShapes.add(shape);
                return (
                  <tr key={`${row.serverName}/${row.toolName}`}>
                    <td className="cell-tool">{row.toolName}</td>
                    <td className="cell-num">
                      {row.definitionTokens != null ? withThousands(row.definitionTokens) : '—'}
                    </td>
                    <td className="cell-num">{withThousands(row.callCount)}</td>
                    <td className="cell-num">{withThousands(row.responseTokens)}</td>
                    <td className="cell-num">{row.loadedSessionCount}</td>
                    <td className="cell-num">{row.sessionCount}</td>
                    <td className="cell-recommendation">
                      <span
                        className="recommendation-badge"
                        style={{ backgroundColor: ACTION_COLOR[row.recommendation.action] }}
                        title={row.recommendation.reason}
                      >
                        {ACTION_LABEL[row.recommendation.action]}
                      </span>
                      <span
                        className={
                          folded ? 'recommendation-reason is-folded' : 'recommendation-reason'
                        }
                        title={row.recommendation.reason}
                      >
                        {folded ? shortFacts(row) : reason}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
