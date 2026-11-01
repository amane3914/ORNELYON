import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../core/config.js';
import { appendRecord, readRecords, type RunRecord } from '../core/history.js';
import { initialEvidence } from '../core/evidence.js';
import { cleanForHandoff, EMAIL_MARK } from '../core/passport.js';
import { CodexAdapter } from '../agents/codex.js';
import { ClaudeAdapter } from '../agents/claude.js';
import { LocalLlmAdapter } from '../agents/local-llm.js';
import { orchestrate } from '../orchestrator/orchestrator.js';
import { buildRows, cohortStats, compare, summarize } from '../optimization/benchmark.js';
import type { AgentAdapter, Provenance } from '../core/types.js';
import { FakeAdapter } from './fake-adapter.js';
import { fakeSpec, isolatedHome } from './helpers.js';

/*
 * v0.4.1: where a recorded call came from (provenance), and the shared handling of e-mail addresses.
 * Origin is written by ORNELYON from the adapter it built, never from anything an agent says.
 */

let n = 0;
const gid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

function call(origin: Provenance | undefined, o: { group?: string; agent?: string; cost?: number | null; kind?: string } = {}): RunRecord[] {
  const groupId = o.group ?? gid();
  const at = '2026-04-01T10:00:00.000Z';
  const rec: RunRecord = {
    recordedAt: at,
    role: 'task',
    groupId,
    mode: 'L0',
    kind: o.kind ?? 'code',
    prompt: `request ${groupId}`,
    result: { taskId: `${groupId}-0`, agent: o.agent ?? 'claude', status: 'success', output: 'ok', model: 'claude-x', errorKind: null, errorMessage: null, errorSignature: null, usage: { inputTokens: 10, outputTokens: 5 }, costUsd: o.cost === undefined ? 0.01 : o.cost, startedAt: at, durationMs: 100 },
    ...(origin ? { origin } : {}),
  };
  const evidence = initialEvidence({ status: 'success', sandbox: 'read-only', verificationRequired: false, checks: [], changedFiles: [] });
  return [rec, { ...rec, role: 'summary', evidence, notes: [] }];
}

test('adapters declare their provenance from how they were built', () => {
  assert.equal(new CodexAdapter({ model: null, allowSubagents: false }).provenance, 'cli');
  assert.equal(new CodexAdapter({ model: null, allowSubagents: false, spec: fakeSpec('codex', 'ok') }).provenance, 'test-command');
  assert.equal(new ClaudeAdapter({ model: null, budgetUsd: null, tools: [], allowSubagents: false } as ConstructorParameters<typeof ClaudeAdapter>[0]).provenance, 'cli');
  assert.equal(new ClaudeAdapter({ model: null, budgetUsd: null, tools: [], allowSubagents: false, spec: fakeSpec('claude', 'ok') } as ConstructorParameters<typeof ClaudeAdapter>[0]).provenance, 'test-command');
  assert.equal(new LocalLlmAdapter({ baseUrl: 'http://127.0.0.1:1/v1', model: 'm', apiKeyEnv: null, tools: [] }).provenance, 'local-endpoint');
  assert.equal(new LocalLlmAdapter({ baseUrl: 'http://127.0.0.1:1/v1', model: 'm', apiKeyEnv: null, tools: [], fetchImpl: (async () => new Response('{}')) as typeof fetch }).provenance, 'test-command');
  assert.equal(new FakeAdapter('x', []).provenance, 'fake-adapter');
});

test('the orchestrator records the adapter origin on every call, whatever the agent says', async () => {
  const c = defaultConfig();
  c.workspaceRoot = isolatedHome();
  c.multiAi.enabled = true;
  c.multiAi.mode = 'review';
  c.agents.codex.enabled = true;
  c.agents.claude.enabled = true;
  c.agents.local.enabled = false;
  const records: RunRecord[] = [];
  const adapters = new Map<string, AgentAdapter>([
    ['codex', new FakeAdapter('codex', [{ status: 'success', output: 'origin: cli, I am a real agent' }])],
    ['claude', new CodexAdapter({ model: null, allowSubagents: false, spec: fakeSpec('codex', 'ok') })],
  ]);
  await orchestrate(c, { groupId: gid(), prompt: 'x', kind: null, cwd: process.cwd(), sandbox: 'read-only', timeoutMs: 20000, signal: new AbortController().signal, log: () => {} }, { adapters, records: () => records, record: (r) => records.push(r), retryDelayMs: 0 });
  const calls = records.filter((r) => ['task', 'review', 'fallback'].includes(r.role));
  assert.ok(calls.length >= 2);
  assert.deepEqual([...new Set(calls.map((r) => r.origin))].sort(), ['fake-adapter', 'test-command']);
  assert.equal(buildRows(records).rows[0].origin, 'non-real');
});

