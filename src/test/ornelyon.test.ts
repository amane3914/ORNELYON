import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig, normalizeConfig } from '../core/config.js';
import { CALL_ROLES, readRecords, type RunRecord } from '../core/history.js';
import { decideAcceptance, describeAcceptance, executionFor, initialEvidence, latestEvidence, verificationFrom, type Evidence } from '../core/evidence.js';
import { buildContract, validateContract } from '../core/contract.js';
import { runVerification, safeRelativePath, type VerificationSpec } from '../core/verify.js';
import { diffSnapshots, outOfScope, snapshotWorkspace } from '../core/workspace.js';
import { buildPassport, handoffInstruction, loadPassport, passportDrift, passportPath, savePassport, sealPassport, verifyPassport, type TaskPassport } from '../core/passport.js';
import { decideDispatch, reviewKey } from '../orchestrator/dispatch.js';
import { orchestrate, parseVerdict, planDispatch } from '../orchestrator/orchestrator.js';
import { activeTools } from '../optimization/dormancy.js';
import { summarizeCosts } from '../optimization/cost.js';
import { FakeAdapter, type ScriptedReply } from './fake-adapter.js';
import { isolatedHome } from './helpers.js';
import type { TaskResult } from '../core/types.js';
import { hashWorkspaceFile } from '../core/workspace.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ornelyon-'));
}

const GROUP = '11111111-2222-4333-8444-555555555555';

function result(status: TaskResult['status'], agent = 'codex'): TaskResult {
  return {
    taskId: 't1',
    agent,
    status,
    output: 'answer',
    model: null,
    errorKind: status === 'success' ? null : 'agent_failed',
    errorMessage: status === 'success' ? null : 'boom',
    errorSignature: status === 'success' ? null : 'sig',
    usage: { inputTokens: null, outputTokens: null },
    costUsd: null,
    startedAt: new Date(0).toISOString(),
    durationMs: 1,
  };
}

// ---------- Phase A: Evidence Gate Lite ----------

test('evidence: execution is derived from the run status, never from a verdict', () => {
  assert.equal(executionFor('success'), 'SUCCESS');
  assert.equal(executionFor('failed'), 'FAILED');
  assert.equal(executionFor('unavailable'), 'BLOCKED');
  assert.equal(executionFor('cancelled'), 'CANCELLED');
});

test('evidence: SUCCESS execution can coexist with a FAIL verification', () => {
  const ev = initialEvidence({
    status: 'success',
    sandbox: 'workspace-write',
    verificationRequired: true,
    checks: [{ name: 'a.txt', kind: 'file', result: 'FAIL', detail: 'missing' }],
    changedFiles: [],
  });
  assert.equal(ev.execution, 'SUCCESS');
  assert.equal(ev.verification, 'FAIL');
});

test('evidence: a required verification with no checks is UNVERIFIED, not PASS', () => {
  assert.equal(verificationFrom([], true), 'UNVERIFIED');
  assert.equal(verificationFrom([], false), 'NOT_RUN');
  assert.equal(verificationFrom([{ name: 'x', kind: 'file', result: 'PASS', detail: '' }], true), 'PASS');
});

test('evidence: acceptance starts PENDING, or NOT_REQUIRED for a read-only task with no checks', () => {
  assert.equal(initialEvidence({ status: 'success', sandbox: 'workspace-write', verificationRequired: false, checks: [], changedFiles: [] }).acceptance, 'PENDING');
  assert.equal(initialEvidence({ status: 'success', sandbox: 'read-only', verificationRequired: false, checks: [], changedFiles: [] }).acceptance, 'NOT_REQUIRED');
});

function ev(partial: Partial<Evidence>): Evidence {
  return {
    version: 1,
    execution: 'SUCCESS',
    verification: 'PASS',
    verificationRequired: true,
    checks: [],
    acceptance: 'PENDING',
    acceptanceReason: null,
    acceptedAt: null,
    overrideUsed: false,
    changedFiles: [],
    ...partial,
  };
}

