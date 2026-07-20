// packages/core/src/report/index.ts
// 조치 중심 리포트의 공개 표면. 실물은 Wave 1에서 채워진다.
import type { ReportModel, ReportOptions } from './model.js';

export * from './model.js';

export { buildReport } from './rollup.js';

export { renderReport } from './markdown.js';
