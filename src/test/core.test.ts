import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyPreset, defaultConfig, loadConfig, normalizeConfig, saveConfig } from '../core/config.js';
import { classifyFailure, normalizeSignature } from '../core/errors.js';
import { appendRecord, readRecords } from '../core/history.js';
import { isInside, resolveWorkspacePath } from '../core/paths.js';
import { redact } from '../core/redact.js';
import { runProcess } from '../core/process.js';
import { activeTools, dormantToolNames, setToolState } from '../optimization/dormancy.js';
import { budgetState, summarizeCosts } from '../optimization/cost.js';
import { LoopGuard } from '../optimization/loop-guard.js';
import { isolatedHome } from './helpers.js';
import type { TaskResult } from '../core/types.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'chimera-core-'));
}

test('config: defaults are valid and never enable multi-AI silently', () => {
  const c = defaultConfig();
  assert.equal(c.multiAi.enabled, false);
  assert.equal(c.setupCompleted, false);
  assert.equal(c.defaultSandbox, 'read-only');
});

test('config: invalid values are replaced by defaults, not trusted', () => {
  const { config } = normalizeConfig({
    preset: 'hacker',
    defaultSandbox: 'danger-full-access',
    multiAi: { mainAgent: 'rm -rf', maxCalls: 9999 },
    optimization: { tools: [{ name: '../evil', state: 'ACTIVE' }, { name: 'WebFetch', state: 'NOPE' }] },
  });
  assert.equal(config.preset, 'lite');
  assert.equal(config.defaultSandbox, 'read-only');
  assert.equal(config.multiAi.mainAgent, 'codex');
  assert.equal(config.multiAi.maxCalls, 10);
  assert.deepEqual(config.optimization.tools, [{ name: 'WebFetch', description: '', state: 'ACTIVE' }]);
});

test('config: presets set starting values only', () => {
  const base = defaultConfig();
  assert.equal(applyPreset(base, 'lite').multiAi.enabled, false);
  assert.equal(applyPreset(base, 'standard').multiAi.mode, 'manual');
  assert.equal(applyPreset(base, 'research').multiAi.mode, 'auto');
});

test('config: save then load round-trips and keeps a backup of the previous file', () => {
  const home = isolatedHome();
  const path = join(home, 'config.json');
  saveConfig({ ...defaultConfig(), preset: 'standard' }, path);
  saveConfig({ ...defaultConfig(), preset: 'research' }, path);
  const loaded = loadConfig(path);
  assert.equal(loaded.source, 'file');
  assert.equal(loaded.config.preset, 'research');
  assert.ok(existsSync(`${path}.bak`), 'previous version must be kept as .bak');
  assert.equal(JSON.parse(readFileSync(`${path}.bak`, 'utf8')).preset, 'standard');
});

test('config: a corrupt file is restored from the backup and the corrupt copy is kept', () => {
  const home = isolatedHome();
  const path = join(home, 'config.json');
  saveConfig({ ...defaultConfig(), preset: 'standard' }, path);
  saveConfig({ ...defaultConfig(), preset: 'standard' }, path);
  writeFileSync(path, '{ this is not json', 'utf8');
  const loaded = loadConfig(path);
  assert.equal(loaded.source, 'backup');
  assert.equal(loaded.config.preset, 'standard');
  assert.ok(existsSync(`${path}.corrupt`), 'the broken file must not be deleted');
});

test('config: a corrupt file with no backup falls back to defaults with a warning', () => {
  const home = isolatedHome();
  const path = join(home, 'config.json');
  writeFileSync(path, 'broken', 'utf8');
  const loaded = loadConfig(path);
  assert.equal(loaded.source, 'defaults');
  assert.ok(loaded.warnings.length > 0);
});

