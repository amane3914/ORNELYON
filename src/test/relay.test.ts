import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, normalizeConfig, type ChimeraConfig } from '../core/config.js';
import { appendRecord, readRecords, type RunRecord } from '../core/history.js';
import { historyPath } from '../core/paths.js';
import { initialEvidence } from '../core/evidence.js';
import {
  handoffChain,
  handoffDepthOf,
  HANDOFF_TAG,
  loadPassport,
  passportPath,
  sealPassport,
  verifyPassport,
} from '../core/passport.js';
import { buildAdapters } from '../agents/registry.js';
import { ClaudeAdapter } from '../agents/claude.js';
import { CodexAdapter } from '../agents/codex.js';
import type { AgentAdapter, TaskResult } from '../core/types.js';
import { decideTask, handoffTask, savePassportFor, startTask } from '../interface/service.js';
import { fakeSpec } from './helpers.js';

/*
 * Relay tests. Agent A and Agent B are the real Codex and Claude adapters, running against
 * scripts/fake-agent.mjs through the adapter spec hook. No paid agent is called.
 * Refusal tests seed history directly, then check that no agent process was started.
 */

const ALL: Record<'codex' | 'claude' | 'local', boolean> = { codex: true, claude: true, local: false };

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface Setup {
  home: string;
  root: string;
  argsDir: string;
}

function setup(): Setup {
  const home = mkdtempSync(join(tmpdir(), 'ornelyon-relay-'));
  process.env.ORNELYON_HOME = home;
  delete process.env.CHIMERA_HOME;
  const root = join(home, 'workspace');
  const argsDir = join(home, 'args');
  mkdirSync(root, { recursive: true });
  mkdirSync(argsDir, { recursive: true });
  writeFileSync(join(root, 'app.txt'), 'hello world\n');
  return { home, root, argsDir };
}

function config(root: string, opts: { mode?: 'manual' | 'auto'; multi?: boolean; maxDepth?: number; maxHandoffs?: number } = {}): ChimeraConfig {
  const c = defaultConfig();
  c.setupCompleted = true;
  c.workspaceRoot = root;
  c.multiAi.enabled = opts.multi ?? true;
  c.multiAi.mode = opts.mode ?? 'manual';
  c.multiAi.mainAgent = 'codex';
  c.multiAi.maxDepth = opts.maxDepth ?? 1;
  c.multiAi.maxHandoffs = opts.maxHandoffs ?? 2;
  c.multiAi.maxCalls = 6;
  c.agents.codex.enabled = true;
  c.agents.codex.capabilities = ['code', 'text'];
  c.agents.claude.enabled = true;
  c.agents.claude.capabilities = ['code', 'text'];
  c.agents.local.enabled = false;
  return c;
}

/** Real adapters, pointed at the fake CLI. `mode` picks the fake's behaviour for each agent. */
function realAdapters(s: Setup, modes: { codex?: string; claude?: string } = {}): Map<string, AgentAdapter> {
  return new Map<string, AgentAdapter>([
    [
      'codex',
      new CodexAdapter({ model: null, allowSubagents: false, spec: fakeSpec('codex', modes.codex ?? 'ok', join(s.argsDir, 'codex.json')) }),
    ],
    [
      'claude',
      new ClaudeAdapter({
        model: null,
        budgetUsd: null,
        tools: [],
        allowSubagents: false,
        spec: fakeSpec('claude', modes.claude ?? 'ok', join(s.argsDir, 'claude.json')),
      } as ConstructorParameters<typeof ClaudeAdapter>[0]),
    ],
  ]);
}

/** Which fake agents were actually started (each one writes its args file when it runs). */
function started(s: Setup, agent: 'codex' | 'claude'): boolean {
  return existsSync(join(s.argsDir, `${agent}.json`));
}

function clearStarts(s: Setup): void {
  for (const a of ['codex', 'claude']) {
    rmSync(join(s.argsDir, `${a}.json`), { force: true });
  }
}

