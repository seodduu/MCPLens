import type {
  DependencyStatus,
  InferenceBatch,
  PredictedPrerequisite,
  ToolDependencyResult,
  ValidatedInferenceResult,
} from './types.js';

const STATUSES = new Set<DependencyStatus>(['Independent', 'Review required', 'Dependent']);
const ENGLISH_TEXT = /^[\x20-\x7E]+$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function nullableIndependentText(
  value: unknown,
  field: string,
  status: DependencyStatus,
  maxLength: number,
): string | null {
  if (status !== 'Independent') return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || !ENGLISH_TEXT.test(value)) {
    throw new Error(`${field} must be 1-${maxLength} character English display text for Independent`);
  }
  return value;
}

function expectedToolKeys(batch: InferenceBatch): Set<string> {
  return new Set(batch.servers.flatMap((server) =>
    server.tools.map((tool) => `${server.serverName}\u0000${tool.toolName}`)));
}

/** Maps every tool name in the batch to the servers that declare it. */
function serversByToolName(batch: InferenceBatch): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const server of batch.servers) {
    for (const tool of server.tools) {
      const existing = owners.get(tool.toolName);
      if (existing === undefined) owners.set(tool.toolName, new Set([server.serverName]));
      else existing.add(server.serverName);
    }
  }
  return owners;
}

/**
 * Advisory field: a malformed entry is dropped instead of failing the batch, because the
 * three-tier verdict stands without it and discarding a paid batch costs more.
 */
function validatePredictedPrerequisites(batch: InferenceBatch, value: unknown): PredictedPrerequisite[] {
  if (!Array.isArray(value)) return [];
  const owners = serversByToolName(batch);
  const kept: PredictedPrerequisite[] = [];

  for (const raw of value) {
    if (!isObject(raw)) continue;
    const { toolName, requires, basis } = raw;
    if (typeof toolName !== 'string' || typeof basis !== 'string' || basis.trim().length === 0) continue;
    if (!Array.isArray(requires)) continue;
    const toolServers = owners.get(toolName);
    if (toolServers === undefined) continue;

    const keptRequires = requires.filter((name): name is string => {
      if (typeof name !== 'string' || name === toolName) return false;
      const requiredServers = owners.get(name);
      if (requiredServers === undefined) return false;
      // Server boundary: a prerequisite only counts inside the server that declares the tool.
      return [...requiredServers].some((serverName) => toolServers.has(serverName));
    });
    if (keptRequires.length === 0) continue;

    kept.push({ toolName, requires: keptRequires, basis });
  }

  return kept;
}

export function validateInferenceOutput(batch: InferenceBatch, value: unknown): ValidatedInferenceResult {
  if (!isObject(value) || !Array.isArray(value.results)) {
    throw new Error('inference output must contain a results array');
  }

  const expected = expectedToolKeys(batch);
  const seen = new Set<string>();
  const results: ToolDependencyResult[] = value.results.map((raw, index) => {
    if (!isObject(raw)) throw new Error(`results[${index}] must be an object`);
    const serverName = stringValue(raw.serverName, `results[${index}].serverName`);
    const toolName = stringValue(raw.toolName, `results[${index}].toolName`);
    const key = `${serverName}\u0000${toolName}`;
    if (!expected.has(key)) throw new Error(`unexpected result tool ${serverName}/${toolName}`);
    if (seen.has(key)) throw new Error(`duplicate result tool ${serverName}/${toolName}`);
    seen.add(key);

    const status = raw.status;
    if (typeof status !== 'string' || !STATUSES.has(status as DependencyStatus)) {
      throw new Error(`results[${index}].status is invalid`);
    }
    const typedStatus = status as DependencyStatus;
    const dependedOnBy = Array.isArray(raw.dependedOnBy)
      ? raw.dependedOnBy.map((item) => stringValue(item, `results[${index}].dependedOnBy[]`))
      : (() => { throw new Error(`results[${index}].dependedOnBy must be an array`); })();

    return {
      serverName,
      toolName,
      status: typedStatus,
      dependedOnBy,
      rationale: stringValue(raw.rationale, `results[${index}].rationale`),
      displaySummary: nullableIndependentText(raw.displaySummary, `results[${index}].displaySummary`, typedStatus, 140),
      whatYouLose: nullableIndependentText(raw.whatYouLose, `results[${index}].whatYouLose`, typedStatus, 280),
      riskWithoutTool: nullableIndependentText(raw.riskWithoutTool, `results[${index}].riskWithoutTool`, typedStatus, 280),
    };
  });

  if (seen.size !== expected.size) {
    throw new Error(`result tool set mismatch: expected ${expected.size}, got ${seen.size}`);
  }

  return {
    results,
    predictedPrerequisites: validatePredictedPrerequisites(batch, value.predictedPrerequisites),
  };
}
