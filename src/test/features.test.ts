import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfig, normalizeConfig, type ChimeraConfig } from '../core/config.js';
import { CodexAdapter } from '../agents/codex.js';
import { ClaudeAdapter } from '../agents/claude.js';
import { FakeAdapter, type ScriptedReply } from './fake-adapter.js';
import { orchestrate, type OrchestrateInput } from '../orchestrator/orchestrator.js';
import { summarizeCosts } from '../optimization/cost.js';
import { applyCandidate, DEFAULT_VARIANTS, listCandidates, loadCandidate, researchDir, runResearch, rejectCandidate } from '../improvement/research.js';
import { isolatedHome, fakeSpec } from './helpers.js';
import type { RunRecord } from '../core/history.js';
import type { RunContext, TaskRequest } from '../core/types.js';

function baseConfig(preset: ChimeraConfig['preset'] = 'lite'): ChimeraConfig {
  const c = defaultConfig();
  c.workspaceRoot = isolatedHome();
  c.preset = preset;
  c.agents.codex.enabled = true;
  c.agents.claude.enabled = true;
  c.agents.local.enabled = false;
  return c;
}

const ctx: RunContext = { signal: new AbortController().signal, log: () => {} };
const request: TaskRequest = { id: 't1', prompt: 'hi', cwd: process.cwd(), timeoutMs: 10_000, sandbox: 'read-only' };

function readArgs(file: string): string[] {
  return (JSON.parse(readFileSync(file, 'utf8')) as { args: string[] }).args;
}

test('subagents off: Claude denies its sub-agent tools', async () => {
  const home = isolatedHome();
  const file = join(home, 'a.json');
  await new ClaudeAdapter({ model: null, budgetUsd: null, tools: [], allowSubagents: false, spec: fakeSpec('claude', 'ok', file) }).run(request, ctx);
  const args = readArgs(file);
  const idx = args.indexOf('--disallowedTools');
  assert.ok(idx !== -1);
  assert.ok(args.slice(idx + 1).includes('Task') && args.slice(idx + 1).includes('Agent'));
});

test('subagents on: Claude does not deny sub-agent tools', async () => {
  const home = isolatedHome();
  const file = join(home, 'b.json');
  await new ClaudeAdapter({ model: null, budgetUsd: null, tools: [], allowSubagents: true, spec: fakeSpec('claude', 'ok', file) }).run(request, ctx);
  assert.equal(readArgs(file).indexOf('--disallowedTools'), -1);
});

test('subagents off: Codex disables its multi-agent features', async () => {
  const home = isolatedHome();
  const file = join(home, 'c.json');
  await new CodexAdapter({ model: null, allowSubagents: false, spec: fakeSpec('codex', 'ok', file) }).run(request, ctx);
  const args = readArgs(file);
  assert.ok(args.includes('multi_agent'));
  assert.equal(args[args.indexOf('multi_agent') - 1], '--disable');
});

test('subagents on: Codex keeps its defaults', async () => {
  const home = isolatedHome();
  const file = join(home, 'd.json');
  await new CodexAdapter({ model: null, allowSubagents: true, spec: fakeSpec('codex', 'ok', file) }).run(request, ctx);
  assert.ok(!readArgs(file).includes('multi_agent'));
});

test('claude: workspace-write maps to acceptEdits, never to a bypass mode', async () => {
  const home = isolatedHome();
  const file = join(home, 'e.json');
  await new ClaudeAdapter({ model: null, budgetUsd: null, tools: [], allowSubagents: false, spec: fakeSpec('claude', 'ok', file) }).run(
    { ...request, sandbox: 'workspace-write' },
    ctx,
  );
  const args = readArgs(file);
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.ok(!args.some((a) => /bypass|dangerously/i.test(a)));
});

test('allowSubagents defaults to off and is read from config', () => {
  assert.equal(defaultConfig().allowSubagents, false);
  assert.equal(normalizeConfig({ allowSubagents: 'yes' }).config.allowSubagents, false);
  assert.equal(normalizeConfig({ allowSubagents: true }).config.allowSubagents, true);
});

test('maxDepth 0: review is skipped and the reason is reported', async () => {
  const c = baseConfig();
  c.multiAi.enabled = true;
  c.multiAi.mode = 'review';
  c.multiAi.maxDepth = 0;
  const codex = new FakeAdapter('codex', [{ status: 'success', output: 'answer' }]);
  const claude = new FakeAdapter('claude', [{ status: 'success', output: 'VERDICT: OK' }]);
  const input: OrchestrateInput = { groupId: 'g', prompt: 'p', kind: null, cwd: process.cwd(), sandbox: 'read-only', timeoutMs: 5000, signal: new AbortController().signal, log: () => {} };
  const out = await orchestrate(c, input, { adapters: new Map([['codex', codex], ['claude', claude]]), records: () => [], record: () => {}, retryDelayMs: 0 });
  assert.equal(out.review, null);
  assert.equal(claude.calls.length, 0);
  assert.ok(out.notes.some((n) => n.includes('maxDepth is 0')));
});

test('per-agent promptPrefix is sent ahead of every task', async () => {
  const c = baseConfig();
  c.agents.codex.promptPrefix = 'PREFIX-TEXT';
  const codex = new FakeAdapter('codex', [{ status: 'success', output: 'ok' }]);
  const input: OrchestrateInput = { groupId: 'g', prompt: 'the task', kind: null, cwd: process.cwd(), sandbox: 'read-only', timeoutMs: 5000, signal: new AbortController().signal, log: () => {} };
  await orchestrate(c, input, { adapters: new Map([['codex', codex]]), records: () => [], record: () => {}, retryDelayMs: 0 });
  assert.ok(codex.calls[0].prompt.startsWith('PREFIX-TEXT'));
  assert.ok(codex.calls[0].prompt.endsWith('the task'));
});

