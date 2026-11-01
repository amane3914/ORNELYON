import type { AgentKey, ChimeraConfig } from '../core/config.js';
import type { RunRecord } from '../core/history.js';
import { buildContract, validateContract, type DelegationContract } from '../core/contract.js';
import { budgetState } from '../optimization/cost.js';
import { LoopGuard } from '../optimization/loop-guard.js';
import type { AgentAdapter, TaskRequest, TaskResult } from '../core/types.js';
import { buildResult } from '../agents/base.js';
import { randomUUID, createHash } from 'node:crypto';
import { decideDispatch, reviewKey, type DispatchDecision } from './dispatch.js';

/**
 * Levels:
 *   L0  single agent (multi-AI off)
 *   L1  manual switch: the user picks the agent; no automatic switching
 *   L2  mutual review: main agent answers, a different agent reviews it
 *   L3  rule-based routing: declared capabilities, priority and budget decide the order
 * L4 (cooperative execution) is intentionally absent.
 * Smart Dispatch (v0.2) adds an optional independent review on top of L1 and L3. It is off by default.
 */
export type Level = 'L0' | 'L1' | 'L2' | 'L3';

export interface OrchestrateInput {
  groupId: string;
  prompt: string;
  kind: string | null;
  cwd: string;
  sandbox: TaskRequest['sandbox'];
  timeoutMs: number;
  /** L1 only: the agent the user selected. Defaults to the main agent. */
  agent?: AgentKey;
  /** Workspace-relative files the run may change. `null` = no file rule. */
  allowedFiles?: string[] | null;
  /** The user asked for an independent review of the answer. */
  reviewRequested?: boolean;
  /**
   * Run only `agent`: no routing, no switching, no fallback, whatever the mode. Used by handoff so
   * the agent the user named is the one that runs.
   */
  pinAgent?: boolean;
  signal: AbortSignal;
  log: (line: string) => void;
}

export interface OrchestrateDeps {
  adapters: Map<string, AgentAdapter>;
  /** Reported as available by the last detection. Missing entries are treated as available. */
  available?: Map<string, boolean>;
  /** Current history, used for budget checks and review reuse. */
  records: () => RunRecord[];
  record: (record: RunRecord) => void;
  secrets?: string[];
  /** Pause before a retry. Tests set this to 0. */
  retryDelayMs?: number;
  newId?: () => string;
  /** Hash of the files the review depends on (for example, the allowed files). Changes force a new review. */
  fingerprint?: () => string;
}

export interface OrchestrateOutput {
  level: Level;
  final: TaskResult;
  steps: TaskResult[];
  review: TaskResult | null;
  notes: string[];
  /** Smart Dispatch decisions taken for this task, in order. Empty when the feature is off. */
  dispatch: DispatchDecision[];
}

