import type { RunStatus, SandboxMode } from './types.js';

/**
 * Evidence Gate Lite. Three independent judgements per task:
 *   Execution    did the agent process finish with a usable result (never a verdict on correctness)
 *   Verification what checkable evidence says (files, JSON, trusted commands, scope, review)
 *   Acceptance   what a user decided. Only an explicit user action sets ACCEPTED or REJECTED.
 */
export type Execution = 'SUCCESS' | 'FAILED' | 'BLOCKED' | 'CANCELLED' | 'UNKNOWN';
export type Verification = 'PASS' | 'FAIL' | 'UNVERIFIED' | 'NOT_RUN';
export type Acceptance = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'NOT_REQUIRED';

export type CheckResult = 'PASS' | 'FAIL' | 'UNVERIFIED';

export interface VerificationCheck {
  name: string;
  kind: 'file' | 'json' | 'command' | 'scope' | 'review';
  result: CheckResult;
  detail: string;
}

/** A workspace file that changed during a run. `sha256` is null when the file no longer exists. */
export interface ChangedFile {
  path: string;
  sha256: string | null;
}

export interface Evidence {
  version: 1;
  execution: Execution;
  verification: Verification;
  /** True when the user asked for verification or independent review. A missing check then means UNVERIFIED. */
  verificationRequired: boolean;
  checks: VerificationCheck[];
  acceptance: Acceptance;
  acceptanceReason: string | null;
  acceptedAt: string | null;
  /** True when the user accepted despite a failed or missing required check. Always recorded. */
  overrideUsed: boolean;
  changedFiles: ChangedFile[];
}

/** Map a run status to Execution. A finished process with an empty answer is FAILED, not SUCCESS. */
export function executionFor(status: RunStatus): Execution {
  switch (status) {
    case 'success':
      return 'SUCCESS';
    case 'failed':
    case 'timeout':
      return 'FAILED';
    case 'unavailable':
      return 'BLOCKED';
    case 'cancelled':
      return 'CANCELLED';
    default:
      return 'UNKNOWN';
  }
}

export function verificationFrom(checks: VerificationCheck[], required: boolean): Verification {
  if (checks.length === 0) {
    return required ? 'UNVERIFIED' : 'NOT_RUN';
  }
  if (checks.some((c) => c.result === 'FAIL')) {
    return 'FAIL';
  }
  if (checks.some((c) => c.result === 'UNVERIFIED')) {
    return 'UNVERIFIED';
  }
  return 'PASS';
}

export function initialEvidence(input: {
  status: RunStatus;
  sandbox: SandboxMode;
  verificationRequired: boolean;
  checks: VerificationCheck[];
  changedFiles: ChangedFile[];
}): Evidence {
  const readOnlyWithoutChecks = input.sandbox === 'read-only' && !input.verificationRequired && input.checks.length === 0;
  return {
    version: 1,
    execution: executionFor(input.status),
    verification: verificationFrom(input.checks, input.verificationRequired),
    verificationRequired: input.verificationRequired,
    checks: input.checks,
    acceptance: readOnlyWithoutChecks ? 'NOT_REQUIRED' : 'PENDING',
    acceptanceReason: null,
    acceptedAt: null,
    overrideUsed: false,
    changedFiles: input.changedFiles,
  };
}

export type AcceptAction = 'accept' | 'reject';

export type AcceptOutcome = { ok: true; evidence: Evidence } | { ok: false; error: string };

/**
 * Apply a user decision. Accepting requires a successful execution and no failed or missing
 * required verification, unless the user sets `override` and gives a reason. Overrides are recorded.
 * This function is the only place that sets ACCEPTED.
 */
export function decideAcceptance(
  evidence: Evidence,
  action: AcceptAction,
  opts: { reason: string; override?: boolean; now?: string },
): AcceptOutcome {
  const reason = opts.reason.trim();
  if (reason === '') {
    return { ok: false, error: 'A reason is required to accept or reject a task.' };
  }
  const now = opts.now ?? new Date().toISOString();
  if (action === 'reject') {
    return { ok: true, evidence: { ...evidence, acceptance: 'REJECTED', acceptanceReason: reason, acceptedAt: now } };
  }
  if (evidence.execution !== 'SUCCESS') {
    return { ok: false, error: `Cannot accept: execution is ${evidence.execution}. Reject it or run it again.` };
  }
  const blockers: string[] = [];
  if (evidence.verification === 'FAIL') {
    blockers.push('verification failed');
  }
  if (evidence.verification === 'UNVERIFIED' && evidence.verificationRequired) {
    blockers.push('required verification was not completed');
  }
  if (blockers.length > 0 && !opts.override) {
    return { ok: false, error: `Cannot accept: ${blockers.join(' and ')}. Add override with a reason to accept anyway.` };
  }
  return {
    ok: true,
    evidence: {
      ...evidence,
      acceptance: 'ACCEPTED',
      acceptanceReason: reason,
      acceptedAt: now,
      overrideUsed: blockers.length > 0,
    },
  };
}

/** Plain-language labels for the CLI and GUI. Acceptance text states what it means for changed files. */
export function describeAcceptance(e: Evidence): string {
  if (e.acceptance === 'ACCEPTED') {
    const scope = e.changedFiles.length > 0 ? ' The changes were already on disk; this records acceptance and does not apply or approve them.' : '';
    return `Accepted by the user.${scope}`;
  }
  if (e.acceptance === 'REJECTED') {
    return 'Rejected by the user.';
  }
  if (e.acceptance === 'NOT_REQUIRED') {
    return 'Not required (read-only task with no checks).';
  }
  return 'Pending. Only a user decision changes this; an agent\'s own statement never does.';
}

/**
 * The last evidence recorded for a task group. History is append-only, so the newest record
 * with evidence wins (summary first, then user decisions).
 */
export function latestEvidence<T extends { groupId: string; evidence?: Evidence }>(records: T[], groupId: string): Evidence | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i];
    if (r.groupId === groupId && r.evidence) {
      return r.evidence;
    }
  }
  return null;
}

/**
 * Why a task is not (fully) verified, in plain words. Empty only when ORNELYON's own checks passed.
 * It reads recorded states and checks only: an agent's statement is never an input here.
 */
export function evidenceGaps(e: Evidence): string[] {
  const gaps: string[] = [];
  if (e.execution !== 'SUCCESS') {
    gaps.push(`Execution is ${e.execution}.`);
  }
  const failed = e.checks.filter((c) => c.result === 'FAIL').map((c) => c.name);
  const unconfirmed = e.checks.filter((c) => c.result === 'UNVERIFIED').map((c) => c.name);
  if (failed.length > 0) {
    gaps.push(`Failed check(s): ${failed.join(', ')}.`);
  }
  if (unconfirmed.length > 0) {
    gaps.push(`Check(s) that could not be confirmed: ${unconfirmed.join(', ')}.`);
  }
  if (e.verification === 'NOT_RUN') {
    gaps.push('No verification was run, so nothing is confirmed.');
  } else if (e.verification === 'UNVERIFIED' && e.checks.length === 0) {
    gaps.push('Verification was required but no check was recorded.');
  }
  if (e.acceptance === 'PENDING') {
    gaps.push('No user decision is recorded.');
  } else if (e.acceptance === 'REJECTED') {
    gaps.push('The user rejected this task.');
  }
  if (e.overrideUsed) {
    gaps.push('The user accepted despite a failed or missing required check.');
  }
  return gaps;
}
