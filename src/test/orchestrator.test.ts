import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, type ChimeraConfig } from '../core/config.js';
import { FakeAdapter, type ScriptedReply } from './fake-adapter.js';
import { orchestrate, type OrchestrateInput, type OrchestrateDeps } from '../orchestrator/orchestrator.js';
import { isolatedHome } from './helpers.js';
import type { RunRecord } from '../core/history.js';
import type { AgentAdapter } from '../core/types.js';

const OK: ScriptedReply = { status: 'success', output: 'answer' };
const FAIL: ScriptedReply = { status: 'failed', stderr: 'boom: something odd' };

function config(overrides: (c: ChimeraConfig) => void = () => {}): ChimeraConfig {
  const c = defaultConfig();
  c.workspaceRoot = isolatedHome();
  c.agents.codex.enabled = true;
  c.agents.claude.enabled = true;
  c.agents.local.enabled = false;
  c.optimization.loopGuard = { enabled: true, maxRetries: 1, stopAfterSameErrors: 5 };
  overrides(c);
  return c;
}

function input(overrides: Partial<OrchestrateInput> = {}): OrchestrateInput {
  return {
    groupId: 'g1',
    prompt: 'do the thing',
    kind: null,
    cwd: process.cwd(),
    sandbox: 'read-only',
    timeoutMs: 5000,
    signal: new AbortController().signal,
    log: () => {},
    ...overrides,
  };
}

function deps(adapters: AgentAdapter[], extra: Partial<OrchestrateDeps> = {}): { deps: OrchestrateDeps; records: RunRecord[] } {
  const records: RunRecord[] = [];
  return {
    records,
    deps: {
      adapters: new Map(adapters.map((a) => [a.id, a])),
      records: () => records,
      record: (r) => records.push(r),
      retryDelayMs: 0,
      ...extra,
    },
  };
}

test('L0: multi-AI off runs only the main agent and loads no other adapter', async () => {
  const codex = new FakeAdapter('codex', [OK]);
  const claude = new FakeAdapter('claude', [OK]);
  const c = config((x) => (x.multiAi.enabled = false));
  const { deps: d } = deps([codex, claude]);
  const out = await orchestrate(c, input(), d);
  assert.equal(out.level, 'L0');
  assert.equal(out.final.status, 'success');
  assert.equal(claude.calls.length, 0);
});

test('L1: manual mode never switches agents after a failure', async () => {
  const codex = new FakeAdapter('codex', [FAIL]);
  const claude = new FakeAdapter('claude', [OK]);
  const c = config((x) => {
    x.multiAi.enabled = true;
    x.multiAi.mode = 'manual';
    x.optimization.loopGuard.maxRetries = 0;
  });
  const { deps: d } = deps([codex, claude]);
  const out = await orchestrate(c, input(), d);
  assert.equal(out.level, 'L1');
  assert.equal(out.final.status, 'failed');
  assert.equal(claude.calls.length, 0);
  assert.ok(out.notes.some((n) => n.includes('does not switch')));
});

test('L1: the user-chosen agent is the one that runs', async () => {
  const codex = new FakeAdapter('codex', [OK]);
  const claude = new FakeAdapter('claude', [OK]);
  const c = config((x) => (x.multiAi.enabled = true));
  const { deps: d } = deps([codex, claude]);
  const out = await orchestrate(c, input({ agent: 'claude' }), d);
  assert.equal(out.final.agent, 'claude');
  assert.equal(codex.calls.length, 0);
});

test('L2: a different agent reviews the main answer', async () => {
  const codex = new FakeAdapter('codex', [OK]);
  const claude = new FakeAdapter('claude', [{ status: 'success', output: 'VERDICT: OK' }]);
  const c = config((x) => {
    x.multiAi.enabled = true;
    x.multiAi.mode = 'review';
  });
  const { deps: d } = deps([codex, claude]);
  const out = await orchestrate(c, input(), d);
  assert.equal(out.level, 'L2');
  assert.equal(out.review?.agent, 'claude');
  assert.match(claude.calls[0].prompt, /Answer to review/);
  assert.equal(out.steps.length, 2);
});

test('L2: a single enabled agent is reported, not silently reviewed by itself', async () => {
  const codex = new FakeAdapter('codex', [OK]);
  const c = config((x) => {
    x.multiAi.enabled = true;
    x.multiAi.mode = 'review';
    x.agents.claude.enabled = false;
  });
  const { deps: d } = deps([codex]);
  const out = await orchestrate(c, input(), d);
  assert.equal(out.review, null);
  assert.ok(out.notes.some((n) => n.includes('No other enabled agent')));
});