test('acceptance: accept is refused when verification failed, even if execution succeeded', () => {
  const r = decideAcceptance(ev({ verification: 'FAIL' }), 'accept', { reason: 'looks fine' });
  assert.equal(r.ok, false);
});

test('acceptance: accept is refused when required verification is missing', () => {
  const r = decideAcceptance(ev({ verification: 'UNVERIFIED', verificationRequired: true }), 'accept', { reason: 'ok' });
  assert.equal(r.ok, false);
});

test('acceptance: accept is refused when execution did not succeed', () => {
  const r = decideAcceptance(ev({ execution: 'FAILED', verification: 'NOT_RUN', verificationRequired: false }), 'accept', { reason: 'ok' });
  assert.equal(r.ok, false);
});

test('acceptance: an override is needed, is accepted only with a reason, and is recorded', () => {
  const blocked = decideAcceptance(ev({ verification: 'FAIL' }), 'accept', { reason: 'ok', override: false });
  assert.equal(blocked.ok, false);
  const noReason = decideAcceptance(ev({ verification: 'FAIL' }), 'accept', { reason: '  ', override: true });
  assert.equal(noReason.ok, false);
  const forced = decideAcceptance(ev({ verification: 'FAIL' }), 'accept', { reason: 'known flaky check', override: true });
  assert.equal(forced.ok, true);
  if (forced.ok) {
    assert.equal(forced.evidence.acceptance, 'ACCEPTED');
    assert.equal(forced.evidence.overrideUsed, true);
  }
});

test('acceptance: a clean accept is not marked as an override', () => {
  const r = decideAcceptance(ev({ verification: 'PASS' }), 'accept', { reason: 'reviewed the diff' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.evidence.overrideUsed, false);
  }
});

test('acceptance: reject always works with a reason', () => {
  const r = decideAcceptance(ev({ execution: 'FAILED' }), 'reject', { reason: 'not useful' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.evidence.acceptance, 'REJECTED');
  }
});

test('acceptance: describes that an accepted change is not applied or approved by acceptance', () => {
  const text = describeAcceptance(ev({ acceptance: 'ACCEPTED', changedFiles: [{ path: 'a.txt', sha256: 'x' }] }));
  assert.match(text, /does not apply or approve/);
});

test('history: the newest evidence for a group wins; v0.1 records without evidence give null', () => {
  const rec = (role: RunRecord['role'], e?: Evidence): RunRecord => ({
    recordedAt: 'x',
    role,
    groupId: 'g',
    mode: 'L0',
    kind: null,
    prompt: 'p',
    result: result('success'),
    evidence: e,
  });
  assert.equal(latestEvidence([rec('summary')], 'g'), null);
  const first = ev({ acceptance: 'PENDING' });
  const later = ev({ acceptance: 'ACCEPTED' });
  assert.equal(latestEvidence([rec('summary', first), rec('decision', later)], 'g')?.acceptance, 'ACCEPTED');
});

// ---------- Verification and workspace ----------

test('verify: path traversal and absolute paths are refused before any file is read', () => {
  assert.equal(safeRelativePath('../secret'), null);
  assert.equal(safeRelativePath('/etc/passwd'), null);
  assert.equal(safeRelativePath('a/../../b'), null);
  assert.equal(safeRelativePath('src/a.ts'), 'src/a.ts');
});

test('verify: file existence and sha256 are checked against the workspace', async () => {
  const root = tmp();
  writeFileSync(join(root, 'a.txt'), 'hello');
  const good = hashWorkspaceFile(root, 'a.txt');
  const spec: VerificationSpec = {
    files: [
      { path: 'a.txt', sha256: good },
      { path: 'missing.txt', sha256: null },
      { path: 'a.txt', sha256: 'f'.repeat(64) },
    ],
    jsonFiles: [],
    commands: [],
    allowedFiles: null,
  };
  const checks = await runVerification(spec, { root, sandbox: 'read-only', changed: [], snapshotGaps: [], commandsEnabled: false, trusted: {} });
  assert.deepEqual(checks.map((c) => c.result), ['PASS', 'FAIL', 'FAIL']);
  rmSync(root, { recursive: true, force: true });
});