function seedTask(
  groupId: string,
  opts: { kind?: string | null; agent?: string; costUsd?: number | null; changedFiles?: { path: string; sha256: string | null }[]; handoffFrom?: string },
): void {
  const now = new Date().toISOString();
  const agent = opts.agent ?? 'codex';
  const result: TaskResult = {
    taskId: randomUUID(),
    agent,
    status: 'success',
    output: 'seeded answer',
    model: null,
    errorKind: null,
    errorMessage: null,
    errorSignature: null,
    usage: { inputTokens: null, outputTokens: null },
    costUsd: opts.costUsd ?? null,
    startedAt: now,
    durationMs: 1,
  };
  const prompt = 'Seeded objective line';
  const evidence = initialEvidence({
    status: 'success',
    sandbox: 'read-only',
    verificationRequired: false,
    checks: [],
    changedFiles: opts.changedFiles ?? [],
  });
  const base: RunRecord = { recordedAt: now, role: 'task', groupId, mode: 'L1', kind: opts.kind ?? null, prompt, result };
  appendRecord({ ...base, role: 'task' }, historyPath());
  appendRecord(
    {
      ...base,
      role: 'summary',
      evidence,
      notes: opts.handoffFrom ? [`${HANDOFF_TAG}${opts.handoffFrom}`] : [],
    },
    historyPath(),
  );
}

async function run(c: ChimeraConfig, adapters: Map<string, AgentAdapter>, prompt: string, agent: 'codex' | 'claude' | undefined, kind: string | null = null) {
  const groupId = randomUUID();
  const handle = startTask(
    c,
    { prompt, kind, cwd: undefined, agent, sandbox: 'read-only', timeoutSec: 30 },
    groupId,
    new AbortController().signal,
    () => {},
    ALL,
    adapters,
  );
  return handle.done;
}

function handoff(c: ChimeraConfig, adapters: Map<string, AgentAdapter>, from: string, to: 'codex' | 'claude', accept = false, available = ALL) {
  return handoffTask(
    c,
    { fromGroupId: from, to, acceptCurrentState: accept, timeoutSec: 30 },
    randomUUID(),
    new AbortController().signal,
    () => {},
    available,
    adapters,
  );
}

// ---------- success path ----------

