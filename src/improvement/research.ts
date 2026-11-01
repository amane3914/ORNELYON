import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeConfig, saveConfig, type AgentKey, type ChimeraConfig } from '../core/config.js';
import type { RunRecord } from '../core/history.js';
import { dataDir } from '../core/paths.js';
import type { AgentAdapter, SandboxMode, TaskRequest } from '../core/types.js';
import { budgetState } from '../optimization/cost.js';

/**
 * EXPERIMENTAL. Research mode: try a few prompt prefixes on one task, score each against a
 * pattern, and keep a candidate only when it beats the unchanged baseline.
 *
 * Nothing here changes the configuration. A candidate sits in data/research as `pending`
 * until the user runs `research apply <id> --yes`. Only whitelisted fields can change.
 * Sandbox, loop guard, budgets, tools and keys are never part of a candidate.
 */

/** The only config field a candidate may change. Anything else is refused on apply. */
export const APPLY_WHITELIST = ['promptPrefix'] as const;
export type ApplyField = (typeof APPLY_WHITELIST)[number];

export const DEFAULT_VARIANTS = [
  '',
  'Answer concisely. Do not add commentary.',
  'Think briefly, then reply with only the final answer.',
];
const MAX_VARIANTS = 6;
const MAX_SAMPLES = 3;

export interface VariantScore {
  variant: string;
  passes: number;
  samples: number;
  mean: number;
}

export interface Candidate {
  id: string;
  createdAt: string;
  status: 'pending' | 'applied' | 'rejected';
  agent: AgentKey;
  task: string;
  expect: string;
  samples: number;
  /** `low` when fewer than three samples were used per variant. */
  evidence: 'low' | 'ok';
  baseline: VariantScore;
  scores: VariantScore[];
  change: { agent: AgentKey; field: ApplyField; value: string };
  decidedAt: string | null;
}

export interface ResearchInput {
  config: ChimeraConfig;
  agent: AgentKey;
  adapter: AgentAdapter;
  task: string;
  expect: string;
  samples: number;
  variants?: string[];
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  log: (line: string) => void;
  records: () => RunRecord[];
  record: (record: RunRecord) => void;
  secrets?: string[];
}

export interface ResearchOutcome {
  improved: boolean;
  candidate: Candidate | null;
  scores: VariantScore[];
  reason: string;
}

export function researchDir(): string {
  return join(dataDir(), 'research');
}

function candidatePath(id: string): string {
  return join(researchDir(), `${id}.json`);
}

