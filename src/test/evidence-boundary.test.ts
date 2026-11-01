import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendRecord, type RunRecord } from '../core/history.js';
import { packageRoot } from '../core/paths.js';
import {
  decideAcceptance,
  describeAcceptance,
  executionFor,
  initialEvidence,
  verificationFrom,
  type Evidence,
  type VerificationCheck,
} from '../core/evidence.js';
import type { RunStatus } from '../core/types.js';

/*
 * Evidence Gate boundary tests. Three judgements are kept apart: Execution, Verification and Acceptance.
 * Only an explicit user decision sets ACCEPTED or REJECTED, and override never changes a check result.
 */

const RUN_STATUSES: RunStatus[] = ['success', 'failed', 'timeout', 'cancelled', 'unavailable'];

function ev(over: Partial<Evidence>): Evidence {
  return {
    version: 1,
    execution: 'SUCCESS',
    verification: 'NOT_RUN',
    verificationRequired: false,
    checks: [],
    acceptance: 'PENDING',
    acceptanceReason: null,
    acceptedAt: null,
    overrideUsed: false,
    changedFiles: [],
    ...over,
  };
}

const FAIL_CHECK: VerificationCheck = { name: 'json package.json', kind: 'json', result: 'FAIL', detail: 'does not parse' };
const UNVERIFIED_CHECK: VerificationCheck = { name: 'unit tests', kind: 'command', result: 'UNVERIFIED', detail: 'not run' };

// ---------- execution is not verification ----------

test('a successful run alone never becomes a verification PASS', () => {
  assert.equal(executionFor('success'), 'SUCCESS');
  assert.equal(verificationFrom([], false), 'NOT_RUN', 'no checks and none required: NOT_RUN');
  assert.equal(verificationFrom([], true), 'UNVERIFIED', 'required but missing: UNVERIFIED, not PASS');
  const e = initialEvidence({ status: 'success', sandbox: 'workspace-write', verificationRequired: true, checks: [], changedFiles: [] });
  assert.equal(e.verification, 'UNVERIFIED');
  assert.notEqual(e.verification, 'PASS');
});

test('a PASS needs every check to pass; one UNVERIFIED keeps the whole result UNVERIFIED', () => {
  const pass: VerificationCheck = { name: 'file a', kind: 'file', result: 'PASS', detail: 'ok' };
  assert.equal(verificationFrom([pass], true), 'PASS');
  assert.equal(verificationFrom([pass, UNVERIFIED_CHECK], true), 'UNVERIFIED');
  assert.equal(verificationFrom([pass, FAIL_CHECK, UNVERIFIED_CHECK], true), 'FAIL', 'a FAIL outranks UNVERIFIED');
});

test('an agent cannot set Acceptance: every run status starts PENDING or NOT_REQUIRED, never ACCEPTED or REJECTED', () => {
  for (const status of RUN_STATUSES) {
    for (const sandbox of ['read-only', 'workspace-write'] as const) {
      const e = initialEvidence({ status, sandbox, verificationRequired: false, checks: [], changedFiles: [] });
      assert.ok(e.acceptance === 'PENDING' || e.acceptance === 'NOT_REQUIRED', `${status}/${sandbox} gave ${e.acceptance}`);
    }
  }
});

// ---------- normal accept ----------

test('normal accept is refused when execution did not succeed, whatever the verification', () => {
  for (const execution of ['FAILED', 'BLOCKED', 'CANCELLED', 'UNKNOWN'] as const) {
    const r = decideAcceptance(ev({ execution }), 'accept', { reason: 'looks fine' });
    assert.equal(r.ok, false, execution);
  }
});

test('normal accept is refused on a FAIL check and on a missing required check', () => {
  const failed = decideAcceptance(ev({ verification: 'FAIL', verificationRequired: true, checks: [FAIL_CHECK] }), 'accept', { reason: 'x' });
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.match(failed.error, /verification failed/);
  }
  const missing = decideAcceptance(ev({ verification: 'UNVERIFIED', verificationRequired: true }), 'accept', { reason: 'x' });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.match(missing.error, /required verification was not completed/);
  }
});

test('normal accept works when nothing required is missing, and records no override', () => {
  const r = decideAcceptance(ev({ verification: 'NOT_RUN', verificationRequired: false }), 'accept', { reason: 'reviewed', now: '2026-01-01T00:00:00.000Z' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.evidence.acceptance, 'ACCEPTED');
    assert.equal(r.evidence.overrideUsed, false);
    assert.equal(r.evidence.acceptanceReason, 'reviewed');
  }
});

test('a decision needs a non-empty reason', () => {
  const r = decideAcceptance(ev({}), 'accept', { reason: '   ' });
  assert.equal(r.ok, false);
  const reject = decideAcceptance(ev({}), 'reject', { reason: '' });
  assert.equal(reject.ok, false);
});

// ---------- override ----------

