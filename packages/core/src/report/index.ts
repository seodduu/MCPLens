// packages/core/src/report/index.ts
// 조치 중심 리포트의 공개 표면. 실물은 Wave 1에서 채워진다.
import type { ReportModel, ReportOptions } from './model.js';

export * from './model.js';

export { buildReport } from './rollup.js';

/**
 * ReportModel → 마크다운 문자열.
 * 구현: Task 36 — `./markdown.js`로 교체된다.
 */
export function renderReport(_model: ReportModel, _opts: ReportOptions): string {
  throw new Error('renderReport: not implemented (Task 36)');
}
