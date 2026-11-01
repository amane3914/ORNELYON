import { createHash } from 'node:crypto';

/**
 * Smart Dispatch: decides when a second agent is worth calling. It is a rule set that extends the
 * existing routing in orchestrate(). It never starts an agent itself. Nothing runs when it is disabled.
 *
 *   NO_CALL                    the current agent's answer is used as it is
 *   CALL_OTHER_PROVIDER        handled by the existing L3 fallback to the next enabled agent
 *   CALL_SPECIFIC_ROLE         not used in v0.2; reserved for role-based routing
 *   ESCALATE                   the same failure repeated; stop and change method, no further retries
 *   REQUIRE_INDEPENDENT_REVIEW a different agent reviews the answer
 */
export type DispatchAction =
  | 'NO_CALL'
  | 'CALL_OTHER_PROVIDER'
  | 'CALL_SPECIFIC_ROLE'
  | 'ESCALATE'
  | 'REQUIRE_INDEPENDENT_REVIEW';

export interface DispatchDecision {
  action: DispatchAction;
  /** Why this decision was made. Every decision has at least one reason. */
  reasons: string[];
  /** Set for REQUIRE_INDEPENDENT_REVIEW: the agent that would review. */
  reviewer: string | null;
}

export interface DispatchInput {
  enabled: boolean;
  kind: string | null;
  /** The user explicitly asked for an independent review. */
  reviewRequested: boolean;
  /** Kinds that always require review when smart dispatch is on (for example "security"). */
  criticalKinds: string[];
  executionSucceeded: boolean;
  repeatedFailure: boolean;
  /** Reviewer candidate from the existing priority order, or null if none is available. */
  reviewer: string | null;
  /** A previous review with the same key already passed. See reviewKey(). */
  reusablePass: boolean;
  budgetAllowsCall: boolean;
}

export function decideDispatch(input: DispatchInput): DispatchDecision {
  if (!input.enabled) {
    return { action: 'NO_CALL', reasons: ['Smart Dispatch is off; the answer is used as it is.'], reviewer: null };
  }
  if (input.repeatedFailure) {
    return {
      action: 'ESCALATE',
      reasons: ['The same failure repeated. Change the method or the input; ORNELYON does not retry it again automatically.'],
      reviewer: null,
    };
  }
  const critical = input.kind !== null && input.criticalKinds.includes(input.kind);
  const needsReview = input.reviewRequested || critical;
  if (!needsReview) {
    return { action: 'NO_CALL', reasons: ['No review was requested and the task kind is not critical.'], reviewer: null };
  }
  if (!input.executionSucceeded) {
    return { action: 'NO_CALL', reasons: ['The run did not succeed, so there is nothing to review.'], reviewer: null };
  }
  if (input.reusablePass) {
    return { action: 'NO_CALL', reasons: ['An identical review already passed; it is reused without a new call.'], reviewer: null };
  }
  if (!input.budgetAllowsCall) {
    return { action: 'NO_CALL', reasons: ['The daily budget does not allow another call; review is recorded as UNVERIFIED.'], reviewer: null };
  }
  if (input.reviewer === null) {
    return {
      action: 'NO_CALL',
      reasons: ['Review is required, but no other enabled agent is available; review is recorded as UNVERIFIED.'],
      reviewer: null,
    };
  }
  const why = critical ? `kind "${input.kind}" is critical` : 'the user requested an independent review';
  return { action: 'REQUIRE_INDEPENDENT_REVIEW', reasons: [`Independent review by ${input.reviewer}: ${why}.`], reviewer: input.reviewer };
}

/**
 * Key for reusing a review. It changes with the answer, the reviewer, the kind, the constraints
 * and the file fingerprint, so a changed target always gets a new review.
 */
export function reviewKey(parts: { answer: string; reviewer: string; kind: string | null; constraints: string; fileFingerprint: string }): string {
  return createHash('sha256')
    .update(JSON.stringify([parts.answer, parts.reviewer, parts.kind, parts.constraints, parts.fileFingerprint]))
    .digest('hex')
    .slice(0, 32);
}