function saveCandidate(candidate: Candidate): void {
  mkdirSync(researchDir(), { recursive: true });
  writeFileSync(candidatePath(candidate.id), `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
}

export function loadCandidate(id: string): Candidate {
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    throw new Error('Candidate id must be a UUID.');
  }
  const file = candidatePath(id);
  if (!existsSync(file)) {
    throw new Error(`No candidate with id ${id}.`);
  }
  return JSON.parse(readFileSync(file, 'utf8')) as Candidate;
}

export function listCandidates(): Candidate[] {
  if (!existsSync(researchDir())) {
    return [];
  }
  const out: Candidate[] = [];
  for (const f of readdirSync(researchDir())) {
    if (!f.endsWith('.json')) {
      continue;
    }
    try {
      out.push(JSON.parse(readFileSync(join(researchDir(), f), 'utf8')) as Candidate);
    } catch {
      // A damaged candidate file is skipped and left on disk for inspection.
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Run the experiment. Saves a candidate only if the best variant beats the baseline. */
export async function runResearch(input: ResearchInput): Promise<ResearchOutcome> {
  if (input.config.preset !== 'research') {
    throw new Error('Research runs only with the Research preset. Change the preset in Setup first.');
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(input.expect, 'm');
  } catch {
    throw new Error('--expect must be a valid regular expression.');
  }
  if (!Number.isInteger(input.samples) || input.samples < 1 || input.samples > MAX_SAMPLES) {
    throw new Error(`samples must be 1 to ${MAX_SAMPLES}.`);
  }
  const settings = input.config.agents[input.agent];
  // A disabled agent is never started, here or anywhere else.
  if (!settings.enabled) {
    throw new Error(`Agent "${input.agent}" is disabled. Enable it in Setup before using it for Research.`);
  }
  const variants = (input.variants ?? DEFAULT_VARIANTS).slice(0, MAX_VARIANTS);
  // maxCalls means the same here as in a normal task: the most agent calls one user request may make. Research
  // makes one call per variant per sample, so a plan that would need more is refused before anything starts.
  const maxCalls = input.config.multiAi.maxCalls;
  const planned = variants.length * input.samples;
  if (planned > maxCalls) {
    throw new Error(`This Research run needs ${planned} agent calls (${variants.length} variants x ${input.samples} samples) but maxCalls is ${maxCalls}. Lower --samples or raise maxCalls in Setup.`);
  }
  const id = randomUUID();
  let calls = 0;
  const sandbox: SandboxMode = 'read-only';
  const scores: VariantScore[] = [];
  let stopReason: string | null = null;

  for (const variant of variants) {
    let passes = 0;
    let samplesDone = 0;
    for (let s = 0; s < input.samples; s += 1) {
      if (input.signal.aborted) {
        stopReason = 'Cancelled.';
        break;
      }
      if (calls >= maxCalls) {
        stopReason = `Call limit reached (maxCalls=${maxCalls}).`;
        break;
      }
      const budget = budgetState(input.records(), input.agent, settings.budgetUsd, new Date(Date.now() - 24 * 3600_000).toISOString());
      if (budget.state === 'exceeded') {
        stopReason = `Daily budget reached for ${input.agent}.`;
        break;
      }
      const prompt = variant ? `${variant}\n\n${input.task}` : input.task;
      const request: TaskRequest = {
        id: randomUUID(),
        prompt,
        cwd: input.cwd,
        agent: input.agent,
        timeoutMs: Math.min(settings.timeoutSec * 1000, input.timeoutMs),
        sandbox,
      };
      calls += 1;
      const result = await input.adapter.run(request, { signal: input.signal, log: input.log });
      input.record({
        recordedAt: new Date().toISOString(),
        role: 'task',
        groupId: id,
        mode: 'L0',
        kind: 'research',
        prompt,
        result,
        origin: input.adapter.provenance,
      });
      samplesDone += 1;
      if (result.status === 'success' && pattern.test(result.output)) {
        passes += 1;
      }
    }
    if (samplesDone > 0) {
      scores.push({ variant, passes, samples: samplesDone, mean: passes / samplesDone });
    }
    if (stopReason !== null) {
      break;
    }
  }

  if (scores.length === 0) {
    return { improved: false, candidate: null, scores, reason: stopReason ?? 'No baseline result.' };
  }
  const baseline = scores[0];
  let best = scores[0];
  for (const s of scores) {
    if (s.mean > best.mean) {
      best = s;
    }
  }
  const improved = best !== baseline && best.mean > baseline.mean;
  if (!improved) {
    return { improved: false, candidate: null, scores, reason: stopReason ?? 'No variant beat the baseline. Nothing saved.' };
  }
  const candidate: Candidate = {
    id,
    createdAt: new Date().toISOString(),
    status: 'pending',
    agent: input.agent,
    task: input.task,
    expect: input.expect,
    samples: input.samples,
    evidence: input.samples >= MAX_SAMPLES ? 'ok' : 'low',
    baseline,
    scores,
    change: { agent: input.agent, field: 'promptPrefix', value: best.variant },
    decidedAt: null,
  };
  saveCandidate(candidate);
  return { improved: true, candidate, scores, reason: stopReason ?? 'A variant beat the baseline. Saved as pending.' };
}

/** Apply a pending candidate. Refuses non-whitelisted fields and already decided candidates. */
export function applyCandidate(config: ChimeraConfig, id: string, saveTo?: string): ChimeraConfig {
  const candidate = loadCandidate(id);
  if (candidate.status !== 'pending') {
    throw new Error(`Candidate ${id} is already ${candidate.status}.`);
  }
  const { change } = candidate;
  if (!(APPLY_WHITELIST as readonly string[]).includes(change.field)) {
    throw new Error(`Field "${String(change.field)}" is not allowed for Research changes.`);
  }
  if (!(['codex', 'claude', 'local'] as string[]).includes(change.agent)) {
    throw new Error(`Unknown agent "${String(change.agent)}" in candidate.`);
  }
  const next = structuredClone(config);
  next.agents[change.agent].promptPrefix = change.value;
  const { config: normalized, warnings } = normalizeConfig(next);
  if (warnings.length > 0) {
    throw new Error(`Refused: ${warnings.join('; ')}`);
  }
  saveConfig(normalized, saveTo);
  saveCandidate({ ...candidate, status: 'applied', decidedAt: new Date().toISOString() });
  return normalized;
}

export function rejectCandidate(id: string): void {
  const candidate = loadCandidate(id);
  if (candidate.status !== 'pending') {
    throw new Error(`Candidate ${id} is already ${candidate.status}.`);
  }
  saveCandidate({ ...candidate, status: 'rejected', decidedAt: new Date().toISOString() });
}