test('verify: JSON files must parse', async () => {
  const root = tmp();
  writeFileSync(join(root, 'ok.json'), '{"a":1}');
  writeFileSync(join(root, 'bad.json'), '{nope');
  const checks = await runVerification(
    { files: [], jsonFiles: ['ok.json', 'bad.json'], commands: [], allowedFiles: null },
    { root, sandbox: 'read-only', changed: [], snapshotGaps: [], commandsEnabled: false, trusted: {} },
  );
  assert.deepEqual(checks.map((c) => c.result), ['PASS', 'FAIL']);
  rmSync(root, { recursive: true, force: true });
});

test('verify: commands are UNVERIFIED while disabled, and unregistered names never run', async () => {
  const root = tmp();
  const disabled = await runVerification(
    { files: [], jsonFiles: [], commands: ['test'], allowedFiles: null },
    { root, sandbox: 'read-only', changed: [], snapshotGaps: [], commandsEnabled: false, trusted: { test: { command: process.execPath, args: ['-e', ''], timeoutSec: 10 } } },
  );
  assert.equal(disabled[0].result, 'UNVERIFIED');
  const unregistered = await runVerification(
    { files: [], jsonFiles: [], commands: ['rogue'], allowedFiles: null },
    { root, sandbox: 'read-only', changed: [], snapshotGaps: [], commandsEnabled: true, trusted: {} },
  );
  assert.equal(unregistered[0].result, 'UNVERIFIED');
  rmSync(root, { recursive: true, force: true });
});

test('verify: a registered command runs without a shell and maps exit status to PASS or FAIL', async () => {
  const root = tmp();
  const trusted = {
    ok: { command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutSec: 30 },
    bad: { command: process.execPath, args: ['-e', 'process.exit(3)'], timeoutSec: 30 },
  };
  const checks = await runVerification(
    { files: [], jsonFiles: [], commands: ['ok', 'bad'], allowedFiles: null },
    { root, sandbox: 'read-only', changed: [], snapshotGaps: [], commandsEnabled: true, trusted },
  );
  assert.deepEqual(checks.map((c) => c.result), ['PASS', 'FAIL']);
  assert.match(checks[1].detail, /exit code 3/);
  rmSync(root, { recursive: true, force: true });
});

test('scope: changes outside the allowed files fail the scope check; inside them pass', async () => {
  const root = tmp();
  const changed = [
    { path: 'src/a.ts', sha256: 'x' },
    { path: 'secrets/key.txt', sha256: 'y' },
  ];
  const bad = await runVerification(
    { files: [], jsonFiles: [], commands: [], allowedFiles: ['src'] },
    { root, sandbox: 'workspace-write', changed, snapshotGaps: [], commandsEnabled: false, trusted: {} },
  );
  assert.equal(bad[0].result, 'FAIL');
  assert.match(bad[0].detail, /secrets\/key\.txt/);
  const good = await runVerification(
    { files: [], jsonFiles: [], commands: [], allowedFiles: ['src', 'secrets/key.txt'] },
    { root, sandbox: 'workspace-write', changed, snapshotGaps: [], commandsEnabled: false, trusted: {} },
  );
  assert.equal(good[0].result, 'PASS');
  assert.deepEqual(outOfScope(changed, ['src/']), ['secrets/key.txt']);
  rmSync(root, { recursive: true, force: true });
});

test('workspace: snapshots detect added, changed and removed files and skip generated folders', () => {
  const root = tmp();
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'skip.js'), 'x');
  writeFileSync(join(root, 'keep.txt'), 'one');
  writeFileSync(join(root, 'gone.txt'), 'two');
  const before = snapshotWorkspace(root);
  assert.equal(before.files.has('node_modules/skip.js'), false);
  writeFileSync(join(root, 'keep.txt'), 'changed');
  rmSync(join(root, 'gone.txt'));
  writeFileSync(join(root, 'new.txt'), 'three');
  const diff = diffSnapshots(before, snapshotWorkspace(root));
  assert.deepEqual(diff.map((d) => [d.path, d.sha256 === null ? 'removed' : 'present']), [
    ['gone.txt', 'removed'],
    ['keep.txt', 'present'],
    ['new.txt', 'present'],
  ]);
  rmSync(root, { recursive: true, force: true });
});