test('summary records are shown in history but never counted as cost or calls', () => {
  const base = {
    recordedAt: new Date().toISOString(),
    groupId: 'g',
    mode: 'L0' as const,
    kind: null,
    prompt: 'p',
    result: {
      taskId: 't',
      agent: 'codex',
      status: 'success' as const,
      output: '',
      model: null,
      errorKind: null,
      errorMessage: null,
      errorSignature: null,
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0.5,
      startedAt: new Date().toISOString(),
      durationMs: 1,
    },
  };
  const records: RunRecord[] = [{ ...base, role: 'task' }, { ...base, role: 'summary', notes: ['x'] }];
  const rows = summarizeCosts(records);
  assert.equal(rows[0].runs, 1);
  assert.equal(rows[0].reportedCostUsd, 0.5);
});

// ----- Research (experimental) -----

const RESEARCH_TASK = 'What is 2 + 2? Reply with only the number.';

test('research: refuses to run outside the Research preset', async () => {
  const c = baseConfig('standard');
  await assert.rejects(
    runResearch({
      config: c,
      agent: 'codex',
      adapter: new FakeAdapter('codex', [{ status: 'success', output: '4' }]),
      task: RESEARCH_TASK,
      expect: '^4$',
      samples: 1,
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: new AbortController().signal,
      log: () => {},
      records: () => [],
      record: () => {},
    }),
    /Research preset/,
  );
});

function researchInput(c: ChimeraConfig, script: ScriptedReply[], samples = 1) {
  const adapter = new FakeAdapter('codex', script);
  return {
    adapter,
    input: {
      config: c,
      agent: 'codex' as const,
      adapter,
      task: RESEARCH_TASK,
      expect: '^4$',
      samples,
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: new AbortController().signal,
      log: () => {},
      records: () => [] as RunRecord[],
      record: () => {},
    },
  };
}

test('research: a variant that beats the baseline is saved as a pending candidate', async () => {
  const c = baseConfig('research');
  const { input, adapter } = researchInput(c, [
    { status: 'success', output: 'It is four.' },
    { status: 'success', output: '4' },
    { status: 'success', output: 'It is four.' },
  ]);
  const out = await runResearch(input);
  assert.equal(out.improved, true);
  assert.ok(out.candidate);
  assert.equal(out.candidate.status, 'pending');
  assert.equal(out.candidate.change.field, 'promptPrefix');
  assert.equal(out.candidate.change.value, DEFAULT_VARIANTS[1]);
  assert.equal(out.candidate.evidence, 'low', 'one sample per variant is marked as low evidence');
  assert.equal(adapter.calls.length, DEFAULT_VARIANTS.length);
  assert.equal(listCandidates().length, 1);
});

test('research: when nothing beats the baseline, nothing is saved', async () => {
  const c = baseConfig('research');
  const { input } = researchInput(c, [{ status: 'success', output: 'nope' }]);
  const out = await runResearch(input);
  assert.equal(out.improved, false);
  assert.equal(out.candidate, null);
  assert.equal(listCandidates().length, 0);
});

test('research: apply changes only promptPrefix and is recorded once', async () => {
  const home = isolatedHome();
  const c = baseConfig('research');
  const { input } = researchInput(c, [
    { status: 'success', output: 'x' },
    { status: 'success', output: '4' },
    { status: 'success', output: 'x' },
  ]);
  const out = await runResearch({ ...input, config: { ...c, workspaceRoot: home } });
  assert.ok(out.candidate);
  const id = out.candidate.id;
  const savePath = join(home, 'config.json');
  const next = applyCandidate(c, id, savePath);
  assert.equal(next.agents.codex.promptPrefix, DEFAULT_VARIANTS[1]);
  assert.equal(next.defaultSandbox, c.defaultSandbox, 'sandbox must not change');
  assert.equal(next.optimization.loopGuard.maxRetries, c.optimization.loopGuard.maxRetries, 'loop guard must not change');
  assert.equal(loadCandidate(id).status, 'applied');
  assert.throws(() => applyCandidate(c, id, savePath), /already applied/);
});

test('research: a tampered candidate that targets a non-whitelisted field is refused', async () => {
  const c = baseConfig('research');
  const { input } = researchInput(c, [
    { status: 'success', output: 'x' },
    { status: 'success', output: '4' },
    { status: 'success', output: 'x' },
  ]);
  const out = await runResearch(input);
  assert.ok(out.candidate);
  const file = join(researchDir(), `${out.candidate.id}.json`);
  const tampered = JSON.parse(readFileSync(file, 'utf8'));
  tampered.change.field = 'sandbox';
  writeFileSync(file, JSON.stringify(tampered));
  assert.throws(() => applyCandidate(c, out.candidate!.id), /not allowed/);
  assert.equal(loadCandidate(out.candidate.id).status, 'pending');
});

test('research: a candidate can be rejected, and then cannot be applied', async () => {
  const c = baseConfig('research');
  const { input } = researchInput(c, [
    { status: 'success', output: 'x' },
    { status: 'success', output: '4' },
    { status: 'success', output: 'x' },
  ]);
  const out = await runResearch(input);
  assert.ok(out.candidate);
  rejectCandidate(out.candidate.id);
  assert.equal(loadCandidate(out.candidate.id).status, 'rejected');
  assert.throws(() => applyCandidate(c, out.candidate!.id), /already rejected/);
});