test('relay E2E: Agent A runs, passport is saved, Agent B receives the handoff and runs, history agrees', async () => {
  const s = setup();
  const c = config(s.root);
  const adapters = realAdapters(s);

  const a = await run(c, adapters, 'Refactor the parser module', 'codex', 'code');
  assert.equal(a.final.status, 'success');
  assert.equal(a.final.agent, 'codex');
  assert.equal(a.evidence.execution, 'SUCCESS');
  assert.ok(started(s, 'codex'));

  const saved = await savePassportFor(c, a.groupId);
  assert.ok(saved.ok, 'passport saved for Agent A');
  const loaded = loadPassport(a.groupId);
  assert.ok(loaded.passport, 'passport passes the integrity check before handoff');
  assert.equal(loaded.passport.executingAgent, 'codex');
  assert.equal(loaded.passport.kind, 'code');

  clearStarts(s);
  const started1 = handoff(c, adapters, a.groupId, 'claude');
  assert.equal(started1.ok, true, started1.ok ? '' : started1.error);
  if (!started1.ok) {
    return;
  }
  const b = await started1.handle.done;
  assert.equal(b.final.agent, 'claude');
  assert.equal(b.final.status, 'success');
  assert.ok(!started(s, 'codex'), 'Agent A was not started again by the handoff');
  assert.ok(started(s, 'claude'), 'Agent B was started');

  // Agent B received the passport's objective, not the whole conversation.
  const claudeArgs = JSON.parse(readFileSync(join(s.argsDir, 'claude.json'), 'utf8')) as { stdin: string };
  assert.match(claudeArgs.stdin, /# Handoff Context/);
  assert.match(claudeArgs.stdin, /## 1\. Original Objective\nRefactor the parser module/);
  assert.match(claudeArgs.stdin, /hello from fake codex/);

  // History: Agent A's record, the summary with the handoff link, and Agent B's own record.
  const records = readRecords().records;
  const aRecords = records.filter((r) => r.groupId === a.groupId);
  assert.ok(aRecords.some((r) => r.role === 'summary' && r.result.agent === 'codex'));
  const bSummary = records.filter((r) => r.groupId === b.groupId && r.role === 'summary');
  assert.equal(bSummary.length, 1);
  assert.equal(bSummary[0].result.agent, 'claude');
  assert.deepEqual(bSummary[0].notes?.filter((n) => n.startsWith(HANDOFF_TAG)), [`${HANDOFF_TAG}${a.groupId}`]);
  assert.equal(handoffDepthOf(records, b.groupId), 1);

  // Passport and history agree: the handoff passport keeps decisions free of the internal link tag.
  await savePassportFor(c, b.groupId);
  const bLoaded = loadPassport(b.groupId);
  assert.ok(bLoaded.passport);
  assert.equal(bLoaded.passport.executingAgent, 'claude');
  assert.equal(bLoaded.passport.decisions.some((d) => d.startsWith(HANDOFF_TAG)), false);
  assert.equal(verifyPassport(JSON.parse(readFileSync(passportPath(a.groupId), 'utf8'))).ok, true, 'Agent A passport still verifies');
});

test('relay: in auto mode a handoff runs the named agent even when routing would pick another', async () => {
  const s = setup();
  const c = config(s.root, { mode: 'auto' });
  c.agents.codex.priority = 1;
  c.agents.claude.priority = 2;
  const adapters = realAdapters(s);

  const a = await run(c, adapters, 'Write the parser', undefined, 'code');
  assert.equal(a.final.agent, 'codex', 'routing picks the higher-priority agent for the original task');
  await savePassportFor(c, a.groupId);

  clearStarts(s);
  const h = handoff(c, adapters, a.groupId, 'claude');
  assert.equal(h.ok, true);
  if (!h.ok) {
    return;
  }
  const out = await h.handle.done;
  assert.equal(out.level, 'L1', 'a pinned handoff is never routed');
  assert.equal(out.final.agent, 'claude');
  assert.ok(started(s, 'claude'));
  assert.ok(!started(s, 'codex'));
});

test('explicit agent is honoured with multi-AI off, and only the requested agent is built', async () => {
  const s = setup();
  const c = config(s.root, { multi: false });
  const adapters = realAdapters(s);
  const out = await run(c, adapters, 'Summarise the README', 'claude');
  assert.equal(out.level, 'L0');
  assert.equal(out.final.agent, 'claude', 'the requested agent runs; it is not silently replaced by the main agent');
  assert.ok(started(s, 'claude'));
  assert.ok(!started(s, 'codex'));

  const built = buildAdapters(c, 'claude');
  assert.ok(built.has('claude'));
  assert.ok(built.has('codex'), 'the main agent is always built');
  assert.ok(!built.has('local'), 'unrequested integrations are not loaded');
  assert.equal(buildAdapters(c).has('claude'), false, 'without a request, multi-AI off builds only the main agent');
});

// ---------- refusals: no agent may start ----------

test('refusal: a file changed after the passport was saved blocks the handoff before Agent B starts', async () => {
  const s = setup();
  const c = config(s.root);
  const adapters = realAdapters(s);
  const g = randomUUID();
  seedTask(g, { kind: 'code', changedFiles: [{ path: 'app.txt', sha256: sha('hello world\n') }] });
  assert.ok((await savePassportFor(c, g)).ok);

  writeFileSync(join(s.root, 'app.txt'), 'someone else edited this\n');
  clearStarts(s);
  const h = handoff(c, adapters, g, 'claude');
  assert.equal(h.ok, false);
  if (h.ok) {
    return;
  }
  assert.match(h.error, /Workspace changed since the passport was saved: app.txt/);
  assert.ok(!started(s, 'claude'), 'no agent process was started');

  const accepted = handoff(c, adapters, g, 'claude', true);
  assert.equal(accepted.ok, true, 'accept-current-state lets the user continue on purpose');
  if (accepted.ok) {
    await accepted.handle.done;
  }
});

test('refusal: a corrupted passport is never used', async () => {
  const s = setup();
  const c = config(s.root);
  const adapters = realAdapters(s);
  const g = randomUUID();
  seedTask(g, { kind: 'code' });
  await savePassportFor(c, g);

  const file = passportPath(g);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  raw.objective = 'Rewritten by someone else';
  writeFileSync(file, JSON.stringify(raw, null, 2));

  clearStarts(s);
  const h = handoff(c, adapters, g, 'claude');
  assert.equal(h.ok, false);
  if (!h.ok) {
    assert.match(h.error, /Passport refused: .*integrity check failed/);
  }
  assert.ok(!started(s, 'claude'));
});

test('refusal: a passport with its open issues removed is refused, even when it is re-sealed', async () => {
  const s = setup();
  const c = config(s.root);
  const adapters = realAdapters(s);
  const g = randomUUID();
  seedTask(g, { kind: 'code' });
  await savePassportFor(c, g);

  const file = passportPath(g);
  const { integrity: _old, ...body } = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  delete body.openIssues;
  // A re-sealed copy has a valid integrity hash, so only the shape check can catch it.
  const resealed = sealPassport(body as Parameters<typeof sealPassport>[0]);
  writeFileSync(file, JSON.stringify(resealed, null, 2));

  const check = verifyPassport(JSON.parse(readFileSync(file, 'utf8')));
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => /openIssues/.test(e)), check.errors.join('; '));
  clearStarts(s);
  const h = handoff(c, adapters, g, 'claude');
  assert.equal(h.ok, false);
  assert.ok(!started(s, 'claude'));
});

