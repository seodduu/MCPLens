import type { MatrixRow } from '@mcp-lens/core';

const ACTION_COLOR: Record<MatrixRow['recommendation']['action'], string> = {
  remove: '#d64545', // 빨강
  'filter-server': '#e08a2e', // 주황
  keep: '#2e9e5b', // 초록
  unknown: '#8a8a8a',
};

const ACTION_LABEL: Record<MatrixRow['recommendation']['action'], string> = {
  remove: '제거',
  'filter-server': '필터링',
  keep: '유지',
  unknown: '불명',
};

export interface MatrixTableProps {
  rows: MatrixRow[];
}

export function MatrixTable({ rows }: MatrixTableProps) {
  if (rows.length === 0) {
    return <p>표시할 매트릭스 데이터가 없습니다.</p>;
  }

  return (
    <table className="matrix-table">
      <thead>
        <tr>
          <th>서버</th>
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
        {rows.map((row) => (
          <tr key={`${row.serverName}/${row.toolName}`}>
            <td>{row.serverName}</td>
            <td>{row.toolName}</td>
            <td>{row.definitionTokens ?? '—'}</td>
            <td>{row.callCount}</td>
            <td>{row.responseTokens}</td>
            <td>{row.loadedSessionCount}</td>
            <td>{row.sessionCount}</td>
            <td>
              <span
                className="recommendation-badge"
                style={{ backgroundColor: ACTION_COLOR[row.recommendation.action] }}
                title={row.recommendation.reason}
              >
                {ACTION_LABEL[row.recommendation.action]}
              </span>
              <span className="recommendation-reason">{row.recommendation.reason}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