test('process: a .cmd launch refuses arguments that cmd.exe would interpret', { skip: process.platform !== 'win32' }, async () => {
  const out = await runProcess({ command: 'C:\\tools\\agent.cmd', args: ['-C', 'folder&calc'], cwd: process.cwd(), timeoutMs: 1000 });
  assert.match(String(out.spawnError), /unsafe-cmd-arguments/);
  assert.equal(out.code, null, 'nothing must have been started');
});

test('config: the executable override must be an absolute path, otherwise it is dropped', () => {
  assert.equal(normalizeConfig({ agents: { codex: { executable: 'codex' } } }).config.agents.codex.executable, null);
  assert.equal(normalizeConfig({ agents: { codex: { executable: '/usr/bin/codex' } } }).config.agents.codex.executable, '/usr/bin/codex');
});

test('redact: removes API keys, bearer tokens and key=value secrets', () => {
  const text = 'key sk-abcdefghijklmnop1234 and Authorization: Bearer abcdef123456789 api_key=supersecretvalue';
  const out = redact(text);
  assert.ok(!out.includes('sk-abcdefghijklmnop1234'));
  assert.ok(!out.includes('abcdef123456789'));
  assert.ok(!out.includes('supersecretvalue'));
  assert.ok(out.includes('[REDACTED]'));
});

test('redact: removes explicitly known secret values', () => {
  assert.equal(redact('token is hunter2hunter2 here', ['hunter2hunter2']), 'token is [REDACTED] here');
});

test('paths: workspace check rejects escapes and accepts subfolders', () => {
  const root = freshDir();
  mkdirSync(join(root, 'sub'));
  assert.ok(resolveWorkspacePath(root, 'sub').endsWith('sub'));
  assert.throws(() => resolveWorkspacePath(root, '..'), /outside the workspace root/);
  assert.throws(() => resolveWorkspacePath(root, 'missing-folder'), /does not exist/);
  assert.equal(isInside('/a/b', '/a/b/c'), true);
  assert.equal(isInside('/a/b', '/a/bc'), false);
});

test('errors: classifies auth, rate limit, not installed and timeout', () => {
  const base = { spawnError: null, exitCode: 1, stdout: '', stderr: '', timedOut: false, cancelled: false };
  assert.equal(classifyFailure({ ...base, stderr: 'Error: not logged in' }).kind, 'not_authenticated');
  assert.equal(classifyFailure({ ...base, stderr: '429 Too Many Requests' }).kind, 'rate_limited');
  assert.equal(classifyFailure({ ...base, spawnError: 'ENOENT' }).kind, 'not_installed');
  assert.equal(classifyFailure({ ...base, timedOut: true }).kind, 'timeout');
  assert.equal(classifyFailure({ ...base, stderr: 'boom' }).kind, 'agent_failed');
});

test('errors: signatures mask counters and paths so repeats match', () => {
  assert.equal(normalizeSignature('Failed at line 12 in C:\\x\\y.ts'), normalizeSignature('Failed at line 98 in C:\\x\\y.ts'));
});

test('loop guard: non-retryable errors stop at once', () => {
  const guard = new LoopGuard({ enabled: true, maxRetries: 2, stopAfterSameErrors: 3 });
  const r = { agent: 'codex', errorKind: 'not_authenticated', errorSignature: 'x' } as TaskResult;
  assert.equal(guard.decide(r, 0).action, 'stop');
});

test('loop guard: retries are capped, then the method changes', () => {
  const guard = new LoopGuard({ enabled: true, maxRetries: 2, stopAfterSameErrors: 9 });
  const r = { agent: 'claude', errorKind: 'agent_failed', errorSignature: 'sig' } as TaskResult;
  assert.equal(guard.decide(r, 0).action, 'retry');
  assert.equal(guard.decide(r, 1).action, 'retry');
  assert.equal(guard.decide(r, 2).action, 'change_method');
});