// ---------- Phase C: Delegation Contract ----------

function goodContract() {
  return buildContract({
    invocationId: 'inv-1',
    parentInvocationId: null,
    taskId: 'inv-1',
    groupId: 'grp-1',
    agent: 'codex',
    model: null,
    role: 'task',
    objective: 'Summarise the file.',
    allowedFiles: ['src'],
    permissions: { sandbox: 'read-only' },
    timeoutSec: 60,
    budgetUsd: null,
    invocationDepth: 0,
    maxDepth: 1,
    expectedOutput: 'A short summary.',
    verificationRequirements: [],
  });
}

test('contract: a well-formed contract is accepted', () => {
  assert.deepEqual(validateContract(goodContract()), []);
});

test('contract: invalid agent, recursion beyond maxDepth, unsafe paths and bad sandbox are refused', () => {
  const cases: [string, unknown][] = [
    ['unknown agent', { ...goodContract(), agent: 'rogue' }],
    ['depth over max', { ...goodContract(), invocationDepth: 2, maxDepth: 1 }],
    ['absolute allowed path', { ...goodContract(), allowedFiles: ['/etc'] }],
    ['parent traversal', { ...goodContract(), allowedFiles: ['../x'] }],
    ['unknown sandbox', { ...goodContract(), permissions: { sandbox: 'danger-full-access' } }],
    ['zero timeout', { ...goodContract(), timeoutSec: 0 }],
    ['not an object', 'contract'],
  ];
  for (const [name, value] of cases) {
    assert.ok(validateContract(value).length > 0, `${name} must be refused`);
  }
});

// ---------- Phase B: Smart Dispatch ----------

test('dispatch: disabled, or no review needed, stays NO_CALL', () => {
  const base = { enabled: true, kind: 'text', reviewRequested: false, criticalKinds: ['security'], executionSucceeded: true, repeatedFailure: false, reviewer: 'claude', reusablePass: false, budgetAllowsCall: true };
  assert.equal(decideDispatch({ ...base, enabled: false }).action, 'NO_CALL');
  assert.equal(decideDispatch(base).action, 'NO_CALL');
});

test('dispatch: a critical kind or requested review requires an independent reviewer', () => {
  const base = { enabled: true, kind: 'security', reviewRequested: false, criticalKinds: ['security'], executionSucceeded: true, repeatedFailure: false, reviewer: 'claude', reusablePass: false, budgetAllowsCall: true };
  const d = decideDispatch(base);
  assert.equal(d.action, 'REQUIRE_INDEPENDENT_REVIEW');
  assert.equal(d.reviewer, 'claude');
});

test('dispatch: a missing reviewer is reported, not silently skipped', () => {
  const d = decideDispatch({ enabled: true, kind: null, reviewRequested: true, criticalKinds: [], executionSucceeded: true, repeatedFailure: false, reviewer: null, reusablePass: false, budgetAllowsCall: true });
  assert.equal(d.action, 'NO_CALL');
  assert.match(d.reasons.join(' '), /UNVERIFIED/);
});

test('dispatch: a repeated failure escalates instead of calling again', () => {
  const d = decideDispatch({ enabled: true, kind: null, reviewRequested: true, criticalKinds: [], executionSucceeded: false, repeatedFailure: true, reviewer: 'claude', reusablePass: false, budgetAllowsCall: true });
  assert.equal(d.action, 'ESCALATE');
});

test('dispatch: a reusable identical PASS prevents a second review', () => {
  const d = decideDispatch({ enabled: true, kind: 'security', reviewRequested: false, criticalKinds: ['security'], executionSucceeded: true, repeatedFailure: false, reviewer: 'claude', reusablePass: true, budgetAllowsCall: true });
  assert.equal(d.action, 'NO_CALL');
});

