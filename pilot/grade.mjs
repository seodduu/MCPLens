#!/usr/bin/env node
// Pilot grader. Builds two independent pictures and compares them:
//
//   truth  <- our own stream-json transcripts   (the reference)
//   claim  <- MCP Lens report on an isolated DB (what is under test)
//
// The two are never allowed to touch. Deriving truth from Lens output would make every
// accuracy number circular.
//
//   node pilot/grade.mjs                      sync the isolated Lens DB, then compare
//   node pilot/grade.mjs --no-sync            compare using the DB as it already stands
//   node pilot/grade.mjs --configs deferred-all
//
// --configs restricts BOTH sides to the named configs. Row 2 needs it: search-pollution is a
// property of deferred sessions, and Lens aggregates cumulatively, so an eager run that calls
// the same tool would erase a pollution event observed under deferred loading.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PILOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(PILOT);
const WORK = path.join(PILOT, '.work');
const LENS_HOME = path.join(WORK, 'lenshome');
const CLI = path.join(REPO, 'packages', 'cli', 'dist', 'main.js');

const argv = process.argv.slice(2);
const noSync = argv.includes('--no-sync');
const scopeIdx = argv.indexOf('--configs');
const scope = scopeIdx >= 0 ? new Set((argv[scopeIdx + 1] ?? '').split(',').filter(Boolean)) : null;
if (scopeIdx >= 0 && (!scope || scope.size === 0)) {
  process.stderr.write('grade: --configs needs a comma-separated list\n');
  process.exit(2);
}

function die(msg) {
  process.stderr.write(`grade: ${msg}\n`);
  process.exit(2);
}