test('L3: routing uses declared capabilities and priority, then falls back on failure', async () => {
  const codex = new FakeAdapter('codex', [FAIL]);
  const claude = new FakeAdapter('claude', [OK]);
  const c = config((x) => {
    x.multiAi.enabled = true;
    x.multiAi.mode = 'auto';
    x.optimization.loopGuard.maxRetries = 0;
    x.agents.codex.capabilities = ['code'];
    x.agents.claude.capabilities = ['code', 'text'];
    x.agents.claude.priority = 2;
    x.agents.codex.priority = 1;
  });
  const { deps: d } = deps([codex, claude]);
  const out = await orchestrate(c, input({ kind: 'code' }), d);
  assert.equal(out.level, 'L3');
  assert.equal(out.final.agent, 'claude');
  assert.equal(codex.calls.length, 1);
  assert.ok(out.notes.some((n) => n.includes('Falling back from codex to claude')));
});

test('L3: an agent without the requested capability is never chosen', async () => {
  const codex = new FakeAdapter('codex', [OK]);
  const claude = new FakeAdapter('claude', [OK]);
  const c = config((x) => {
    x.multiAi.enabled = true;
    x.multiAi.mode = 'auto';
    x.agents.codex.capabilities = ['text'];
    x.agents.claude.capabilities = ['code'];
  });
  const { deps: d } = deps([codex, claude]);
  const out = await orchestrate(c, input({ kind: 'code' }), d);
  assert.equal(out.final.agent, 'claude');
  assert.equal(codex.calls.length, 0);
});

test('L3: an unavailable agent (not installed or not signed in) is skipped with a reason', async () => {
  const codex = new FakeAdapter('codex', [OK]);
  const claude = new FakeAdapter('claude', [OK]);
  const c = config((x) => {
    x.multiAi.enabled = true;
    x.multiAi.mode = 'auto';
  });
  const { deps: d } = deps([codex, claude], { available: new Map([['codex', false], ['claude', true]]) });
  const out = await orchestrate(c, input(), d);
  assert.equal(out.final.agent, 'claude');
  assert.ok(out.notes.some((n) => n.includes('codex was skipped')));
});

test('L3: no matching agent gives an explicit unavailable result', async () => {
  const codex = new FakeAdapter('codex', [OK]);
  const c = config((x) => {
    x.multiAi.enabled = true;
    x.multiAi.mode = 'auto';
    x.agents.codex.capabilities = ['text'];
  });
  const { deps: d } = deps([codex]);
  const out = await orchestrate(c, input({ kind: 'image' }), d);
  assert.equal(out.final.status, 'unavailable');
  assert.equal(codex.calls.length, 0);
});

test('call cap: no more agent invocations than maxCalls, including retries', async () => {
  const codex = new FakeAdapter('codex', [FAIL]);
  const claude = new FakeAdapter('claude', [FAIL]);
  const c = config((x) => {
    x.multiAi.enabled = true;
    x.multiAi.mode = 'auto';
    x.multiAi.maxCalls = 2;
    x.optimization.loopGuard = { enabled: true, maxRetries: 5, stopAfterSameErrors: 9 };
  });
  const { deps: d } = deps([codex, claude]);
  const out = await orchestrate(c, input(), d);
  assert.equal(codex.calls.length + claude.calls.length, 2);
  assert.ok(out.steps.some((s) => s.status === 'unavailable' && s.errorMessage?.includes('Call limit')));
});

test('loop guard: a retry happens for a transient failure and the record is written each time', async () => {
  const codex = new FakeAdapter('codex', [{ status: 'failed', stderr: 'boom 1' }, OK]);
  const c = config((x) => {
    x.multiAi.enabled = false;
    x.optimization.loopGuard = { enabled: true, maxRetries: 2, stopAfterSameErrors: 5 };
  });
  const { deps: d, records } = deps([codex]);
  const out = await orchestrate(c, input(), d);
  assert.equal(out.final.status, 'success');
  assert.equal(codex.calls.length, 2);
  assert.equal(records.length, 2);
});

test('budget: an agent whose reported spend reached its daily limit is not called', async () => {
  const codex = new FakeAdapter('codex', [OK]);
  const c = config((x) => {
    x.multiAi.enabled = false;
    x.agents.codex.budgetUsd = 1;
  });
  const { deps: d, records } = deps([codex]);
  records.push({
    recordedAt: new Date().toISOString(),
    role: 'task',
    groupId: 'old',
    mode: 'L0',
    kind: null,
    prompt: 'p',
    result: {
      taskId: 't',
      agent: 'codex',
      status: 'success',
      output: '',
      model: null,
      errorKind: null,
      errorMessage: null,
      errorSignature: null,
      usage: { inputTokens: null, outputTokens: null },
      costUsd: 1.5,
      startedAt: new Date().toISOString(),
      durationMs: 1,
    },
  });
  const out = await orchestrate(c, input(), d);
  assert.equal(out.final.status, 'unavailable');
  assert.equal(codex.calls.length, 0);
});
