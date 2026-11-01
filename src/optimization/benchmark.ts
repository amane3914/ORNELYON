import { createHash } from 'node:crypto';
import { CALL_ROLES, type RunRecord } from '../core/history.js';
import { executionFor, latestEvidence, type Acceptance, type Execution, type Verification } from '../core/evidence.js';

/**
 * Efficiency Benchmark. Pure functions over history records: no agent is called, nothing is written, and the
 * same records always give the same report. Numbers come only from what agents reported. A value that was
 * not reported stays unknown and is never estimated, so averages are taken over the tasks that have the value
 * and the number of those tasks is always shown.
 *
 * A history is observational data. Two groups of tasks taken from it differ in more than the harness, so a
 * comparison states what differs, and says so when it cannot be called a like-for-like comparison.
 */

export type Shape = 'single' | 'multi' | 'handoff';

/** One user task (a group of history records). */
export interface TaskRow {
  groupId: string;
  startedAt: string;
  /** The agent that produced the final answer. */
  agent: string;
  kind: string | null;
  /** single: one call. multi: review or fallback calls were added. handoff: started from another task's passport. */
  shape: Shape;
  calls: number;
  /** Calls beyond the first. */
  extraCalls: number;
  execution: Execution;
  verification: Verification;
  acceptance: Acceptance;
  /** Sum of the agents' own run times. Not wall-clock time. */
  durationMs: number;
  /** Null when at least one call of the task did not report it. */
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** Share of the reported cost that came from calls after the first. Null when the cost is unknown. */
  extraCostUsd: number | null;
  /** sha256 of the first prompt. Lets two runs of the same request be paired. Null for handoffs (their prompt is generated). */
  promptKey: string | null;
  /** Calls that are known not to be real agent use: the recorded origin says so, or the agent or model name does. */
  nonRealCalls: number;
  /** Calls with no recorded origin (history from before v0.4.1, or an adapter that does not declare one). Never assumed real. */
  unknownOriginCalls: number;
  /**
   * real: every call has a recorded real origin (cli or local-endpoint). non-real: at least one call is known not
   * to be real. unknown: no call is known to be non-real, but at least one has no recorded origin.
   */
  origin: 'real' | 'non-real' | 'unknown';
}

export interface BuildResult {
  rows: TaskRow[];
  /** Call records that repeated an already counted task id. They are skipped so one use is never counted twice. */
  duplicateCallsSkipped: number;
}

const NON_REAL = /^(fake|synthetic|mock)/i;

const REAL_ORIGINS = new Set(['cli', 'local-endpoint']);

/** Known not to be real: ORNELYON recorded a fake or test origin, or (for older records) the name says so. */
function isNonReal(r: RunRecord): boolean {
  if (r.origin !== undefined && !REAL_ORIGINS.has(r.origin)) {
    return true;
  }
  return NON_REAL.test(r.result.agent) || (r.result.model !== null && NON_REAL.test(r.result.model));
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Turn history into one row per user task. Only agent calls are counted, once each. */
export function buildRows(records: RunRecord[]): BuildResult {
  const seen = new Set<string>();
  let duplicateCallsSkipped = 0;
  const groups = new Map<string, { calls: RunRecord[]; summary: RunRecord | null }>();
  for (const r of records) {
    if (!r.groupId) {
      continue;
    }
    const g = groups.get(r.groupId) ?? { calls: [], summary: null };
    if (CALL_ROLES.includes(r.role)) {
      // A repeat is a line that is identical in every identifying field. A different call that reused an id would still count.
      const key = `${r.groupId}/${r.result.taskId}/${r.role}/${r.result.agent}/${r.recordedAt}`;
      if (seen.has(key)) {
        duplicateCallsSkipped += 1;
      } else {
        seen.add(key);
        g.calls.push(r);
      }
    } else if (r.role === 'summary') {
      g.summary = r;
    }
    groups.set(r.groupId, g);
  }
  const rows: TaskRow[] = [];
  for (const [groupId, g] of groups) {
    if (g.calls.length === 0) {
      continue; // decisions or summaries with no recorded call carry no usage
    }
    const final = g.summary ?? g.calls[g.calls.length - 1];
    const handoff = g.summary?.handoff !== undefined || g.calls.some((c) => c.notes?.some((n) => n.startsWith('handoff-from:')) === true) || (g.summary?.notes ?? []).some((n) => n.startsWith('handoff-from:'));
    const shape: Shape = handoff ? 'handoff' : g.calls.length > 1 ? 'multi' : 'single';
    const evidence = latestEvidence(records, groupId);
    // Input and output tokens are known independently. One unknown call makes that side unknown, never 0.
    const inputKnown = g.calls.every((c) => c.result.usage.inputTokens !== null);
    const outputKnown = g.calls.every((c) => c.result.usage.outputTokens !== null);
    const costKnown = g.calls.every((c) => c.result.costUsd !== null);
    const first = g.calls[0];
    rows.push({
      groupId,
      startedAt: first.recordedAt,
      agent: final.result.agent,
      kind: first.kind,
      shape,
      calls: g.calls.length,
      extraCalls: g.calls.length - 1,
      execution: evidence?.execution ?? executionFor(final.result.status),
      verification: evidence?.verification ?? 'NOT_RUN',
      acceptance: evidence?.acceptance ?? 'NOT_REQUIRED',
      durationMs: g.calls.reduce((s, c) => s + c.result.durationMs, 0),
      inputTokens: inputKnown ? g.calls.reduce((s, c) => s + (c.result.usage.inputTokens ?? 0), 0) : null,
      outputTokens: outputKnown ? g.calls.reduce((s, c) => s + (c.result.usage.outputTokens ?? 0), 0) : null,
      costUsd: costKnown ? g.calls.reduce((s, c) => s + (c.result.costUsd ?? 0), 0) : null,
      extraCostUsd: costKnown ? g.calls.slice(1).reduce((s, c) => s + (c.result.costUsd ?? 0), 0) : null,
      promptKey: handoff ? null : sha(first.prompt.trim()),
      nonRealCalls: g.calls.filter(isNonReal).length,
      unknownOriginCalls: g.calls.filter((c) => c.origin === undefined && !isNonReal(c)).length,
      origin: g.calls.some(isNonReal) ? 'non-real' : g.calls.every((c) => c.origin !== undefined && REAL_ORIGINS.has(c.origin)) ? 'real' : 'unknown',
    });
  }
  rows.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.groupId.localeCompare(b.groupId)));
  return { rows, duplicateCallsSkipped };
}