// Claude Code names a project log directory after its cwd with every non-alphanumeric
// character replaced by a dash.
function encodeProjectDir(absPath) {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

function readRuns() {
  const p = path.join(WORK, 'runs.jsonl');
  if (!fs.existsSync(p)) die('no runs yet; run pilot/runner.mjs first');
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readConfigs() {
  const dir = path.join(PILOT, 'configs');
  const out = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    out.set(c.name, c);
  }
  return out;
}

// ---------------------------------------------------------------- truth

// Only runs that passed the runner's guards are counted. A run with the wrong tool set is not
// comparable, and a failed run's absent calls would read as "never called".
function buildTruth(runs) {
  const byTool = new Map(); // "server/tool" -> { loadedRunCount, callCount, runsSeen }
  const perRun = [];

  const touch = (key) => {
    if (!byTool.has(key)) byTool.set(key, { loadedRunCount: 0, callCount: 0, runsSeen: 0 });
    return byTool.get(key);
  };
  const split = (name) => {
    const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
    return m ? `${m[1]}/${m[2]}` : null;
  };

  for (const r of runs) {
    if (!r.ok) continue;
    const calls = (r.toolUses || []).map(split).filter(Boolean);
    const loads = (r.toolLoads || []).map(split).filter(Boolean);
    for (const k of new Set([...calls, ...loads])) touch(k).runsSeen++;
    for (const k of new Set(loads)) touch(k).loadedRunCount++;
    for (const k of calls) touch(k).callCount++;

    const loadedNotCalled = [...new Set(loads)].filter((k) => !calls.includes(k));
    perRun.push({
      taskId: r.taskId, type: r.type, config: r.config,
      claudeSessionId: r.claudeSessionId,
      calls, loads, loadedNotCalled,
      usedSelect: (r.toolSearchQueries || []).some((q) => typeof q === 'string' && q.startsWith('select:')),
      keywordSearched: (r.toolSearchQueries || []).some((q) => typeof q === 'string' && !q.startsWith('select:')),
      cacheCreation: r.usage?.cache_creation_input_tokens ?? null,
      costUsd: r.costUsd, turns: r.turns,
    });
  }

  // Mirrors core engine.ts pickLoadPattern: cumulative across runs, not per session.
  const searchPollution = [...byTool.entries()]
    .filter(([, v]) => v.loadedRunCount > 0 && v.callCount === 0)
    .map(([k]) => k).sort();

  return { byTool: Object.fromEntries(byTool), searchPollution, perRun };
}

// ---------------------------------------------------------------- claim

function syncLens(runs) {
  const configs = [...new Set(runs.map((r) => r.config))];
  const projectsDir = path.join(LENS_HOME, '.claude', 'projects');
  // Wiped whole, not per config: a directory left over from a previous unscoped sync would be
  // ingested again and silently widen the scope.
  fs.rmSync(projectsDir, { recursive: true, force: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(path.join(LENS_HOME, '.mcplens'), { recursive: true });

  // Only the sessions of runs that passed the guards are copied in. A guard-failed or crashed
  // run still leaves a log behind, and ingesting it would add tool calls that the truth side
  // deliberately excludes: the same double-count that makes retries unsafe.
  const wanted = new Set(runs.filter((r) => r.ok && r.claudeSessionId).map((r) => r.claudeSessionId));
  const skipped = runs.filter((r) => !r.ok && r.claudeSessionId).length;

  // Copied, not symlinked: the log watcher does not follow symlinks (verified 2026-08-09).
  let copied = 0;
  for (const c of configs) {
    const cwd = path.join(WORK, 'runs', c);
    const name = encodeProjectDir(cwd);
    const src = path.join(os.homedir(), '.claude', 'projects', name);
    if (!fs.existsSync(src)) { process.stderr.write(`sync: no logs for config ${c}\n`); continue; }
    const dst = path.join(projectsDir, name);
    fs.rmSync(dst, { recursive: true, force: true }); // stale copies of now-excluded sessions
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      if (!f.endsWith('.jsonl')) continue;
      if (!wanted.has(path.basename(f, '.jsonl'))) continue;
      fs.copyFileSync(path.join(src, f), path.join(dst, f));
      copied++;
    }
  }
  process.stderr.write(
    `sync: copied ${copied} session logs into the isolated home` +
    `${skipped ? `, excluded ${skipped} from non-ok runs` : ''}\n`,
  );

  // The DB is rebuilt from scratch each sync so excluded sessions cannot survive from an
  // earlier pass. Ingestion is cheap; a stale row would be silent and wrong.
  fs.rmSync(path.join(LENS_HOME, '.mcplens', 'lens.db'), { force: true });

  // Definition tokens come from a live scan of the full server set, independent of which
  // config a given run used.
  const full = path.join(WORK, 'runs', 'upfront-all', 'mcp.json');
  if (fs.existsSync(full)) {
    execFileSync('node', [CLI, 'scan', '--config', full], {
      env: { ...process.env, HOME: LENS_HOME }, stdio: 'inherit',
    });
  } else {
    process.stderr.write('sync: upfront-all/mcp.json missing, skipping definition scan\n');
  }
}

function lensReport() {
  const raw = execFileSync('node', [CLI, 'report', '--format', 'json'], {
    env: { ...process.env, HOME: LENS_HOME }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

function lensSessions() {
  const db = path.join(LENS_HOME, '.mcplens', 'lens.db');
  if (!fs.existsSync(db)) return [];
  const raw = execFileSync('sqlite3', [db, '-json', 'SELECT session_id, mode, file_path FROM sessions;'], {
    encoding: 'utf8',
  }).trim();
  if (!raw) return [];
  return JSON.parse(raw).map((s) => ({
    ...s,
    // The Lens session_id is its own hash; the Claude uuid is the log file's basename.
    claudeSessionId: path.basename(s.file_path ?? '', '.jsonl') || null,
  }));
}

// ---------------------------------------------------------------- compare

// DEFERRED_OPAQUE is Lens abstaining ("no MCP evidence"), not a verdict. A run that called no
// tool carries no mode evidence at all, so scoring it as wrong would punish correct behaviour.
// Such runs are reported separately as abstentions.
function row1(perRun, sessions, configs) {
  const byClaudeId = new Map(sessions.map((s) => [s.claudeSessionId, s]));
  const rows = [];
  for (const r of perRun) {
    const expected = configs.get(r.config)?.allowToolSearch ? 'DEFERRED' : 'UPFRONT';
    const actual = byClaudeId.get(r.claudeSessionId)?.mode ?? null;
    const hadMcpEvidence = r.calls.length > 0 || r.loads.length > 0;
    let matched = null;
    if (actual != null && actual !== 'DEFERRED_OPAQUE') {
      matched = expected === 'UPFRONT' ? actual === 'UPFRONT' : actual.startsWith('DEFERRED');
    }
    rows.push({ taskId: r.taskId, config: r.config, expected, actual, matched, hadMcpEvidence });
  }
  const judged = rows.filter((r) => r.matched !== null);
  const abstained = rows.filter((r) => r.actual === 'DEFERRED_OPAQUE');
  return {
    total: rows.length,
    correct: judged.filter((r) => r.matched).length,
    judged: judged.length,
    unmatchedSessions: rows.filter((r) => r.actual == null).length,
    abstained: abstained.length,
    // An abstention on a run that DID use tools is a real miss: the evidence was there.
    abstainedDespiteEvidence: abstained.filter((r) => r.hadMcpEvidence)
      .map((r) => ({ taskId: r.taskId, config: r.config })),
    mismatches: judged.filter((r) => !r.matched),
  };
}

function row2(truth, lensRows) {
  const claimed = new Set(
    lensRows.filter((r) => r.loadPattern === 'search-pollution').map((r) => `${r.serverName}/${r.toolName}`),
  );
  const actual = new Set(truth.searchPollution);
  const truePos = [...actual].filter((k) => claimed.has(k));
  const falseNeg = [...actual].filter((k) => !claimed.has(k));
  const falsePos = [...claimed].filter((k) => !actual.has(k));
  return {
    actualCount: actual.size, claimedCount: claimed.size,
    truePositive: truePos.sort(), falseNegative: falseNeg.sort(), falsePositive: falsePos.sort(),
    note: actual.size === 0
      ? 'no pollution occurred, so detection accuracy is untested; check whether any run keyword-searched'
      : null,
  };
}

function row3(truth, lensRows) {
  const lens = new Map(lensRows.map((r) => [`${r.serverName}/${r.toolName}`, r.callCount ?? 0]));
  const keys = new Set([...Object.keys(truth.byTool), ...lens.keys()]);
  const diffs = [];
  let exact = 0;
  for (const k of [...keys].sort()) {
    const t = truth.byTool[k]?.callCount ?? 0;
    const l = lens.get(k) ?? 0;
    if (t === l) exact++;
    else diffs.push({ tool: k, truth: t, lens: l, delta: l - t });
  }
  return {
    tools: keys.size, exact, mismatched: diffs.length,
    missed: diffs.filter((d) => d.delta < 0),   // Lens undercounts
    phantom: diffs.filter((d) => d.delta > 0),  // Lens counts calls that never happened
  };
}

// ---------------------------------------------------------------- main

const allRuns = readRuns();
const runs = scope ? allRuns.filter((r) => scope.has(r.config)) : allRuns;
if (!runs.length) die(`no runs match --configs ${[...(scope ?? [])].join(',')}`);
const configs = readConfigs();
if (!noSync) syncLens(runs);

const truth = buildTruth(runs);
const report = lensReport();
const sessions = lensSessions();
const lensRows = report.rows ?? [];

const okRuns = runs.filter((r) => r.ok).length;
const results = {
  generatedFrom: { runs: runs.length, okRuns, configs: [...new Set(runs.map((r) => r.config))] },
  row1_modeDetection: row1(truth.perRun, sessions, configs),
  row2_searchPollution: row2(truth, lensRows),
  row3_callCounts: row3(truth, lensRows),
  searchBehaviour: {
    runsWithSelect: truth.perRun.filter((r) => r.usedSelect).length,
    runsWithKeywordSearch: truth.perRun.filter((r) => r.keywordSearched).length,
  },
};

const tag = scope ? `-${[...scope].sort().join('+')}` : '';
fs.writeFileSync(path.join(WORK, `truth${tag}.json`), `${JSON.stringify(truth, null, 2)}\n`);
fs.writeFileSync(path.join(WORK, `lens${tag}.json`), `${JSON.stringify({ rows: lensRows, sessions }, null, 2)}\n`);
fs.writeFileSync(path.join(WORK, `results${tag}.json`), `${JSON.stringify(results, null, 2)}\n`);

const r1 = results.row1_modeDetection;
const r2 = results.row2_searchPollution;
const r3 = results.row3_callCounts;
process.stdout.write([
  `runs: ${runs.length} (ok ${okRuns})`,
  `row 1 mode detection: ${r1.correct}/${r1.judged} correct` +
    (r1.unmatchedSessions ? `, ${r1.unmatchedSessions} runs had no Lens session` : ''),
  `row 2 search-pollution: actual ${r2.actualCount}, claimed ${r2.claimedCount}, ` +
    `hit ${r2.truePositive.length}, missed ${r2.falseNegative.length}, false alarm ${r2.falsePositive.length}` +
    (r2.note ? `\n        ${r2.note}` : ''),
  `row 3 call counts: ${r3.exact}/${r3.tools} tools exact, ` +
    `${r3.missed.length} undercounted, ${r3.phantom.length} phantom`,
  `search behaviour: select ${results.searchBehaviour.runsWithSelect}, ` +
    `keyword ${results.searchBehaviour.runsWithKeywordSearch}`,
  `written: .work/truth${tag}.json .work/lens${tag}.json .work/results${tag}.json`,
].join('\n') + '\n');