test('refusal: an invalid task id never reaches the passport file system', () => {
  const s = setup();
  const c = config(s.root);
  const h = handoff(c, realAdapters(s), '../../etc/passwd', 'claude');
  assert.equal(h.ok, false);
  if (!h.ok) {
    assert.match(h.error, /invalid task id/);
  }
});

test('refusal: maxHandoffs 0 refuses every handoff before any agent starts', async () => {
  const s = setup();
  const adapters = realAdapters(s);
  const c0 = config(s.root, { maxHandoffs: 0 });
  const g0 = randomUUID();
  seedTask(g0, { kind: 'code' });
  await savePassportFor(c0, g0);
  clearStarts(s);
  const h0 = handoff(c0, adapters, g0, 'claude');
  assert.equal(h0.ok, false);
  if (!h0.ok) {
    assert.match(h0.error, /Handoff limit reached: this would be handoff 1 in the chain, and maxHandoffs=0/);
  }
  assert.ok(!started(s, 'claude'));
});

test('limits: maxDepth and maxHandoffs are independent', async () => {
  const s = setup();
  const adapters = realAdapters(s);
  // maxDepth 0 forbids nested agent calls. It no longer blocks a manual handoff, which is a new top-level run.
  const cDepth0 = config(s.root, { maxDepth: 0, maxHandoffs: 1 });
  const g = randomUUID();
  seedTask(g, { kind: 'code' });
  await savePassportFor(cDepth0, g);
  clearStarts(s);
  const ok = handoff(cDepth0, adapters, g, 'claude');
  assert.equal(ok.ok, true, ok.ok ? '' : ok.error);
  if (ok.ok) {
    const b = await ok.handle.done;
    assert.equal(b.final.status, 'success');
    assert.equal(b.final.agent, 'claude');
  }
  // A high maxDepth does not allow more handoffs than maxHandoffs.
  const cDepth3 = config(s.root, { maxDepth: 3, maxHandoffs: 0 });
  const g2 = randomUUID();
  seedTask(g2, { kind: 'code' });
  await savePassportFor(cDepth3, g2);
  const refused = handoff(cDepth3, adapters, g2, 'claude');
  assert.equal(refused.ok, false);
});

test('limits: nested calls are still bounded by maxDepth (review is skipped at maxDepth 0)', async () => {
  const s = setup();
  const c = config(s.root, { maxDepth: 0, mode: 'manual' });
  c.multiAi.smartDispatch = { enabled: true, criticalKinds: ['security'] };
  const out = await run(c, realAdapters(s), 'Audit the login code', 'codex', 'security');
  assert.equal(out.final.status, 'success');
  // The nested review is refused by the recursion limit before any process starts.
  assert.equal(out.review?.status, 'unavailable');
  assert.match(out.review?.errorMessage ?? '', /Nesting depth 1 exceeds maxDepth=0/);
  assert.ok(!started(s, 'claude'), 'no second agent was started');
});