export interface Selector {
  agent?: string;
  kind?: string;
  shape?: Shape;
  /** ISO time, inclusive. */
  since?: string;
  /** ISO time, exclusive. */
  until?: string;
}

export function selectRows(rows: TaskRow[], s: Selector): TaskRow[] {
  return rows.filter(
    (r) =>
      (s.agent === undefined || r.agent === s.agent) &&
      (s.kind === undefined || r.kind === s.kind) &&
      (s.shape === undefined || r.shape === s.shape) &&
      (s.since === undefined || r.startedAt >= s.since) &&
      (s.until === undefined || r.startedAt < s.until),
  );
}

/** Sum and count of a value over the tasks that reported it. */
export interface Known {
  /** Tasks that reported the value. */
  n: number;
  /** Tasks that did not. They are left out of `sum` and `mean`, never filled in. */
  unknown: number;
  sum: number | null;
  mean: number | null;
}

function known(values: (number | null)[]): Known {
  const have = values.filter((v): v is number => v !== null);
  const sum = have.length === 0 ? null : have.reduce((a, b) => a + b, 0);
  return { n: have.length, unknown: values.length - have.length, sum, mean: sum === null ? null : sum / have.length };
}

export interface CohortStats {
  tasks: number;
  calls: number;
  extraCalls: number;
  agents: Record<string, number>;
  kinds: Record<string, number>;
  shapes: Record<string, number>;
  executionSuccess: number;
  verificationPass: number;
  verificationFail: number;
  /** PASS, FAIL or UNVERIFIED: ORNELYON ran or required a check. NOT_RUN tasks are not part of this. */
  verificationChecked: number;
  accepted: number;
  rejected: number;
  durationMs: Known;
  inputTokens: Known;
  outputTokens: Known;
  costUsd: Known;
  extraCostUsd: Known;
  /** Reported cost divided by tasks with Execution SUCCESS. Null unless every task reported its cost. */
  costPerSuccessUsd: number | null;
  nonRealCalls: number;
  unknownOriginCalls: number;
  /** Tasks by origin. Only 'real' tasks (every call from a recorded real origin) support a claim about real use. */
  origins: { real: number; nonReal: number; unknown: number };
}