test('loop guard: the same failure repeated N times stops', () => {
  const guard = new LoopGuard({ enabled: true, maxRetries: 9, stopAfterSameErrors: 3 });
  const r = { agent: 'local', errorKind: 'agent_failed', errorSignature: 'same' } as TaskResult;
  guard.decide(r, 0);
  guard.decide(r, 1);
  const third = guard.decide(r, 2);
  assert.equal(third.action, 'stop');
  assert.match(third.reason, /3 times/);
});

test('loop guard: when disabled, nothing is retried', () => {
  const guard = new LoopGuard({ enabled: false, maxRetries: 5, stopAfterSameErrors: 5 });
  const r = { agent: 'codex', errorKind: 'agent_failed', errorSignature: 's' } as TaskResult;
  assert.equal(guard.decide(r, 0).action, 'stop');
});

function record(agent: string, status: TaskResult['status'], costUsd: number | null, inTok: number | null, recordedAt = new Date().toISOString()) {
  return {
    recordedAt,
    role: 'task' as const,
    groupId: 'g',
    mode: 'L0' as const,
    kind: null,
    prompt: 'p',
    result: {
      taskId: 't',
      agent,
      status,
      output: '',
      model: null,
      errorKind: null,
      errorMessage: null,
      errorSignature: null,
      usage: { inputTokens: inTok, outputTokens: inTok === null ? null : 1 },
      costUsd,
      startedAt: recordedAt,
      durationMs: 10,
    },
  };
}

test('cost: unreported values stay unknown and are never estimated', () => {
  const rows = summarizeCosts([record('codex', 'success', null, null), record('codex', 'success', 0.5, 10)]);
  assert.equal(rows[0].reportedCostUsd, 0.5);
  assert.equal(rows[0].costUnknownRuns, 1);
  assert.equal(rows[0].tokenUnknownRuns, 1);
  const onlyUnknown = summarizeCosts([record('local', 'failed', null, null)]);
  assert.equal(onlyUnknown[0].reportedCostUsd, null);
  assert.equal(onlyUnknown[0].inputTokens, null);
});

test('cost: budget states distinguish within, exceeded and unverified', () => {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const recs = [record('claude', 'success', 2, 1)];
  assert.equal(budgetState(recs, 'claude', 5, since).state, 'within');
  assert.equal(budgetState(recs, 'claude', 1, since).state, 'exceeded');
  const withUnknown = [...recs, record('claude', 'success', null, null)];
  assert.equal(budgetState(withUnknown, 'claude', 5, since).state, 'unverified');
  assert.equal(budgetState(recs, 'claude', null, since).state, 'no_limit');
});

test('dormancy: states change without deleting tools, and dormant tools are excluded', () => {
  const tools = [
    { name: 'WebFetch', description: '', state: 'ACTIVE' as const },
    { name: 'Bash', description: '', state: 'ACTIVE' as const },
  ];
  const sealed = setToolState(tools, 'WebFetch', 'DORMANT');
  assert.equal(sealed.length, 2, 'tool must not be deleted');
  assert.deepEqual(activeTools(sealed).map((t) => t.name), ['Bash']);
  assert.deepEqual(dormantToolNames(sealed), ['WebFetch']);
  const restored = setToolState(sealed, 'WebFetch', 'ACTIVE');
  assert.deepEqual(activeTools(restored).map((t) => t.name), ['WebFetch', 'Bash']);
  assert.throws(() => setToolState(tools, 'Missing', 'DORMANT'), /Unknown tool/);
});

test('history: prompts and outputs are redacted on write, bad lines are skipped on read', () => {
  const home = isolatedHome();
  const file = join(home, 'history.jsonl');
  const r = record('codex', 'success', null, 1);
  appendRecord({ ...r, prompt: 'use sk-abcdefghijklmnop1234 please' }, file, []);
  writeFileSync(file, readFileSync(file, 'utf8') + 'not json\n', 'utf8');
  const read = readRecords(file);
  assert.equal(read.records.length, 1);
  assert.equal(read.skippedLines, 1);
  assert.ok(!read.records[0].prompt.includes('sk-abcdefghijklmnop1234'));
});