test('limits: a chain is counted in history; the third handoff is refused when maxHandoffs is 2', async () => {
  const s = setup();
  const adapters = realAdapters(s);
  const c = config(s.root, { maxHandoffs: 2 });
  const g0 = randomUUID();
  const g1 = randomUUID();
  const g2 = randomUUID();
  seedTask(g0, { kind: 'code' });
  seedTask(g1, { kind: 'code', handoffFrom: g0 });
  seedTask(g2, { kind: 'code', handoffFrom: g1 });
  assert.deepEqual(
    [handoffChain(readRecords().records, g0).count, handoffChain(readRecords().records, g1).count, handoffChain(readRecords().records, g2).count],
    [0, 1, 2],
  );
  // g1 is handoff 1, so one more (handoff 2) is allowed.
  await savePassportFor(c, g1);
  clearStarts(s);
  const second = handoff(c, adapters, g1, 'claude');
  assert.equal(second.ok, true, second.ok ? '' : second.error);
  if (second.ok) {
    await second.handle.done;
  }
  // g2 is already handoff 2, so another would be handoff 3.
  await savePassportFor(c, g2);
  clearStarts(s);
  const third = handoff(c, adapters, g2, 'claude');
  assert.equal(third.ok, false);
  if (!third.ok) {
    assert.match(third.error, /handoff 3 in the chain, and maxHandoffs=2/);
  }
  assert.ok(!started(s, 'claude'));
});

test('limits: saving the passport again cannot reset the handoff count', async () => {
  const s = setup();
  const adapters = realAdapters(s);
  const c = config(s.root, { maxHandoffs: 1 });
  const g0 = randomUUID();
  const g1 = randomUUID();
  seedTask(g0, { kind: 'code' });
  seedTask(g1, { kind: 'code', handoffFrom: g0 });
  for (let i = 0; i < 3; i++) {
    rmSync(passportPath(g1), { force: true });
    await savePassportFor(c, g1);
    clearStarts(s);
    const h = handoff(c, adapters, g1, 'claude');
    assert.equal(h.ok, false, 'regenerated passport ' + i);
    if (!h.ok) {
      assert.match(h.error, /Handoff limit reached/);
    }
    assert.ok(!started(s, 'claude'));
  }
});

test('limits: a count that cannot be verified from history is refused, never taken as zero', async () => {
  const s = setup();
  const adapters = realAdapters(s);
  const c = config(s.root, { maxHandoffs: 5 });

  // The parent task is missing from history (for example history was trimmed).
  const orphan = randomUUID();
  seedTask(orphan, { kind: 'code', handoffFrom: randomUUID() });
  await savePassportFor(c, orphan);
  clearStarts(s);
  const h1 = handoff(c, adapters, orphan, 'claude');
  assert.equal(h1.ok, false);
  if (!h1.ok) {
    assert.match(h1.error, /cannot be verified/);
  }

  // A lineage that loops.
  const a = randomUUID();
  const b = randomUUID();
  seedTask(a, { kind: 'code', handoffFrom: b });
  seedTask(b, { kind: 'code', handoffFrom: a });
  await savePassportFor(c, a);
  const h2 = handoff(c, adapters, a, 'claude');
  assert.equal(h2.ok, false);
  if (!h2.ok) {
    assert.match(h2.error, /loops/);
  }

  // A valid passport file whose task is gone from history.
  const gone = randomUUID();
  seedTask(gone, { kind: 'code' });
  await savePassportFor(c, gone);
  rmSync(historyPath(), { force: true });
  const h3 = handoff(c, adapters, gone, 'claude');
  assert.equal(h3.ok, false);
  if (!h3.ok) {
    assert.match(h3.error, /not in the history/);
  }
  assert.ok(!started(s, 'claude'));
});