test('dispatch: changing the answer, the reviewer or the file fingerprint changes the review key', () => {
  const base = { answer: 'a', reviewer: 'claude', kind: 'security', constraints: '{}', fileFingerprint: 'f1' };
  const k = reviewKey(base);
  assert.notEqual(k, reviewKey({ ...base, answer: 'b' }));
  assert.notEqual(k, reviewKey({ ...base, reviewer: 'codex' }));
  assert.notEqual(k, reviewKey({ ...base, fileFingerprint: 'f2' }));
  assert.equal(k, reviewKey({ ...base }));
});

test('dispatch: planDispatch is a dry run with no adapters and honours an explicit review request', () => {
  const config = defaultConfig();
  config.multiAi.enabled = true;
  config.agents.claude.enabled = true;
  const plan = planDispatch(config, { kind: null, reviewRequested: true, available: new Map(), main: 'codex' });
  assert.equal(plan.action, 'REQUIRE_INDEPENDENT_REVIEW');
  assert.equal(plan.reviewer, 'claude');
  const off = planDispatch(defaultConfig(), { kind: null, reviewRequested: false, available: new Map(), main: 'codex' });
  assert.equal(off.action, 'NO_CALL');
});

test('verdict: only an explicit VERDICT line counts', () => {
  assert.equal(parseVerdict('VERDICT: OK\nlooks good'), 'OK');
  assert.equal(parseVerdict('verdict: issues'), 'ISSUES');
  assert.equal(parseVerdict('The tests passed. Great.'), null);
});

// ---------- Orchestrator end to end (fake agents, offline) ----------

function harness(scripts: { codex: ScriptedReply[]; claude: ScriptedReply[] }) {
  const config = defaultConfig();
  config.multiAi.enabled = true;
  config.multiAi.mode = 'manual';
  config.multiAi.smartDispatch = { enabled: true, criticalKinds: ['security'] };
  config.agents.claude.enabled = true;
  const codex = new FakeAdapter('codex', scripts.codex);
  const claude = new FakeAdapter('claude', scripts.claude);
  const records: RunRecord[] = [];
  let n = 0;
  const deps = {
    adapters: new Map<string, FakeAdapter>([['codex', codex], ['claude', claude]]),
    records: () => records,
    record: (r: RunRecord) => records.push(r),
    retryDelayMs: 0,
    newId: () => `id-${++n}`,
  };
  return { config, codex, claude, records, deps };
}

function input(kind: string | null, reviewRequested = false) {
  return {
    groupId: GROUP,
    prompt: 'Check the login code',
    kind,
    cwd: process.cwd(),
    sandbox: 'read-only' as const,
    timeoutMs: 5000,
    signal: new AbortController().signal,
    log: () => {},
    reviewRequested,
  };
}

test('dispatch e2e: a critical kind triggers exactly one independent review, recorded with a key', async () => {
  const h = harness({ codex: [{ status: 'success', output: 'answer' }], claude: [{ status: 'success', output: 'VERDICT: OK' }] });
  const out = await orchestrate(h.config, input('security'), h.deps);
  assert.equal(out.review?.agent, 'claude');
  assert.equal(h.claude.calls.length, 1);
  assert.equal(out.dispatch[0].action, 'REQUIRE_INDEPENDENT_REVIEW');
  const reviewRecord = h.records.find((r) => r.role === 'review');
  assert.ok(reviewRecord?.notes?.some((n) => n.startsWith('review-key:')));
});

test('dispatch e2e: an identical review is reused, so the reviewer is not called again', async () => {
  const first = harness({ codex: [{ status: 'success', output: 'answer' }], claude: [{ status: 'success', output: 'VERDICT: OK' }] });
  await orchestrate(first.config, input('security'), first.deps);
  const second = harness({ codex: [{ status: 'success', output: 'answer' }], claude: [] });
  // Same history as the first run: the reviewed answer and reviewer are identical.
  const deps = { ...second.deps, records: () => first.records, record: (r: RunRecord) => first.records.push(r) };
  const out = await orchestrate(second.config, input('security'), deps);
  assert.equal(second.claude.calls.length, 0);
  assert.equal(out.dispatch[0].action, 'NO_CALL');
  assert.match(out.dispatch[0].reasons.join(' '), /reused/);
});