interface CallState {
  calls: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Verdict line written by the reviewer. Anything else is not a verdict. */
export function parseVerdict(output: string): 'OK' | 'ISSUES' | null {
  const m = output.match(/VERDICT:\s*(OK|ISSUES)\b/i);
  return m ? (m[1].toUpperCase() as 'OK' | 'ISSUES') : null;
}

function unavailable(agent: string, taskId: string, kind: 'invalid_request' | 'unknown', message: string): TaskResult {
  return buildResult({
    taskId,
    agent,
    startedAtMs: Date.now(),
    status: 'unavailable',
    output: '',
    model: null,
    usage: { inputTokens: null, outputTokens: null },
    costUsd: null,
    error: { kind, message, signature: `skipped:${message}` },
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** Key tying a review record to what it reviewed. Stored in the record's notes; reused only when it matches. */
function reviewTag(key: string): string {
  return `review-key:${key}`;
}

/**
 * Dry run of the dispatch rules. Starts no agent and reads no agent output: it answers
 * "what would happen if the run succeeded", using only configuration and availability.
 */
export function planDispatch(
  config: ChimeraConfig,
  input: { kind: string | null; reviewRequested: boolean; available: Map<string, boolean>; main: AgentKey },
): DispatchDecision {
  // Same rule as the live path: an explicit review request is honoured even with Smart Dispatch off.
  const on = config.multiAi.enabled && (config.multiAi.smartDispatch.enabled || input.reviewRequested);
  const reviewer = (Object.keys(config.agents) as AgentKey[])
    .filter((id) => id !== input.main && config.agents[id].enabled && (input.available.get(id) ?? true))
    .sort((a, b) => config.agents[a].priority - config.agents[b].priority)[0] ?? null;
  return decideDispatch({
    enabled: on,
    kind: input.kind,
    reviewRequested: input.reviewRequested,
    criticalKinds: config.multiAi.smartDispatch.criticalKinds,
    executionSucceeded: true,
    repeatedFailure: false,
    reviewer,
    reusablePass: false,
    budgetAllowsCall: true,
  });
}

export async function orchestrate(config: ChimeraConfig, input: OrchestrateInput, deps: OrchestrateDeps): Promise<OrchestrateOutput> {
  const guard = new LoopGuard(config.optimization.loopGuard);
  const newId = deps.newId ?? randomUUID;
  const state: CallState = { calls: 0 };
  const steps: TaskResult[] = [];
  const notes: string[] = [];
  const dispatched: DispatchDecision[] = [];
  const multi = config.multiAi.enabled;
  const main = config.multiAi.mainAgent;
  const allowedFiles = input.allowedFiles ?? null;

  const enabledOnly = (id: AgentKey): boolean => config.agents[id].enabled && deps.adapters.has(id);
  const isAvailable = (id: string): boolean => deps.available?.get(id) ?? true;

  /** One call to one agent, with the contract, budget and call caps applied. */
  const attempt = async (
    agentId: string,
    role: RunRecord['role'],
    level: Level,
    rawPrompt: string,
    depth: number,
    parent: string | null,
    tags: string[] = [],
  ): Promise<TaskResult> => {
    const taskId = newId();
    const adapter = deps.adapters.get(agentId);
    const settings = config.agents[agentId as AgentKey];
    if (!adapter || !settings?.enabled) {
      return unavailable(agentId, taskId, 'invalid_request', `${agentId} is disabled in the agent settings.`);
    }
    if (depth > config.multiAi.maxDepth) {
      return unavailable(agentId, taskId, 'invalid_request', `Nesting depth ${depth} exceeds maxDepth=${config.multiAi.maxDepth}.`);
    }
    const prompt = settings.promptPrefix ? `${settings.promptPrefix}\n\n${rawPrompt}` : rawPrompt;
    if (state.calls >= config.multiAi.maxCalls) {
      return unavailable(agentId, taskId, 'invalid_request', `Call limit reached (maxCalls=${config.multiAi.maxCalls}).`);
    }
    const budget = budgetState(deps.records(), agentId, settings.budgetUsd, new Date(Date.now() - DAY_MS).toISOString());
    if (budget.state === 'exceeded') {
      return unavailable(agentId, taskId, 'invalid_request', `Daily budget reached for ${agentId} ($${budget.spentUsd.toFixed(4)} of $${budget.limitUsd}).`);
    }
    // The contract is built and validated before any process starts. An invalid one is refused.
    const contract: DelegationContract = buildContract({
      invocationId: taskId,
      parentInvocationId: parent,
      taskId,
      groupId: input.groupId,
      agent: agentId,
      model: settings.model,
      role: role === 'review' ? 'review' : role === 'fallback' ? 'handoff' : 'task',
      objective: rawPrompt.slice(0, 2000) || 'task',
      allowedFiles,
      permissions: { sandbox: input.sandbox },
      timeoutSec: Math.max(1, Math.min(settings.timeoutSec, Math.ceil(input.timeoutMs / 1000))),
      budgetUsd: settings.budgetUsd,
      invocationDepth: depth,
      maxDepth: config.multiAi.maxDepth,
      expectedOutput: role === 'review' ? 'A verdict line: VERDICT: OK or VERDICT: ISSUES, then short bullet points.' : 'The answer to the task.',
      verificationRequirements: [],
    });
    const contractErrors = validateContract(contract);
    if (contractErrors.length > 0) {
      return unavailable(agentId, taskId, 'invalid_request', `Invalid delegation contract: ${contractErrors.join('; ')}`);
    }
    state.calls += 1;
    const request: TaskRequest = {
      id: taskId,
      prompt,
      cwd: input.cwd,
      kind: input.kind ?? undefined,
      agent: agentId,
      // The agent's own timeout applies, capped by the caller's limit.
      timeoutMs: Math.min(settings.timeoutSec * 1000, input.timeoutMs),
      sandbox: input.sandbox,
    };
    const result = await adapter.run(request, { signal: input.signal, log: input.log });
    deps.record({
      recordedAt: new Date().toISOString(),
      role,
      groupId: input.groupId,
      mode: level,
      kind: input.kind,
      prompt,
      result,
      contract,
      origin: adapter.provenance,
      notes: tags.length > 0 ? tags : undefined,
    });
    return result;
  };

  /** Run one agent, retrying only failures the loop guard allows. */
  const runWithRetries = async (
    agentId: string,
    role: RunRecord['role'],
    level: Level,
    prompt: string,
    depth: number,
    parent: string | null = null,
    tags: string[] = [],
  ): Promise<TaskResult> => {
    let retries = 0;
    for (;;) {
      const result = await attempt(agentId, role, level, prompt, depth, parent, tags);
      steps.push(result);
      if (result.status === 'success' || result.status === 'cancelled') {
        return result;
      }
      if (result.errorKind === 'invalid_request' && result.errorSignature?.startsWith('skipped:')) {
        notes.push(result.errorMessage ?? 'Skipped.');
        return result;
      }
      const decision = guard.decide(result, retries);
      notes.push(`[${agentId}] ${decision.reason}`);
      if (decision.action === 'retry') {
        retries += 1;
        await sleep(deps.retryDelayMs ?? 1500, input.signal);
        if (input.signal.aborted) {
          return result;
        }
        continue;
      }
      if ('suggestion' in decision) {
        notes.push(`Suggestion: ${decision.suggestion}`);
      }
      return result;
    }
  };

  /** Smart Dispatch for a finished L1 or L3 answer. Reuses an identical passed review when one exists. */
  const dispatchReview = async (final: TaskResult, level: Level, repeatedFailure: boolean): Promise<TaskResult | null> => {
    // An explicit review request runs even when Smart Dispatch is off; the rule set itself stays off.
    const smartOn = multi && (config.multiAi.smartDispatch.enabled || (input.reviewRequested ?? false));
    const reviewers = (Object.keys(config.agents) as AgentKey[])
      .filter((id) => id !== final.agent && enabledOnly(id) && isAvailable(id))
      .sort((a, b) => config.agents[a].priority - config.agents[b].priority);
    const reviewer = reviewers[0] ?? null;
    const key = reviewer
      ? reviewKey({
          answer: createHash('sha256').update(final.output).digest('hex'),
          reviewer,
          kind: input.kind,
          constraints: JSON.stringify({ allowedFiles, sandbox: input.sandbox }),
          fileFingerprint: deps.fingerprint?.() ?? '',
        })
      : '';
    const reusable = reviewer !== null && deps.records().some((r) =>
      r.role === 'review' &&
      r.result.status === 'success' &&
      (r.notes ?? []).includes(reviewTag(key)) &&
      parseVerdict(r.result.output) === 'OK',
    );
    const budget = reviewer ? budgetState(deps.records(), reviewer, config.agents[reviewer as AgentKey].budgetUsd, new Date(Date.now() - DAY_MS).toISOString()) : null;
    const decision = decideDispatch({
      enabled: smartOn,
      kind: input.kind,
      reviewRequested: input.reviewRequested ?? false,
      criticalKinds: config.multiAi.smartDispatch.criticalKinds,
      executionSucceeded: final.status === 'success',
      repeatedFailure,
      reviewer,
      reusablePass: reusable,
      budgetAllowsCall: budget === null || budget.state !== 'exceeded',
    });
    if (!smartOn) {
      return null;
    }
    dispatched.push(decision);
    for (const reason of decision.reasons) {
      notes.push(`[dispatch:${level}] ${decision.action}: ${reason}`);
    }
    if (decision.action !== 'REQUIRE_INDEPENDENT_REVIEW' || reviewer === null) {
      return null;
    }
    const reviewPrompt = [
      'You are reviewing another AI agent\'s answer. Check it for correctness, missed requirements and risks.',
      'Reply with a verdict line starting with "VERDICT: OK" or "VERDICT: ISSUES", then short bullet points.',
      '',
      '## Original task',
      input.prompt,
      '',
      '## Answer to review',
      final.output,
    ].join('\n');
    return runWithRetries(reviewer, 'review', level, reviewPrompt, 1, final.taskId, [reviewTag(key)]);
  };

  // L0: multi-AI is off. Only the main agent is used unless the caller names one explicitly.
  if (!multi && !input.pinAgent) {
    const final = await runWithRetries(input.agent ?? main, 'task', 'L0', input.prompt, 0);
    return { level: 'L0', final, steps, review: null, notes, dispatch: dispatched };
  }

  // A pinned agent (handoff) is never routed or switched, whatever the mode is.
  if (input.pinAgent || config.multiAi.mode === 'manual') {
    const agent = input.agent ?? main;
    const final = await runWithRetries(agent, 'task', 'L1', input.prompt, 0);
    if (final.status !== 'success') {
      notes.push('Manual mode does not switch agents. Pick another agent and run again.');
    }
    const review = await dispatchReview(final, 'L1', false);
    return { level: 'L1', final, steps, review, notes, dispatch: dispatched };
  }

  if (config.multiAi.mode === 'review') {
    const agent = input.agent ?? main;
    const final = await runWithRetries(agent, 'task', 'L2', input.prompt, 0);
    if (final.status !== 'success') {
      return { level: 'L2', final, steps, review: null, notes, dispatch: dispatched };
    }
    if (config.multiAi.maxDepth < 1) {
      notes.push('Review skipped: multiAi.maxDepth is 0, so no nested agent call is allowed.');
      return { level: 'L2', final, steps, review: null, notes, dispatch: dispatched };
    }
    const reviewers = (Object.keys(config.agents) as AgentKey[])
      .filter((id) => id !== agent && enabledOnly(id) && isAvailable(id))
      .sort((a, b) => config.agents[a].priority - config.agents[b].priority);
    if (reviewers.length === 0) {
      notes.push('No other enabled agent is available to review this answer.');
      return { level: 'L2', final, steps, review: null, notes, dispatch: dispatched };
    }
    const reviewer = reviewers[0];
    const reviewPrompt = [
      'You are reviewing another AI agent\'s answer. Check it for correctness, missed requirements and risks.',
      'Reply with a verdict line starting with "VERDICT: OK" or "VERDICT: ISSUES", then short bullet points.',
      '',
      '## Original task',
      input.prompt,
      '',
      '## Answer to review',
      final.output,
    ].join('\n');
    const review = await runWithRetries(reviewer, 'review', 'L2', reviewPrompt, 1, final.taskId);
    return { level: 'L2', final, steps, review, notes, dispatch: dispatched };
  }

  // L3: rule-based routing. Order comes from declared priority; capabilities are declared by the user.
  const candidates = (Object.keys(config.agents) as AgentKey[])
    .filter((id) => enabledOnly(id))
    .filter((id) => input.kind === null || config.agents[id].capabilities.includes(input.kind))
    .sort((a, b) => config.agents[a].priority - config.agents[b].priority);
  const unavailableIds = (Object.keys(config.agents) as AgentKey[]).filter((id) => enabledOnly(id) && !isAvailable(id));
  for (const id of unavailableIds) {
    notes.push(`${id} was skipped: not installed or not signed in at the last check.`);
  }
  const ordered = candidates.filter((id) => isAvailable(id));
  if (ordered.length === 0) {
    const final = unavailable(main, newId(), 'invalid_request', `No enabled agent matches kind "${input.kind ?? 'any'}" and is available.`);
    notes.push(final.errorMessage ?? 'No candidate.');
    return { level: 'L3', final, steps, review: null, notes, dispatch: dispatched };
  }
  let final: TaskResult | null = null;
  for (let i = 0; i < ordered.length; i += 1) {
    const id = ordered[i];
    final = await runWithRetries(id, 'task', 'L3', input.prompt, 0);
    if (final.status === 'success' || final.status === 'cancelled') {
      break;
    }
    const next = ordered[i + 1];
    if (next) {
      notes.push(`Falling back from ${id} to ${next}.`);
    }
  }
  const answer = final as TaskResult;
  // The same failure signature as often as the loop guard allows: escalate instead of calling again.
  const sameFailures = answer.errorSignature === null ? 0 : steps.filter((s) => s.errorSignature === answer.errorSignature).length;
  const repeated = answer.status !== 'success' && sameFailures >= config.optimization.loopGuard.stopAfterSameErrors;
  const review = await dispatchReview(answer, 'L3', repeated);
  return { level: 'L3', final: answer, steps, review, notes, dispatch: dispatched };
}
