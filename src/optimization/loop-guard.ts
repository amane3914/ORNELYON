import type { ErrorKind, TaskResult } from '../core/types.js';

/**
 * Failure-loop guard. It works between attempts (retries and fallbacks), not inside an
 * agent's own run. A live intervention in an external agent is not possible, and the
 * interface never claims one.
 */

export interface LoopGuardOptions {
  enabled: boolean;
  maxRetries: number;
  stopAfterSameErrors: number;
}

export type LoopDecision =
  | { action: 'retry'; reason: string }
  | { action: 'change_method'; reason: string; suggestion: string }
  | { action: 'stop'; reason: string; suggestion: string };

/** Errors that a retry cannot fix. The guard stops at once and points to the fix. */
const NON_RETRYABLE: ErrorKind[] = ['not_installed', 'not_authenticated', 'invalid_request', 'cancelled'];

const SUGGESTIONS: Partial<Record<ErrorKind, string>> = {
  not_installed: 'Install the agent CLI, or start the local server, then run the setup check again.',
  not_authenticated: 'Sign in with the agent\'s official login command, then retry.',
  rate_limited: 'Wait for the limit to reset, or route this task to another agent.',
  timeout: 'Split the task into smaller steps or raise the timeout for this agent.',
  invalid_request: 'Check the model name and the request settings.',
};

export class LoopGuard {
  private readonly counts = new Map<string, number>();

  constructor(private readonly options: LoopGuardOptions) {}

  /** Decide what to do after a failed attempt. `attemptsSoFar` counts retries already made for this agent. */
  decide(result: TaskResult, attemptsSoFar: number): LoopDecision {
    const kind: ErrorKind = result.errorKind ?? 'unknown';
    const signature = `${result.agent}|${kind}|${result.errorSignature ?? ''}`;
    const repeated = (this.counts.get(signature) ?? 0) + 1;
    this.counts.set(signature, repeated);
    const hint = SUGGESTIONS[kind] ?? 'Change the prompt or choose a different agent.';

    if (!this.options.enabled) {
      return { action: 'stop', reason: 'Failure-loop guard is off.', suggestion: hint };
    }
    if (NON_RETRYABLE.includes(kind)) {
      return { action: 'stop', reason: `${kind} cannot be fixed by retrying.`, suggestion: hint };
    }
    if (repeated >= this.options.stopAfterSameErrors) {
      return {
        action: 'stop',
        reason: `The same failure (${kind}) happened ${repeated} times.`,
        suggestion: hint,
      };
    }
    if (attemptsSoFar < this.options.maxRetries) {
      return { action: 'retry', reason: `Retrying ${kind} (${attemptsSoFar + 1}/${this.options.maxRetries}).` };
    }
    return {
      action: 'change_method',
      reason: `Retry limit reached for ${kind}.`,
      suggestion: 'Try a different agent for this task, or change the prompt.',
    };
  }

  /** Number of times this exact failure has been seen during the current guard lifetime. */
  seen(result: TaskResult): number {
    const kind: ErrorKind = result.errorKind ?? 'unknown';
    return this.counts.get(`${result.agent}|${kind}|${result.errorSignature ?? ''}`) ?? 0;
  }
}