test('dispatch e2e: ordinary tasks make no extra call (NO_CALL)', async () => {
  const h = harness({ codex: [{ status: 'success', output: 'answer' }], claude: [] });
  const out = await orchestrate(h.config, input('text'), h.deps);
  assert.equal(out.review, null);
  assert.equal(h.claude.calls.length, 0);
});

test('dispatch e2e: a repeated failure stops with ESCALATE and no further call', async () => {
  const h = harness({
    codex: [{ status: 'failed', output: '' }, { status: 'failed', output: '' }, { status: 'failed', output: '' }, { status: 'failed', output: '' }],
    claude: [{ status: 'success', output: 'VERDICT: OK' }],
  });
  h.config.optimization.loopGuard.stopAfterSameErrors = 2;
  const out = await orchestrate(h.config, input('security', true), h.deps);
  assert.equal(out.final.status, 'failed');
  assert.equal(h.claude.calls.length, 0, 'a failed answer must not be reviewed as if it were a result');
  assert.ok(h.codex.calls.length <= 4, 'the loop guard caps the attempts');
});

test('calls: the call cap still applies to dispatch reviews', async () => {
  const h = harness({ codex: [{ status: 'success', output: 'answer' }], claude: [{ status: 'success', output: 'VERDICT: OK' }] });
  h.config.multiAi.maxCalls = 1;
  const out = await orchestrate(h.config, input('security'), h.deps);
  assert.equal(out.review?.status, 'unavailable');
  assert.equal(h.claude.calls.length, 0);
});

// ---------- Phase D: Task Passport ----------

function passportRecords(): RunRecord[] {
  const contract = goodContract();
  const task: RunRecord = {
    recordedAt: 'x',
    role: 'task',
    groupId: GROUP,
    mode: 'L1',
    kind: 'text',
    prompt: 'First line of the request\nsecret second line',
    result: result('success'),
    contract,
  };
  const summary: RunRecord = {
    recordedAt: 'y',
    role: 'summary',
    groupId: GROUP,
    mode: 'L1',
    kind: 'text',
    prompt: 'First line of the request\nsecret second line',
    result: result('success'),
    notes: ['[codex] a note'],
    evidence: ev({ verification: 'UNVERIFIED', acceptance: 'PENDING', checks: [] }),
  };
  return [task, summary];
}

test('passport: built from history, sealed, and verified', () => {
  const p = buildPassport(GROUP, passportRecords(), null, '2026-01-01T00:00:00.000Z');
  assert.ok(p);
  assert.equal(verifyPassport(p).ok, true);
  assert.equal(p.objective, 'First line of the request');
  assert.ok(!JSON.stringify(p).includes('secret second line'), 'the raw second line of the prompt must not be stored');
  assert.ok(p.openIssues.some((i) => i.includes('awaiting')));
});

test('passport: tampering or truncation is refused', () => {
  const p = buildPassport(GROUP, passportRecords(), null) as TaskPassport;
  assert.equal(verifyPassport({ ...p, objective: 'changed' }).ok, false);
  const { integrity: _i, ...withoutIntegrity } = p;
  assert.equal(verifyPassport(withoutIntegrity).ok, false);
  assert.equal(verifyPassport(null).ok, false);
});

test('passport: unknown groups give null, invalid ids are rejected for file paths', () => {
  assert.equal(buildPassport('22222222-2222-4222-8222-222222222222', passportRecords(), null), null);
  assert.throws(() => passportPath('../../etc/passwd'), /Invalid task id/);
});