test('override accepts a FAIL check, but the FAIL stays FAIL and the override is recorded', () => {
  const r = decideAcceptance(ev({ verification: 'FAIL', verificationRequired: true, checks: [FAIL_CHECK] }), 'accept', {
    reason: 'known issue, shipping the rest',
    override: true,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.evidence.acceptance, 'ACCEPTED');
    assert.equal(r.evidence.verification, 'FAIL', 'override never turns a FAIL into PASS');
    assert.equal(r.evidence.overrideUsed, true);
    assert.deepEqual(r.evidence.checks, [FAIL_CHECK], 'the checks themselves are untouched');
  }
});

test('override accepts a missing required check, and the check stays UNVERIFIED', () => {
  const r = decideAcceptance(ev({ verification: 'UNVERIFIED', verificationRequired: true, checks: [UNVERIFIED_CHECK] }), 'accept', {
    reason: 'checked by hand',
    override: true,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.evidence.verification, 'UNVERIFIED');
    assert.equal(r.evidence.overrideUsed, true);
  }
});

test('override never accepts a run that did not execute successfully', () => {
  for (const execution of ['FAILED', 'BLOCKED', 'CANCELLED', 'UNKNOWN'] as const) {
    const r = decideAcceptance(ev({ execution, verification: 'UNVERIFIED', verificationRequired: true }), 'accept', { reason: 'x', override: true });
    assert.equal(r.ok, false, `override must not accept an ${execution} run`);
  }
});

test('override is recorded only when it was actually needed', () => {
  const r = decideAcceptance(ev({ verification: 'NOT_RUN', verificationRequired: false }), 'accept', { reason: 'fine', override: true });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.evidence.overrideUsed, false, 'no blocker, so no override is claimed');
  }
});

test('reject records the decision and never changes the three judgements', () => {
  const base = ev({ verification: 'FAIL', verificationRequired: true, checks: [FAIL_CHECK] });
  const r = decideAcceptance(base, 'reject', { reason: 'wrong approach' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.evidence.acceptance, 'REJECTED');
    assert.equal(r.evidence.execution, base.execution);
    assert.equal(r.evidence.verification, base.verification);
  }
});

// ---------- wording: acceptance is not approval of files ----------

test('accepting a task with changed files says it does not apply or approve those changes', () => {
  const text = describeAcceptance(
    ev({ acceptance: 'ACCEPTED', changedFiles: [{ path: 'src/a.ts', sha256: 'abc' }] }),
  );
  assert.match(text, /already on disk/);
  assert.match(text, /does not apply or approve/);
  const plain = describeAcceptance(ev({ acceptance: 'ACCEPTED', changedFiles: [] }));
  assert.equal(plain, 'Accepted by the user.');
});

// ---------- structure: no agent path can reach the decision functions ----------

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...sourceFiles(p));
    } else if (p.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

test('structure: agent, orchestrator, optimization and improvement code cannot call the decision functions', () => {
  const forbidden = /decideTask|decideAcceptance|\/api\/tasks\/decision|handleApi/;
  for (const area of ['agents', 'orchestrator', 'optimization', 'improvement']) {
    for (const file of sourceFiles(join(packageRoot(), 'src', area))) {
      const text = readFileSync(file, 'utf8');
      assert.doesNotMatch(text, forbidden, `${file} must not reach the user decision path`);
    }
  }
});

// ---------- CLI gives the same answer as the core rule ----------

test('CLI: accept without override is refused, and override is recorded, through the real command', () => {
  const home = mkdtempSync(join(tmpdir(), 'ornelyon-evidence-'));
  mkdirSync(join(home, 'work'), { recursive: true });
  const groupId = randomUUID();
  const now = new Date().toISOString();
  const result = {
    taskId: randomUUID(),
    agent: 'codex',
    status: 'success',
    output: 'done',
    model: null,
    errorKind: null,
    errorMessage: null,
    errorSignature: null,
    usage: { inputTokens: null, outputTokens: null },
    costUsd: null,
    startedAt: now,
    durationMs: 1,
  } as RunRecord['result'];
  const evidence = initialEvidence({
    status: 'success',
    sandbox: 'read-only',
    verificationRequired: true,
    checks: [UNVERIFIED_CHECK],
    changedFiles: [],
  });
  appendRecord({ recordedAt: now, role: 'task', groupId, mode: 'L0', kind: null, prompt: 'x', result }, join(home, 'history.jsonl'));
  appendRecord({ recordedAt: now, role: 'summary', groupId, mode: 'L0', kind: null, prompt: 'x', result, evidence, notes: [] }, join(home, 'history.jsonl'));

  const cli = join(packageRoot(), 'dist', 'interface', 'cli.js');
  const env: NodeJS.ProcessEnv = { ...process.env, ORNELYON_HOME: home };
  delete env.CHIMERA_HOME;

  const refused = spawnSync(process.execPath, [cli, 'accept', groupId, '--reason', 'looks fine'], { env, encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /required verification was not completed/);

  const forced = spawnSync(process.execPath, [cli, 'accept', groupId, '--reason', 'checked by hand', '--override'], { env, encoding: 'utf8' });
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /Accepted by the user/);

  const verdict = spawnSync(process.execPath, [cli, 'verdict', groupId], { env, encoding: 'utf8' });
  assert.equal(verdict.status, 0);
  assert.match(verdict.stdout, /Verification: UNVERIFIED\s+Acceptance: ACCEPTED/, 'override left the verification as UNVERIFIED');
});