function tally<T extends string | null>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    const k = v ?? '(none)';
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function cohortStats(rows: TaskRow[]): CohortStats {
  const success = rows.filter((r) => r.execution === 'SUCCESS').length;
  const costs = known(rows.map((r) => r.costUsd));
  return {
    tasks: rows.length,
    calls: rows.reduce((s, r) => s + r.calls, 0),
    extraCalls: rows.reduce((s, r) => s + r.extraCalls, 0),
    agents: tally(rows.map((r) => r.agent)),
    kinds: tally(rows.map((r) => r.kind)),
    shapes: tally(rows.map((r) => r.shape)),
    executionSuccess: success,
    verificationPass: rows.filter((r) => r.verification === 'PASS').length,
    verificationFail: rows.filter((r) => r.verification === 'FAIL').length,
    verificationChecked: rows.filter((r) => r.verification !== 'NOT_RUN').length,
    accepted: rows.filter((r) => r.acceptance === 'ACCEPTED').length,
    rejected: rows.filter((r) => r.acceptance === 'REJECTED').length,
    durationMs: known(rows.map((r) => r.durationMs)),
    inputTokens: known(rows.map((r) => r.inputTokens)),
    outputTokens: known(rows.map((r) => r.outputTokens)),
    costUsd: costs,
    extraCostUsd: known(rows.map((r) => r.extraCostUsd)),
    costPerSuccessUsd: rows.length > 0 && costs.unknown === 0 && success > 0 && costs.sum !== null ? costs.sum / success : null,
    nonRealCalls: rows.reduce((s, r) => s + r.nonRealCalls, 0),
    unknownOriginCalls: rows.reduce((s, r) => s + r.unknownOriginCalls, 0),
    origins: { real: rows.filter((r) => r.origin === 'real').length, nonReal: rows.filter((r) => r.origin === 'non-real').length, unknown: rows.filter((r) => r.origin === 'unknown').length },
  };
}

export interface BenchmarkReport {
  /** sha256 of the canonical task rows. The same history gives the same value. */
  dataSha256: string;
  duplicateCallsSkipped: number;
  /** Always true for history: tasks were not assigned to groups at random or under identical conditions. */
  observational: true;
  notes: string[];
  cohorts: { label: string; selector: Selector; stats: CohortStats }[];
}

const GENERAL_NOTE =
  'History is observational data: the tasks in different groups were not chosen to be alike. Token and cost figures are what each agent reported (providers count tokens differently); unreported values are left out, not estimated.';

function realityNotes(stats: CohortStats[]): string[] {
  const nonReal = stats.reduce((s, c) => s + c.nonRealCalls, 0);
  const unknown = stats.reduce((s, c) => s + c.origins.unknown, 0);
  return [
    ...(nonReal > 0 ? [`${nonReal} call(s) came from fake, test or synthetic agents. Their numbers test the measuring code and say nothing about real token or cost savings.`] : []),
    ...(unknown > 0 ? [`${unknown} task(s) have no recorded origin (history from before v0.4.1, or an adapter that does not declare one). They are not treated as real agent use, and they are not treated as fake either.`] : []),
  ];
}

function digest(rows: TaskRow[]): string {
  return sha(JSON.stringify(rows));
}

export type GroupBy = 'agent' | 'kind' | 'shape' | 'none';

/** Summary of the selected tasks, optionally split by agent, kind or shape. */
export function summarize(records: RunRecord[], selector: Selector, by: GroupBy): BenchmarkReport {
  const built = buildRows(records);
  const rows = selectRows(built.rows, selector);
  const parts = new Map<string, TaskRow[]>();
  for (const r of rows) {
    const key = by === 'none' ? 'all selected tasks' : `${by}=${String(by === 'agent' ? r.agent : by === 'kind' ? (r.kind ?? '(none)') : r.shape)}`;
    parts.set(key, [...(parts.get(key) ?? []), r]);
  }
  const cohorts = [...parts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, rs]) => ({ label, selector, stats: cohortStats(rs) }));
  const notes = [GENERAL_NOTE, ...realityNotes(cohorts.map((c) => c.stats))];
  if (by !== 'none' && cohorts.length > 1) {
    notes.push('The groups above may differ in task kind, size and agent. Use `benchmark compare` to see what differs before reading a difference as an effect.');
  }
  return { dataSha256: digest(rows), duplicateCallsSkipped: built.duplicateCallsSkipped, observational: true, notes, cohorts };
}

export interface Delta {
  a: number | null;
  b: number | null;
  /** b minus a. Null when either side is unknown. */
  diff: number | null;
  /** b divided by a. Null when either side is unknown or a is zero. */
  ratio: number | null;
}

function delta(a: number | null, b: number | null): Delta {
  return { a, b, diff: a === null || b === null ? null : b - a, ratio: a === null || b === null || a === 0 ? null : b / a };
}

export interface PairedStats {
  /** Requests that appear in both cohorts with an identical first prompt. */
  pairs: number;
  cost: { n: number; a: number | null; b: number | null };
  tokens: { n: number; a: number | null; b: number | null };
  durationMs: { n: number; a: number | null; b: number | null };
  calls: { n: number; a: number | null; b: number | null };
}

