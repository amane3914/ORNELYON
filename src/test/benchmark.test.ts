import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendRecord, type RunRecord } from '../core/history.js';
import { initialEvidence } from '../core/evidence.js';
import { packageRoot } from '../core/paths.js';
import { buildRows, compare, summarize, syntheticHistory, cohortStats, selectRows } from '../optimization/benchmark.js';
import { summarizeCosts } from '../optimization/cost.js';
import type { AgentAdapter, RunStatus } from '../core/types.js';
import { CALL_ROLES } from '../core/history.js';
import { defaultConfig } from '../core/config.js';
import { orchestrate } from '../orchestrator/orchestrator.js';
import { FakeAdapter } from './fake-adapter.js';
import { isolatedHome } from './helpers.js';

/*
 * v0.4.0 Efficiency Benchmark tests. Records are built by hand so every expected number is worked out
 * independently of the code under test. No agent is called anywhere in this file.
 */

let counter = 0;
const gid = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

interface CallSpec {
  agent?: string;
  role?: 'task' | 'review' | 'fallback';
  status?: RunStatus;
  tokens?: [number, number] | null;
  cost?: number | null;
  ms?: number;
  model?: string | null;
}

/** One user task as history writes it: call records, then a summary that repeats the last result. */
function task(calls: CallSpec[], o: { kind?: string | null; prompt?: string; at?: string; verification?: boolean; handoff?: boolean } = {}): RunRecord[] {
  const groupId = gid();
  const at = o.at ?? '2026-03-01T10:00:00.000Z';
  const out: RunRecord[] = [];
  calls.forEach((c, i) => {
    out.push({
      recordedAt: at,
      role: c.role ?? (i === 0 ? 'task' : 'review'),
      groupId,
      mode: 'L2',
      kind: o.kind === undefined ? 'code' : o.kind,
      prompt: o.prompt ?? `request ${groupId}`,
      result: {
        taskId: `${groupId}-${i}`,
        agent: c.agent ?? 'claude',
        status: c.status ?? 'success',
        output: 'out',
        model: c.model ?? null,
        errorKind: null,
        errorMessage: null,
        errorSignature: null,
        usage: c.tokens === null ? { inputTokens: null, outputTokens: null } : { inputTokens: (c.tokens ?? [100, 50])[0], outputTokens: (c.tokens ?? [100, 50])[1] },
        costUsd: c.cost === undefined ? 0.01 : c.cost,
        startedAt: at,
        durationMs: c.ms ?? 1000,
      },
    });
  });
  const last = out[out.length - 1];
  const evidence = initialEvidence({
    status: last.result.status,
    sandbox: 'read-only',
    verificationRequired: o.verification === true,
    checks: o.verification ? [{ name: 'f', kind: 'file', result: 'PASS', detail: 'ok' }] : [],
    changedFiles: [],
  });
  out.push({ ...last, role: 'summary', evidence, notes: o.handoff ? ['handoff-from:11111111-1111-4111-8111-111111111111'] : [] });
  return out;
}