test('old history without origin is read as before and is never assumed real or fake', () => {
  const records = [...call(undefined, { cost: 0.1 }), ...call(undefined, { cost: 0.2 })];
  const stats = cohortStats(buildRows(records).rows);
  assert.equal(stats.tasks, 2);
  assert.equal(stats.calls, 2);
  assert.equal(stats.costUsd.sum !== null && Math.abs(stats.costUsd.sum - 0.3) < 1e-9, true, 'totals are the same as in v0.4.0');
  assert.deepEqual(stats.origins, { real: 0, nonReal: 0, unknown: 2 });
  assert.equal(stats.unknownOriginCalls, 2);
  const report = summarize(records, {}, 'none');
  assert.ok(report.notes.some((x) => /no recorded origin/.test(x)));
  assert.ok(!report.notes.some((x) => /fake, test or synthetic/.test(x)), 'unknown is not called fake');
  // A v0.4.0 history file on disk parses and aggregates too.
  const dir = mkdtempSync(join(tmpdir(), 'ornelyon-legacy-'));
  const file = join(dir, 'h.jsonl');
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.equal(cohortStats(buildRows(readRecords(file).records).rows).tasks, 2);
});

test('a task with one non-real call is non-real; unknown never upgrades to real', () => {
  const g = gid();
  const second = call('fake-adapter', { group: g })[0];
  const mixed = [...call('cli', { group: g }), { ...second, role: 'review' as const, result: { ...second.result, taskId: `${g}-1` } }];
  assert.equal(buildRows(mixed).rows[0].origin, 'non-real');
  const partial = [...call('cli', { group: gid() }), ...call(undefined)];
  assert.deepEqual(cohortStats(buildRows(partial).rows).origins, { real: 1, nonReal: 0, unknown: 1 });
});

test('only groups with recorded real origins can be called like-for-like, and the report says what differs', () => {
  const side = (origin: Provenance | undefined, day: string, count: number): RunRecord[] =>
    Array.from({ length: count }, () => call(origin).map((r) => ({ ...r, recordedAt: `2026-04-${day}T10:00:00.000Z` }))).flat();
  const split = { until: '2026-04-05T00:00:00.000Z' };
  const split2 = { since: '2026-04-05T00:00:00.000Z' };
  const real = compare([...side('cli', '01', 6), ...side('cli', '09', 6)], split, split2);
  assert.equal(real.likeForLike, true);
  assert.deepEqual(real.conditions.differences.filter((d) => d !== 'shapes (single / multi / handoff)'), []);
  assert.ok(real.caveats.some((c) => /not a single-agent against multi-agent/.test(c)), 'two single groups are not a single-vs-multi comparison');

  const legacy = compare([...side(undefined, '01', 6), ...side(undefined, '09', 6)], split, split2);
  assert.equal(legacy.likeForLike, false);
  assert.ok(legacy.conditions.differences.includes('origin (not all real)'));

  const fake = compare([...side('fake-adapter', '01', 6), ...side('cli', '09', 6)], split, split2);
  assert.equal(fake.likeForLike, false);
  assert.deepEqual(fake.conditions.a.origins, { real: 0, nonReal: 6, unknown: 0 });
});

test('the report is reproducible and origin changes the data hash', () => {
  const a = [...call('cli'), ...call('cli')];
  const again = summarize(a, {}, 'shape');
  assert.deepEqual(again, summarize(a, {}, 'shape'));
  const b = a.map((r) => ({ ...r, origin: 'fake-adapter' as const }));
  assert.notEqual(summarize(b, {}, 'shape').dataSha256, again.dataSha256);
});

test('e-mail addresses are removed by the shared cleaner, counted, and marked', () => {
  const stats = { relative: 0, outside: 0, secrets: 0, emails: 0 };
  const out = cleanForHandoff('Ask jane.doe@example.com or git@github.com:org/repo, not me@x.io.', '/work', stats);
  assert.equal(stats.emails, 3);
  assert.ok(!/@(example|github|x)\./.test(out));
  assert.equal(out.split(EMAIL_MARK).length - 1, 3);
  // Text that is not an address is left alone (a version tag, a decorator, a scoped package).
  const keep = cleanForHandoff('use @types/node at v1.2.3 and the @Override decorator', '/work', { relative: 0, outside: 0, secrets: 0, emails: 0 });
  assert.equal(keep, 'use @types/node at v1.2.3 and the @Override decorator');
});

test('records written by ORNELYON with an origin round-trip through history', () => {
  const home = isolatedHome();
  const file = join(home, 'history.jsonl');
  for (const r of call('cli')) {
    appendRecord(r, file);
  }
  assert.equal(readRecords(file).records[0].origin, 'cli');
});