test('compatibility: a v0.2.1 config and a v0.2.1 passport keep working', async () => {
  // No maxHandoffs in the file: the old maxDepth value is the starting limit, never more permissive.
  assert.equal(normalizeConfig({ multiAi: { maxDepth: 0 } }).config.multiAi.maxHandoffs, 0);
  assert.equal(normalizeConfig({ multiAi: { maxDepth: 2 } }).config.multiAi.maxHandoffs, 2);
  assert.equal(normalizeConfig({ multiAi: { maxDepth: 1, maxHandoffs: 4 } }).config.multiAi.maxHandoffs, 4);
  assert.equal(normalizeConfig({}).config.multiAi.maxHandoffs, 2);
  assert.equal(normalizeConfig({ multiAi: { maxHandoffs: 99 } }).config.multiAi.maxHandoffs, 5);

  // A passport written by v0.2.1 has no kind and no handoff count. It still verifies and hands off.
  const s = setup();
  const c = config(s.root);
  const g = randomUUID();
  seedTask(g, { kind: null });
  await savePassportFor(c, g);
  const raw = JSON.parse(readFileSync(passportPath(g), 'utf8')) as Record<string, unknown>;
  delete raw.kind;
  delete raw.integrity;
  writeFileSync(passportPath(g), JSON.stringify(sealPassport(raw as never), null, 2));
  assert.ok(loadPassport(g).passport, 'old-format passport verifies');
  const h = handoff(c, realAdapters(s), g, 'claude');
  assert.equal(h.ok, true, h.ok ? '' : h.error);
  if (h.ok) {
    await h.handle.done;
  }
});

test('refusal: the target agent must declare the capability the task needs', async () => {
  const s = setup();
  const c = config(s.root);
  c.agents.claude.capabilities = ['text'];
  const g = randomUUID();
  seedTask(g, { kind: 'code' });
  await savePassportFor(c, g);
  clearStarts(s);
  const h = handoff(c, realAdapters(s), g, 'claude');
  assert.equal(h.ok, false);
  if (!h.ok) {
    assert.match(h.error, /does not declare the capability "code"/);
  }
  assert.ok(!started(s, 'claude'));
});

test('refusal: a daily budget already spent blocks the handoff, using history as it is now', async () => {
  const s = setup();
  const c = config(s.root);
  c.agents.claude.budgetUsd = 1;
  const g = randomUUID();
  seedTask(g, { kind: 'code' });
  await savePassportFor(c, g);
  // Claude has already reported $2 in the last 24 hours, so the budget is spent.
  seedTask(randomUUID(), { kind: 'code', agent: 'claude', costUsd: 2 });
  clearStarts(s);
  const h = handoff(c, realAdapters(s), g, 'claude');
  assert.equal(h.ok, false);
  if (!h.ok) {
    assert.match(h.error, /Daily budget reached for claude/);
  }
  assert.ok(!started(s, 'claude'));
});

test('refusal: an unavailable or disabled target agent is refused before anything starts', async () => {
  const s = setup();
  const c = config(s.root);
  const g = randomUUID();
  seedTask(g, { kind: 'code' });
  await savePassportFor(c, g);
  clearStarts(s);

  const unavailable = handoff(c, realAdapters(s), g, 'claude', false, { codex: true, claude: false, local: false });
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) {
    assert.match(unavailable.error, /Target agent claude is not available/);
  }

  c.agents.claude.enabled = false;
  const disabled = handoff(c, realAdapters(s), g, 'claude');
  assert.equal(disabled.ok, false);
  if (!disabled.ok) {
    assert.match(disabled.error, /Target agent claude is disabled/);
  }
  assert.ok(!started(s, 'claude'));
});

test('failure: Agent B that cannot run is not a success, and that cannot be accepted', async () => {
  const s = setup();
  const c = config(s.root);
  const g = randomUUID();
  seedTask(g, { kind: 'code' });
  await savePassportFor(c, g);

  // The fake Claude CLI reports that it is not signed in. The handoff starts, then cannot run.
  const h = handoff(c, realAdapters(s, { claude: 'auth' }), g, 'claude');
  assert.equal(h.ok, true);
  if (!h.ok) {
    return;
  }
  const out = await h.handle.done;
  assert.notEqual(out.final.status, 'success');
  // A sign-in problem is "unavailable", which the evidence model reports as BLOCKED, not FAILED.
  assert.equal(out.evidence.execution, 'BLOCKED');
  const decision = decideTask(out.groupId, 'accept', 'trying to accept a failed handoff', true);
  assert.equal(decision.ok, false, 'a failed handoff cannot be accepted, even with override');
});