export interface ConditionSummary {
  tasks: number;
  shapes: Record<string, number>;
  kinds: Record<string, number>;
  agents: Record<string, number>;
  origins: { real: number; nonReal: number; unknown: number };
}

export interface CompareReport {
  dataSha256: string;
  duplicateCallsSkipped: number;
  observational: true;
  /** True only when the cohorts share the same task kinds and the same set of final agents, have no overlap and enough tasks. */
  likeForLike: boolean;
  caveats: string[];
  /** The facts that decide whether the groups can be compared, side by side. */
  conditions: { a: ConditionSummary; b: ConditionSummary; differences: string[] };
  a: { selector: Selector; stats: CohortStats };
  b: { selector: Selector; stats: CohortStats };
  /** Per-task means over tasks that reported the value. `n` on each side is in the stats. */
  perTask: {
    calls: Delta;
    costUsd: Delta;
    inputTokens: Delta;
    outputTokens: Delta;
    durationMs: Delta;
    successRate: Delta;
    verificationPassRate: Delta;
  };
  paired: PairedStats;
}

const MIN_TASKS = 5;

function rate(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

function pairedStats(a: TaskRow[], b: TaskRow[]): PairedStats {
  // Earliest task per identical request on each side.
  const first = (rows: TaskRow[]): Map<string, TaskRow> => {
    const m = new Map<string, TaskRow>();
    for (const r of rows) {
      if (r.promptKey !== null && !m.has(r.promptKey)) {
        m.set(r.promptKey, r);
      }
    }
    return m;
  };
  const fa = first(a);
  const fb = first(b);
  const pairs: [TaskRow, TaskRow][] = [];
  for (const [k, ra] of fa) {
    const rb = fb.get(k);
    if (rb && rb.groupId !== ra.groupId) {
      pairs.push([ra, rb]);
    }
  }
  const side = (pick: (r: TaskRow) => number | null): { n: number; a: number | null; b: number | null } => {
    const both = pairs.filter(([x, y]) => pick(x) !== null && pick(y) !== null);
    return {
      n: both.length,
      a: both.length === 0 ? null : both.reduce((s, [x]) => s + (pick(x) ?? 0), 0),
      b: both.length === 0 ? null : both.reduce((s, [, y]) => s + (pick(y) ?? 0), 0),
    };
  };
  const tok = (r: TaskRow): number | null => (r.inputTokens === null || r.outputTokens === null ? null : r.inputTokens + r.outputTokens);
  return { pairs: pairs.length, cost: side((r) => r.costUsd), tokens: side(tok), durationMs: side((r) => r.durationMs), calls: side((r) => r.calls) };
}

/** Compare two groups of tasks from the same history, for example single-agent runs against orchestrated runs. */
export function compare(records: RunRecord[], sa: Selector, sb: Selector): CompareReport {
  const built = buildRows(records);
  const ra = selectRows(built.rows, sa);
  const rb = selectRows(built.rows, sb);
  const a = cohortStats(ra);
  const b = cohortStats(rb);
  const caveats: string[] = [GENERAL_NOTE, ...realityNotes([a, b])];
  const overlap = ra.filter((x) => rb.some((y) => y.groupId === x.groupId)).length;
  if (overlap > 0) {
    caveats.push(`${overlap} task(s) are in both groups.`);
  }
  if (a.tasks < MIN_TASKS || b.tasks < MIN_TASKS) {
    caveats.push(`A group has fewer than ${MIN_TASKS} tasks (A: ${a.tasks}, B: ${b.tasks}); a difference this small is not reliable.`);
  }
  const sameKeys = (x: Record<string, number>, y: Record<string, number>): boolean => Object.keys(x).join('|') === Object.keys(y).join('|');
  const kindsMatch = sameKeys(a.kinds, b.kinds);
  const agentsMatch = sameKeys(a.agents, b.agents);
  if (!kindsMatch) {
    caveats.push(`Task kinds differ (A: ${Object.keys(a.kinds).join(', ') || 'none'}; B: ${Object.keys(b.kinds).join(', ') || 'none'}).`);
  }
  if (!agentsMatch) {
    caveats.push(`Final agents differ (A: ${Object.keys(a.agents).join(', ') || 'none'}; B: ${Object.keys(b.agents).join(', ') || 'none'}); tokens and prices are not comparable across providers.`);
  }
  for (const [name, s] of [['A', a], ['B', b]] as const) {
    if (s.costUsd.unknown > 0 || s.inputTokens.unknown > 0 || s.outputTokens.unknown > 0) {
      caveats.push(`Group ${name}: ${s.costUsd.unknown} task(s) reported no cost, ${s.inputTokens.unknown} no input tokens and ${s.outputTokens.unknown} no output tokens; they are left out of those averages.`);
    }
  }
  const sameShapes = sameKeys(a.shapes, b.shapes);
  if (sameShapes && Object.keys(a.shapes).length === 1 && a.tasks > 0 && b.tasks > 0) {
    caveats.push(`Both groups are only "${Object.keys(a.shapes)[0]}" tasks, so this is not a single-agent against multi-agent comparison.`);
  }
  const originOk = a.origins.real === a.tasks && b.origins.real === b.tasks;
  if (!originOk) {
    caveats.push('Not every task has a recorded real origin, so the figures cannot be called real agent use.');
  }
  const paired = pairedStats(ra, rb);
  if (paired.pairs === 0) {
    caveats.push('No request appears in both groups with an identical prompt, so there is no paired comparison.');
  }
  const likeForLike = kindsMatch && agentsMatch && overlap === 0 && a.tasks >= MIN_TASKS && b.tasks >= MIN_TASKS && originOk;
  const summary = (x: CohortStats): ConditionSummary => ({ tasks: x.tasks, shapes: x.shapes, kinds: x.kinds, agents: x.agents, origins: x.origins });
  const differences = [
    ...(kindsMatch ? [] : ['task kinds']),
    ...(agentsMatch ? [] : ['final agents']),
    ...(sameShapes ? [] : ['shapes (single / multi / handoff)']),
    ...(overlap > 0 ? ['overlapping tasks'] : []),
    ...(a.tasks < MIN_TASKS || b.tasks < MIN_TASKS ? ['group size'] : []),
    ...(originOk ? [] : ['origin (not all real)']),
  ];
  return {
    dataSha256: sha(JSON.stringify([ra, rb])),
    duplicateCallsSkipped: built.duplicateCallsSkipped,
    observational: true,
    likeForLike,
    caveats,
    conditions: { a: summary(a), b: summary(b), differences },
    a: { selector: sa, stats: a },
    b: { selector: sb, stats: b },
    perTask: {
      calls: delta(rate(a.calls, a.tasks), rate(b.calls, b.tasks)),
      costUsd: delta(a.costUsd.mean, b.costUsd.mean),
      inputTokens: delta(a.inputTokens.mean, b.inputTokens.mean),
      outputTokens: delta(a.outputTokens.mean, b.outputTokens.mean),
      durationMs: delta(a.durationMs.mean, b.durationMs.mean),
      successRate: delta(rate(a.executionSuccess, a.tasks), rate(b.executionSuccess, b.tasks)),
      verificationPassRate: delta(rate(a.verificationPass, a.verificationChecked), rate(b.verificationPass, b.verificationChecked)),
    },
    paired,
  };
}

/**
 * Deterministic synthetic history, for checking the measuring code. Every record is marked (agent and model
 * start with "synthetic") so a report built from it always says it is not real usage.
 */
export function syntheticHistory(seed: number, tasks: number): RunRecord[] {
  let s = seed >>> 0 || 1;
  const next = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out: RunRecord[] = [];
  for (let i = 0; i < tasks; i += 1) {
    const multi = i % 2 === 1;
    const groupId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const calls = multi ? 2 : 1;
    const t0 = Date.UTC(2026, 0, 1, 0, 0, 0) + i * 60_000;
    for (let c = 0; c < calls; c += 1) {
      const agent = c === 0 ? 'synthetic-a' : 'synthetic-b';
      const result = {
        taskId: `${groupId}-${c}`,
        agent,
        status: next() < 0.9 ? ('success' as const) : ('failed' as const),
        output: 'synthetic',
        model: 'synthetic',
        errorKind: null,
        errorMessage: null,
        errorSignature: null,
        usage: { inputTokens: 100 + Math.floor(next() * 400), outputTokens: 50 + Math.floor(next() * 200) },
        costUsd: Math.round(next() * 1000) / 100000,
        startedAt: new Date(t0).toISOString(),
        durationMs: 1000 + Math.floor(next() * 4000),
      };
      out.push({ recordedAt: new Date(t0 + c).toISOString(), role: c === 0 ? 'task' : 'review', groupId, mode: multi ? 'L2' : 'L0', kind: 'code', prompt: `synthetic request ${Math.floor(i / 2)}`, result });
    }
    const last = out[out.length - 1];
    out.push({ ...last, role: 'summary', notes: [] });
  }
  return out;
}