const close = (a: number | null, b: number): void => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${String(a)} != ${b}`);

test('totals match hand-worked figures and summary records are not counted as calls', () => {
  const records = [
    ...task([{ cost: 0.1, tokens: [1000, 200], ms: 4000 }]),
    ...task([{ cost: 0.2, tokens: [2000, 400], ms: 6000 }, { agent: 'codex', cost: 0.05, tokens: [500, 100], ms: 1000 }]),
  ];
  const s = cohortStats(buildRows(records).rows);
  assert.equal(s.tasks, 2);
  assert.equal(s.calls, 3);
  assert.equal(s.extraCalls, 1);
  close(s.costUsd.sum, 0.35);
  close(s.costUsd.mean, 0.175);
  assert.equal(s.inputTokens.sum, 3500);
  assert.equal(s.outputTokens.sum, 700);
  assert.equal(s.durationMs.sum, 11000);
  close(s.extraCostUsd.sum, 0.05);
  close(s.costPerSuccessUsd, 0.175);
  // The existing cost monitor agrees on the same history, so the two views cannot drift apart.
  const old = summarizeCosts(records);
  close(old.reduce((a, r) => a + (r.reportedCostUsd ?? 0), 0), 0.35);
  assert.equal(old.reduce((a, r) => a + (r.inputTokens ?? 0), 0), 3500);
});

test('a call that appears twice is counted once', () => {
  const t = task([{ cost: 0.1 }]);
  const records = [...t, t[0], t[0]];
  const built = buildRows(records);
  assert.equal(built.duplicateCallsSkipped, 2);
  assert.equal(cohortStats(built.rows).calls, 1);
  close(cohortStats(built.rows).costUsd.sum, 0.1);
});

test('unreported cost and tokens stay unknown and are never filled in', () => {
  const records = [
    ...task([{ cost: 0.1, tokens: [100, 10] }]),
    ...task([{ cost: null, tokens: null }]),
    ...task([{ cost: 0.3, tokens: [300, 30] }, { cost: null, tokens: [10, 1], role: 'review' }]), // one unreported call makes the whole task unknown
  ];
  const s = cohortStats(buildRows(records).rows);
  assert.equal(s.tasks, 3);
  assert.equal(s.costUsd.n, 1);
  assert.equal(s.costUsd.unknown, 2);
  close(s.costUsd.sum, 0.1);
  close(s.costUsd.mean, 0.1);
  // Tokens are known for the first and third task (both calls of the third reported them), unknown for the second.
  assert.equal(s.inputTokens.n, 2);
  assert.equal(s.inputTokens.unknown, 1);
  assert.equal(s.inputTokens.sum, 410);
  assert.equal(s.costPerSuccessUsd, null, 'cost per success needs every task to report its cost');
  // Nothing reported at all: the totals are null, not zero.
  const none = cohortStats(buildRows(task([{ cost: null, tokens: null }])).rows);
  assert.equal(none.costUsd.sum, null);
  assert.equal(none.costUsd.mean, null);
  assert.equal(none.inputTokens.sum, null);
});

test('shapes: single, multi (review or fallback added) and handoff', () => {
  const records = [
    ...task([{}]),
    ...task([{}, { agent: 'codex' }]),
    ...task([{}], { handoff: true }),
  ];
  const rows = buildRows(records).rows;
  assert.deepEqual(rows.map((r) => r.shape).sort(), ['handoff', 'multi', 'single']);
  assert.equal(rows.find((r) => r.shape === 'multi')?.extraCalls, 1);
  assert.equal(rows.find((r) => r.shape === 'handoff')?.promptKey, null, 'a generated handoff prompt is never paired');
});

test('failed and unavailable tasks are tasks with no success, and decisions add no usage', () => {
  const failed = task([{ status: 'failed', cost: 0.02 }]);
  const ok = task([{ cost: 0.04 }], { verification: true });
  const decision: RunRecord = { ...ok[ok.length - 1], role: 'decision', evidence: { ...ok[ok.length - 1].evidence!, acceptance: 'ACCEPTED' } };
  const s = cohortStats(buildRows([...failed, ...ok, decision]).rows);
  assert.equal(s.tasks, 2);
  assert.equal(s.calls, 2);
  assert.equal(s.executionSuccess, 1);
  assert.equal(s.verificationPass, 1);
  assert.equal(s.accepted, 1, 'the user decision is read from the newest evidence');
  close(s.costUsd.sum, 0.06);
  close(s.costPerSuccessUsd, 0.06);
});

test('the same history always gives the same report; a changed value changes the hash', () => {
  const records = syntheticHistory(7, 30);
  const a = summarize(records, {}, 'shape');
  const b = summarize(syntheticHistory(7, 30), {}, 'shape');
  assert.deepEqual(a, b);
  assert.notEqual(summarize(syntheticHistory(8, 30), {}, 'shape').dataSha256, a.dataSha256);
  const edited = syntheticHistory(7, 30);
  edited[0] = { ...edited[0], result: { ...edited[0].result, costUsd: 9.99 } };
  assert.notEqual(summarize(edited, {}, 'shape').dataSha256, a.dataSha256);
});

test('synthetic and fake data is flagged and never called like-for-like', () => {
  const records = syntheticHistory(1, 20);
  const report = compare(records, { shape: 'single' }, { shape: 'multi' });
  assert.equal(report.likeForLike, false);
  assert.ok(report.caveats.some((c) => /fake, test or synthetic/.test(c)));
  assert.ok(summarize(records, {}, 'none').notes.some((n) => /say nothing about real token or cost savings/.test(n)));
  // A fake model name on an otherwise normal agent is flagged too.
  const fake = buildRows(task([{ model: 'fake-model' }])).rows[0];
  assert.equal(fake.nonRealCalls, 1);
});

test('compare: pairs identical requests, lists what differs, and refuses to call small or mixed groups alike', () => {
  const a = [
    ...task([{ agent: 'claude', cost: 0.10, tokens: [1000, 100], ms: 2000 }], { prompt: 'same request 1' }),
    ...task([{ agent: 'claude', cost: 0.20, tokens: [2000, 200], ms: 4000 }], { prompt: 'same request 2' }),
  ];
  const b = [
    ...task([{ agent: 'claude', cost: 0.10, tokens: [1000, 100], ms: 2000 }, { agent: 'codex', cost: 0.05, tokens: [400, 40], ms: 1000 }], { prompt: 'same request 1', kind: 'text' }),
    ...task([{ agent: 'claude', cost: 0.20, tokens: [2000, 200], ms: 4000 }, { agent: 'codex', cost: 0.06, tokens: [500, 50], ms: 1000 }], { prompt: 'same request 2', kind: 'text' }),
  ];
  // Cohorts are told apart by when they ran.
  const timed = [
    ...a.map((r) => ({ ...r, recordedAt: '2026-03-01T00:00:00.000Z' })),
    ...b.map((r) => ({ ...r, recordedAt: '2026-03-02T00:00:00.000Z' })),
  ];
  const r = compare(timed, { until: '2026-03-02T00:00:00.000Z' }, { since: '2026-03-02T00:00:00.000Z' });
  assert.equal(r.a.stats.tasks, 2);
  assert.equal(r.b.stats.tasks, 2);
  assert.equal(r.paired.pairs, 2);
  close(r.paired.cost.a, 0.30);
  close(r.paired.cost.b, 0.41);
  assert.equal(r.paired.calls.a, 2);
  assert.equal(r.paired.calls.b, 4);
  close(r.perTask.calls.ratio, 2);
  close(r.perTask.costUsd.diff, 0.055);
  assert.equal(r.likeForLike, false);
  assert.ok(r.caveats.some((c) => /fewer than 5 tasks/.test(c)));
  assert.ok(r.caveats.some((c) => /Task kinds differ/.test(c)));
  assert.ok(r.caveats.some((c) => /Final agents|observational/i.test(c)));
});

test('compare: unknown on either side gives no ratio instead of a guess', () => {
  const records = [...task([{ cost: null, tokens: null }], { at: '2026-03-01T00:00:00.000Z' }), ...task([{ cost: 0.1 }], { at: '2026-03-03T00:00:00.000Z' })];
  const r = compare(records, { until: '2026-03-02T00:00:00.000Z' }, { since: '2026-03-02T00:00:00.000Z' });
  assert.equal(r.perTask.costUsd.a, null);
  assert.equal(r.perTask.costUsd.diff, null);
  assert.equal(r.perTask.costUsd.ratio, null);
  assert.equal(r.paired.pairs, 0);
});

test('selectors filter by agent, kind, shape and time', () => {
  const rows = buildRows([
    ...task([{ agent: 'claude' }], { kind: 'code', at: '2026-03-01T00:00:00.000Z' }),
    ...task([{ agent: 'codex' }], { kind: 'text', at: '2026-03-05T00:00:00.000Z' }),
  ]).rows;
  assert.equal(selectRows(rows, { agent: 'codex' }).length, 1);
  assert.equal(selectRows(rows, { kind: 'code' }).length, 1);
  assert.equal(selectRows(rows, { shape: 'multi' }).length, 0);
  assert.equal(selectRows(rows, { since: '2026-03-03T00:00:00.000Z' }).length, 1);
});

test('the benchmark module cannot call an agent, and the CLI reads history without changing it', () => {
  const src = readFileSync(join(packageRoot(), 'dist', 'optimization', 'benchmark.js'), 'utf8');
  assert.ok(!/from '\.\.\/(agents|orchestrator|interface)\//.test(src), 'benchmark.js must not import agents, the orchestrator or the service');
  assert.ok(!/node:child_process|node:http|node:net|fetch\(/.test(src));

  const home = mkdtempSync(join(tmpdir(), 'ornelyon-bench-'));
  const file = join(home, 'history.jsonl');
  for (const r of task([{ cost: 0.1 }])) {
    appendRecord(r, file);
  }
  const before = createHash('sha256').update(readFileSync(file)).digest('hex');
  const env = { ...process.env, ORNELYON_HOME: home, CHIMERA_HOME: '', PATH: '' };
  const run = (...args: string[]) => spawnSync(process.execPath, [join(packageRoot(), 'dist', 'interface', 'cli.js'), 'benchmark', ...args], { env, encoding: 'utf8' });
  const one = run('--history', file, '--json');
  assert.equal(one.status, 0, one.stderr);
  const parsed = JSON.parse(one.stdout) as { cohorts: { stats: { tasks: number } }[] };
  assert.equal(parsed.cohorts[0].stats.tasks, 1);
  assert.equal(run('--history', file, '--json').stdout, one.stdout, 'two runs print identical output');
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), before);
  const out = join(home, 'synth.jsonl');
  assert.equal(run('synth', '--out', out, '--tasks', '4').status, 0);
  assert.equal(readFileSync(out, 'utf8').trim().split('\n').length, 10); // 4 tasks: 6 calls and 4 summaries
  assert.equal(run('compare', '--history', out, '--a', 'bogus').status, 2);
  writeFileSync(join(home, 'noop'), '');
});

test('cohortStats of no tasks is empty, not NaN', () => {
  const s = cohortStats([]);
  assert.equal(s.tasks, 0);
  assert.equal(s.costUsd.mean, null);
  assert.equal(s.costPerSuccessUsd, null);
});

test('records written by the real orchestrator (review, fallback, retry) are counted call for call', async () => {
  const scenarios: { name: string; setup: (c: ReturnType<typeof defaultConfig>) => void; codex: ConstructorParameters<typeof FakeAdapter>[1]; claude: ConstructorParameters<typeof FakeAdapter>[1] }[] = [
    { name: 'review', setup: (c) => (c.multiAi.mode = 'review'), codex: [{ status: 'success', output: 'a', costUsd: 0.1 }], claude: [{ status: 'success', output: 'VERDICT: OK', costUsd: 0.02 }] },
    { name: 'fallback', setup: (c) => (c.multiAi.mode = 'auto'), codex: [{ status: 'failed', stderr: 'boom: odd', costUsd: 0.03 }], claude: [{ status: 'success', output: 'ok', costUsd: 0.07 }] },
    { name: 'retry', setup: (c) => (c.multiAi.mode = 'manual'), codex: [{ status: 'failed', stderr: 'boom: transient', costUsd: 0.01 }, { status: 'success', output: 'ok', costUsd: 0.04 }], claude: [{ status: 'success', output: 'x', costUsd: 0 }] },
  ];
  for (const sc of scenarios) {
    const c = defaultConfig();
    c.workspaceRoot = isolatedHome();
    c.multiAi.enabled = true;
    c.agents.codex.enabled = true;
    c.agents.claude.enabled = true;
    c.agents.local.enabled = false;
    c.optimization.loopGuard = { enabled: true, maxRetries: 1, stopAfterSameErrors: 5 };
    sc.setup(c);
    const records: RunRecord[] = [];
    const adapters = new Map<string, AgentAdapter>([
      ['codex', new FakeAdapter('codex', sc.codex)],
      ['claude', new FakeAdapter('claude', sc.claude)],
    ]);
    await orchestrate(c, { groupId: gid(), prompt: 'do the thing', kind: null, cwd: process.cwd(), sandbox: 'read-only', timeoutMs: 5000, signal: new AbortController().signal, log: () => {} }, { adapters, records: () => records, record: (r) => records.push(r), retryDelayMs: 0 });
    const raw = records.filter((r) => CALL_ROLES.includes(r.role));
    assert.ok(raw.length >= 2, `${sc.name}: expected several calls, got ${raw.length}`);
    const built = buildRows(records);
    assert.equal(built.duplicateCallsSkipped, 0, sc.name);
    const stats = cohortStats(built.rows);
    assert.equal(stats.calls, raw.length, `${sc.name}: every paid call is counted`);
    close(stats.costUsd.sum, raw.reduce((s, r) => s + (r.result.costUsd ?? 0), 0));
    close(stats.costUsd.sum, summarizeCosts(records).reduce((s, a) => s + (a.reportedCostUsd ?? 0), 0));
  }
});