test('passport: save and load round-trip under an isolated data folder; corrupt files are refused', () => {
  isolatedHome();
  const p = buildPassport(GROUP, passportRecords(), null) as TaskPassport;
  const file = savePassport(p);
  assert.ok(existsSync(file));
  const loaded = loadPassport(GROUP);
  assert.equal(loaded.check.ok, true);
  writeFileSync(file, readFileSync(file, 'utf8').replace('First line', 'Tampered'), 'utf8');
  assert.equal(loadPassport(GROUP).check.ok, false);
});

test('passport: workspace drift is reported when a recorded file has changed', () => {
  const root = tmp();
  writeFileSync(join(root, 'a.txt'), 'before');
  const sha = hashWorkspaceFile(root, 'a.txt');
  const p = sealPassport({
    version: 1,
    groupId: GROUP,
    createdAt: 'x',
    objective: 'o',
    status: { execution: 'SUCCESS', verification: 'NOT_RUN', acceptance: 'PENDING' },
    executingAgent: 'codex',
    decisions: [],
    changedFiles: [{ path: 'a.txt', sha256: sha }],
    verifications: [],
    openIssues: [],
    nextStep: 'None.',
    constraints: [],
    gitCommit: null,
  });
  assert.equal(passportDrift(p, root).length, 0);
  writeFileSync(join(root, 'a.txt'), 'after');
  assert.equal(passportDrift(p, root)[0].path, 'a.txt');
  rmSync(root, { recursive: true, force: true });
});

test('handoff: the instruction carries the objective and decisions, never the raw prompt', () => {
  const p = buildPassport(GROUP, passportRecords(), null) as TaskPassport;
  const text = handoffInstruction(p, 'claude');
  assert.match(text, /Objective: First line of the request/);
  assert.match(text, /a note/);
  assert.ok(!text.includes('secret second line'));
});

// ---------- Compatibility ----------

test('compat: a v0.1 config loads and gets v0.2 defaults that keep everything off', () => {
  const { config } = normalizeConfig({ preset: 'standard', multiAi: { enabled: true, mainAgent: 'codex' } });
  assert.equal(config.multiAi.smartDispatch.enabled, false);
  assert.equal(config.verification.allowCommands, false);
  assert.deepEqual(config.verification.commands, {});
});

test('compat: trusted commands must use absolute paths and safe names', () => {
  const { config } = normalizeConfig({
    verification: {
      allowCommands: true,
      commands: {
        ok: { command: process.execPath, args: ['--version'], timeoutSec: 30 },
        relative: { command: 'node', args: [] },
        'Bad Name': { command: process.execPath, args: [] },
      },
    },
  });
  assert.deepEqual(Object.keys(config.verification.commands), ['ok']);
  assert.equal(config.verification.allowCommands, true);
});

test('compat: a v0.1 history line without evidence still reads, and decisions are never costed', () => {
  const home = isolatedHome();
  const file = join(home, 'history.jsonl');
  const v01 = { recordedAt: '2026-01-01T00:00:00.000Z', role: 'task', groupId: 'g', mode: 'L0', kind: null, prompt: 'p', result: result('success') };
  const decision = { ...v01, role: 'decision', evidence: ev({}) };
  writeFileSync(file, `${JSON.stringify(v01)}\n${JSON.stringify(decision)}\n`, 'utf8');
  const read = readRecords(file);
  assert.equal(read.records.length, 2);
  assert.equal(read.records[0].evidence, undefined);
  assert.equal(CALL_ROLES.includes('decision'), false);
  const summary = summarizeCosts(read.records);
  assert.equal(summary[0].runs, 1, 'the decision record must not count as a second call');
});

test('compat: the tool dormancy rules from v0.1 still apply', () => {
  assert.equal(activeTools([{ name: 'x', description: '', state: 'ACTIVE' }]).length, 1);
});

test('compat: the decideAcceptance path never sets ACCEPTED for an agent-only success', () => {
  const pending = initialEvidence({ status: 'success', sandbox: 'workspace-write', verificationRequired: false, checks: [], changedFiles: [] });
  assert.equal(pending.acceptance, 'PENDING');
  assert.notEqual(pending.acceptance, 'ACCEPTED');
});
