import { CALL_ROLES, type RunRecord } from '../core/history.js';

/**
 * Cost monitor. Figures come only from what agents report. A missing value is counted as
 * "unknown" and shown as such. Prices are never estimated or guessed.
 */

export interface AgentCostSummary {
  agent: string;
  runs: number;
  succeeded: number;
  failed: number;
  totalDurationMs: number;
  /** Null when no run reported a value. */
  inputTokens: number | null;
  outputTokens: number | null;
  tokenUnknownRuns: number;
  /** Sum of reported USD costs, or null when none was reported. */
  reportedCostUsd: number | null;
  costUnknownRuns: number;
}

export function summarizeCosts(records: RunRecord[], sinceIso?: string): AgentCostSummary[] {
  const byAgent = new Map<string, AgentCostSummary>();
  for (const record of records) {
    // Only agent calls are costed. Summaries and user decisions repeat a result and must not be counted twice.
    if (!CALL_ROLES.includes(record.role)) {
      continue;
    }
    if (sinceIso && record.recordedAt < sinceIso) {
      continue;
    }
    const r = record.result;
    const s =
      byAgent.get(r.agent) ??
      ({
        agent: r.agent,
        runs: 0,
        succeeded: 0,
        failed: 0,
        totalDurationMs: 0,
        inputTokens: null,
        outputTokens: null,
        tokenUnknownRuns: 0,
        reportedCostUsd: null,
        costUnknownRuns: 0,
      } satisfies AgentCostSummary);
    s.runs += 1;
    if (r.status === 'success') {
      s.succeeded += 1;
    } else {
      s.failed += 1;
    }
    s.totalDurationMs += r.durationMs;
    if (r.usage.inputTokens === null && r.usage.outputTokens === null) {
      s.tokenUnknownRuns += 1;
    } else {
      s.inputTokens = (s.inputTokens ?? 0) + (r.usage.inputTokens ?? 0);
      s.outputTokens = (s.outputTokens ?? 0) + (r.usage.outputTokens ?? 0);
    }
    if (r.costUsd === null) {
      s.costUnknownRuns += 1;
    } else {
      s.reportedCostUsd = (s.reportedCostUsd ?? 0) + r.costUsd;
    }
    byAgent.set(r.agent, s);
  }
  return [...byAgent.values()].sort((a, b) => a.agent.localeCompare(b.agent));
}

export type BudgetState =
  | { state: 'no_limit' }
  | { state: 'within'; spentUsd: number; limitUsd: number }
  | { state: 'exceeded'; spentUsd: number; limitUsd: number }
  | { state: 'unverified'; spentUsd: number; limitUsd: number };

/**
 * Compare reported spend in the window with a limit. `unverified` means some runs in the
 * window reported no cost, so the true spend cannot be confirmed.
 */
export function budgetState(records: RunRecord[], agent: string, limitUsd: number | null, sinceIso: string): BudgetState {
  if (limitUsd === null) {
    return { state: 'no_limit' };
  }
  const summary = summarizeCosts(records, sinceIso).find((s) => s.agent === agent);
  const spentUsd = summary?.reportedCostUsd ?? 0;
  if (spentUsd >= limitUsd) {
    return { state: 'exceeded', spentUsd, limitUsd };
  }
  if (summary && summary.costUnknownRuns > 0) {
    return { state: 'unverified', spentUsd, limitUsd };
  }
  return { state: 'within', spentUsd, limitUsd };
}
