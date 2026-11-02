import { createHash } from 'node:crypto';
import { mkdirSync, accessSync, constants } from 'node:fs';
import { arch, release, platform } from 'node:os';

import type { AgentKey, ChimeraConfig } from '../core/config.js';
import { appendRecord, readRecords, type HandoffMeta, type RunRecord } from '../core/history.js';
import { historyPath, resolveWorkspacePath } from '../core/paths.js';
import { envSecrets, redact } from '../core/redact.js';
import type { DetectionResult } from '../core/types.js';
import { decideAcceptance, initialEvidence, latestEvidence, type AcceptAction, type ChangedFile, type Evidence, type VerificationCheck } from '../core/evidence.js';
import { isEmptySpec, runCommandChecks, runStateChecks, scopeCheck, type VerificationSpec } from '../core/verify.js';
import { workspaceIdFor } from '../core/workspace-id.js';
import { diffSnapshots, hashWorkspaceFile, snapshotGaps, snapshotWorkspace, type Snapshot } from '../core/workspace.js';
import {
  buildHandoffContext,
  buildPassport,
  gitHead,
  handoffChain,
  type HandoffChain,
  type HandoffContext,
  HANDOFF_TAG,
  INSTRUCTION_MAX,
  loadPassport,
  passportDrift,
  savePassport,
  type TaskPassport,
} from '../core/passport.js';
import { buildAdapters, createAdapter } from '../agents/registry.js';
import type { AgentAdapter } from '../core/types.js';
import { orchestrate, parseVerdict, type OrchestrateOutput } from '../orchestrator/orchestrator.js';
import { budgetState, summarizeCosts } from '../optimization/cost.js';
import { planDispatch } from '../orchestrator/orchestrator.js';
import type { DispatchDecision } from '../orchestrator/dispatch.js';

export interface SystemInfo {
  platform: string;
  osLabel: string;
  osRelease: string;
  arch: string;
  nodeVersion: string;
}

export function systemInfo(): SystemInfo {
  const p = platform();
  const osLabel = p === 'win32' ? 'Windows' : p === 'darwin' ? 'macOS' : p === 'linux' ? 'Linux' : p;
  return { platform: p, osLabel, osRelease: release(), arch: arch(), nodeVersion: process.version };
}

const DETECTION_TTL_MS = 60_000;
let detectionCache: { at: number; value: Record<AgentKey, DetectionResult> } | null = null;

/** Detect all agents. Results are cached for one minute so the GUI does not spawn processes on every poll. */
export async function detectAgents(config: ChimeraConfig, force = false): Promise<Record<AgentKey, DetectionResult>> {
  if (!force && detectionCache && Date.now() - detectionCache.at < DETECTION_TTL_MS) {
    return detectionCache.value;
  }
  const keys: AgentKey[] = ['codex', 'claude', 'local'];
  const entries = await Promise.all(keys.map(async (k) => [k, await createAdapter(config, k).detect()] as const));
  const value = Object.fromEntries(entries) as Record<AgentKey, DetectionResult>;
  detectionCache = { at: Date.now(), value };
  return value;
}

export function clearDetectionCache(): void {
  detectionCache = null;
}

/** Whether each agent can take a task now. Shared by the CLI and the GUI so they never disagree. */
export function availabilityFrom(det: Record<AgentKey, DetectionResult>): Record<AgentKey, boolean> {
  return {
    codex: det.codex.installed && det.codex.authenticated !== false,
    claude: det.claude.installed && det.claude.authenticated !== false,
    local: det.local.installed,
  };
}

export type CheckStatus = 'ok' | 'warn' | 'error';

export interface SetupCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix: string | null;
}

const INSTALL_HINT: Record<AgentKey, string> = {
  codex: 'Install the official Codex CLI (npm package @openai/codex) following OpenAI\'s instructions, then run `codex login`.',
  claude: 'Install Claude Code following Anthropic\'s official instructions, then run `claude auth login`.',
  local: 'Start your OpenAI-compatible local server and confirm the base URL in Agent settings.',
};

/** Check dependencies, sign-in state and the feature combination. Errors block setup completion. */
export function runSetupChecks(config: ChimeraConfig, det: Record<AgentKey, DetectionResult>): SetupCheck[] {
  const checks: SetupCheck[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    id: 'node',
    label: 'Node.js 20 or newer',
    status: major >= 20 ? 'ok' : 'error',
    detail: process.version,
    fix: major >= 20 ? null : 'Install Node.js 20 LTS from nodejs.org, then start ORNELYON again.',
  });

  let workspaceOk = true;
  try {
    mkdirSync(config.workspaceRoot, { recursive: true });
    accessSync(config.workspaceRoot, constants.W_OK);
  } catch {
    workspaceOk = false;
  }
  checks.push({
    id: 'workspace',
    label: 'Workspace folder is writable',
    status: workspaceOk ? 'ok' : 'error',
    detail: config.workspaceRoot,
    fix: workspaceOk ? null : 'Choose a folder you can write to.',
  });

  const main = config.multiAi.mainAgent;
  const mainDet = det[main];
  checks.push({
    id: 'main-installed',
    label: `Main agent installed (${main})`,
    status: mainDet.installed ? 'ok' : 'error',
    detail: mainDet.installed ? `${mainDet.version ?? 'version unknown'}` : mainDet.authNote,
    fix: mainDet.installed ? null : INSTALL_HINT[main],
  });
  if (mainDet.installed) {
    const authOk = mainDet.authenticated !== false;
    checks.push({
      id: 'main-auth',
      label: `Main agent signed in (${main})`,
      status: authOk ? 'ok' : main === 'local' ? 'warn' : 'error',
      detail: mainDet.authNote,
      fix: authOk ? null : INSTALL_HINT[main],
    });
  }
  checks.push({
    id: 'main-enabled',
    label: 'Main agent is enabled',
    status: config.agents[main].enabled ? 'ok' : 'error',
    detail: config.agents[main].enabled ? 'enabled' : 'The main agent is disabled.',
    fix: config.agents[main].enabled ? null : 'Enable the main agent in Agent settings.',
  });

  if (config.multiAi.enabled) {
    const enabled = (Object.keys(config.agents) as AgentKey[]).filter((k) => config.agents[k].enabled);
    const mode = config.multiAi.mode;
    if (mode === 'review' && enabled.length < 2) {
      checks.push({
        id: 'multi-count',
        label: 'Mutual review needs two agents',
        status: 'error',
        detail: `Only ${enabled.length} agent enabled.`,
        fix: 'Enable a second agent, or switch to manual mode.',
      });
    } else if (enabled.length < 2) {
      checks.push({
        id: 'multi-count',
        label: 'Multi-AI has one agent enabled',
        status: 'warn',
        detail: 'Multi-AI is on but only one agent is enabled.',
        fix: 'Enable another agent to use switching or routing.',
      });
    } else {
      checks.push({ id: 'multi-count', label: 'Multiple agents enabled', status: 'ok', detail: enabled.join(', '), fix: null });
    }
    if (mode === 'auto') {
      const missing = enabled.filter((k) => config.agents[k].capabilities.length === 0);
      checks.push({
        id: 'routing-rules',
        label: 'Routing rules declared',
        status: missing.length === 0 ? 'ok' : 'error',
        detail: missing.length === 0 ? 'Every enabled agent declares capabilities.' : `No capabilities for: ${missing.join(', ')}`,
        fix: missing.length === 0 ? null : 'Add at least one capability label to each enabled agent.',
      });
    }
  }

  if (config.agents.local.enabled) {
    const localDet = det.local;
    checks.push({
      id: 'local-reachable',
      label: 'Local LLM server reachable',
      status: localDet.installed ? 'ok' : 'warn',
      detail: localDet.authNote,
      fix: localDet.installed ? null : INSTALL_HINT.local,
    });
  }
  return checks;
}

export function setupCanComplete(checks: SetupCheck[]): boolean {
  return checks.every((c) => c.status !== 'error');
}

export interface VerifyInput {
  files: { path: string; sha256: string | null }[];
  jsonFiles: string[];
  commands: string[];
}

export interface TaskParams {
  prompt: string;
  kind: string | null;
  cwd: string | undefined;
  agent: AgentKey | undefined;
  sandbox: ChimeraConfig['defaultSandbox'];
  timeoutSec: number | undefined;
  /** Workspace-relative files or folders the run may change. Checked after the run. */
  allowedFiles?: string[] | null;
  /** Ask another enabled agent to review the answer. The review is recorded as a check. */
  reviewRequested?: boolean;
  /** Checks run after the run finishes. Commands must be registered in the trusted config. */
  verify?: VerifyInput;
  /** Run only `agent`, with no routing or fallback. Set by handoff. */
  pinAgent?: boolean;
  /** The task this one was handed off from. Recorded so the handoff depth can be counted. */
  handoffFrom?: string | null;
  /** What ORNELYON built for the handoff (instruction, hash of the context). Stored on the summary record. */
  handoff?: HandoffMeta;
}

export type TaskOutcome = OrchestrateOutput & { groupId: string; evidence: Evidence };

export interface TaskHandle {
  groupId: string;
  done: Promise<TaskOutcome>;
}

/** Fingerprint of the allowed files at the time of a review. A change to any of them forces a new review. */
export function allowedFingerprint(root: string, allowed: string[] | null): string {
  if (allowed === null) {
    return '';
  }
  const parts = [...allowed].sort().map((p) => `${p}=${hashWorkspaceFile(root, p) ?? 'absent'}`);
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/** Turn the reviewer's verdict into one check. "Reviewer said OK" is recorded, not treated as proof. */
export function reviewCheck(out: OrchestrateOutput, requested: boolean): VerificationCheck[] {
  if (out.review) {
    const r = out.review;
    if (r.status !== 'success') {
      return [{ name: `review by ${r.agent}`, kind: 'review', result: 'UNVERIFIED', detail: `the reviewer did not finish (${r.status})` }];
    }
    const verdict = parseVerdict(r.output);
    if (verdict === 'OK') {
      return [{ name: `review by ${r.agent}`, kind: 'review', result: 'PASS', detail: 'reviewer returned VERDICT: OK' }];
    }
    if (verdict === 'ISSUES') {
      return [{ name: `review by ${r.agent}`, kind: 'review', result: 'FAIL', detail: 'reviewer returned VERDICT: ISSUES' }];
    }
    return [{ name: `review by ${r.agent}`, kind: 'review', result: 'UNVERIFIED', detail: 'the reviewer output had no verdict line' }];
  }
  if (requested) {
    return [{ name: 'independent review', kind: 'review', result: 'UNVERIFIED', detail: 'requested, but no other enabled agent could review it' }];
  }
  return [];
}

/**
 * Start one user task. The caller owns `signal` and can cancel with it.
 * Each agent call is written to history as it finishes. The task's evidence is recorded
 * once the run is finished and its checks have been made.
 */
export function startTask(
  config: ChimeraConfig,
  params: TaskParams,
  groupId: string,
  signal: AbortSignal,
  log: (line: string) => void,
  available: Record<AgentKey, boolean>,
  injected?: Map<string, AgentAdapter>,
): TaskHandle {
  const root = config.workspaceRoot;
  const cwd = resolveWorkspacePath(root, params.cwd);
  const secrets = envSecrets([config.agents.local.apiKeyEnv ?? ''].filter((n) => n !== ''));
  // `injected` lets tests supply fake adapters. The CLI and GUI never pass it.
  const adapters = injected ?? buildAdapters(config, params.agent);
  const timeoutMs = (params.timeoutSec ?? 600) * 1000;
  const allowedFiles = params.allowedFiles ?? null;
  const reviewRequested = params.reviewRequested ?? false;
  // Snapshot the whole workspace (an agent can write outside its working folder) whenever files can change or a scope rule
  // is set. A read-only setting is not trusted as proof that nothing changed. Without either, the cost of hashing is skipped.
  const measure = params.sandbox === 'workspace-write' || allowedFiles !== null;
  const before = measure ? snapshotWorkspace(root) : null;
  const done = orchestrate(
    config,
    {
      groupId,
      prompt: params.prompt,
      kind: params.kind,
      cwd,
      sandbox: params.sandbox,
      timeoutMs,
      agent: params.agent,
      allowedFiles,
      reviewRequested,
      pinAgent: params.pinAgent ?? false,
      signal,
      log: (line) => log(redact(line, secrets)),
    },
    {
      adapters,
      available: new Map(Object.entries(available)),
      records: () => readRecords().records,
      record: (record) => appendRecord(record, historyPath(), secrets),
      secrets,
      fingerprint: () => allowedFingerprint(root, allowedFiles),
    },
  ).then(async (out) => {
    const verify = params.verify ?? { files: [], jsonFiles: [], commands: [] };
    const spec: VerificationSpec = { files: verify.files, jsonFiles: verify.jsonFiles, commands: verify.commands, allowedFiles };
    // Order (F8). The baseline was taken before the agent ran. Every command runs once and is waited for. Only then is the
    // final snapshot taken, and the scope rule compares it with the baseline. The file, hash and JSON checks come last and
    // read the same final state, so no result can be older than a write a command made. A failed snapshot is never a PASS.
    let commandChecks: VerificationCheck[];
    try {
      commandChecks = await runCommandChecks(spec, {
        root,
        sandbox: params.sandbox,
        commandsEnabled: config.verification.allowCommands,
        trusted: config.verification.commands,
      });
    } catch {
      commandChecks = [{ name: 'verification', kind: 'command', result: 'UNVERIFIED', detail: 'a verification command raised an error; file changes were still measured' }];
    }
    let after: Snapshot | null = null;
    let changedFiles: ChangedFile[] = [];
    let gaps: string[] | null = null;
    let snapshotFailed = false;
    if (before) {
      try {
        after = snapshotWorkspace(root);
        changedFiles = diffSnapshots(before, after);
        gaps = snapshotGaps(before, after);
      } catch {
        after = null;
        snapshotFailed = true;
        changedFiles = [];
        gaps = ['the final workspace snapshot could not be taken'];
      }
    }
    const stateChecks = runStateChecks(spec, { root, snapshot: after, snapshotFailed });
    const checks: VerificationCheck[] = [
      ...stateChecks,
      ...commandChecks,
      ...scopeCheck(spec, { changed: changedFiles, snapshotGaps: gaps }),
      ...reviewCheck(out, reviewRequested),
    ];
    const evidence = initialEvidence({
      status: out.final.status,
      sandbox: params.sandbox,
      verificationRequired: reviewRequested || !isEmptySpec(spec),
      checks,
      changedFiles,
    });
    // One summary line per user task: final result, notes, and the evidence for this task.
    appendRecord(
      {
        recordedAt: new Date().toISOString(),
        role: 'summary',
        groupId,
        ...workspaceField(root),
        mode: out.level,
        kind: params.kind,
        prompt: params.prompt,
        result: out.final,
        notes: params.handoffFrom ? [...out.notes, `${HANDOFF_TAG}${params.handoffFrom}`] : out.notes,
        evidence,
        ...(params.handoff ? { handoff: params.handoff } : {}),
      },
      historyPath(),
      secrets,
    );
    return { ...out, groupId, evidence };
  });
  return { groupId, done };
}

/**
 * Record a user's accept or reject decision. Only this path sets ACCEPTED or REJECTED.
 * Tasks run before v0.2 have no evidence. They are treated as sandbox-unknown, so they stay PENDING.
 */
export function decideTask(
  groupId: string,
  action: AcceptAction,
  reason: string,
  override: boolean,
): { ok: true; evidence: Evidence } | { ok: false; error: string } {
  const records = readRecords().records;
  const summary = [...records].reverse().find((r) => r.groupId === groupId && r.role === 'summary');
  if (!summary) {
    return { ok: false, error: 'No such task.' };
  }
  const current =
    latestEvidence(records, groupId) ??
    initialEvidence({ status: summary.result.status, sandbox: 'workspace-write', verificationRequired: false, checks: [], changedFiles: [] });
  const outcome = decideAcceptance(current, action, { reason, override });
  if (!outcome.ok) {
    return outcome;
  }
  appendRecord(
    {
      recordedAt: new Date().toISOString(),
      role: 'decision',
      groupId,
      mode: summary.mode,
      kind: summary.kind,
      prompt: '',
      result: summary.result,
      evidence: outcome.evidence,
      notes: [`user ${action}${outcome.evidence.overrideUsed ? ' (override)' : ''}: ${reason}`],
    },
    historyPath(),
  );
  return { ok: true, evidence: outcome.evidence };
}

/**
 * The current evidence for a task, read from history. Tasks run before v0.2 are shown as
 * UNVERIFIED or NOT_RUN with no checks, and stay PENDING, so a user can still decide on them.
 */
export function evidenceFor(groupId: string): { summary: RunRecord; evidence: Evidence; recorded: boolean } | null {
  const records = readRecords().records;
  const summary = [...records].reverse().find((r) => r.groupId === groupId && r.role === 'summary');
  if (!summary) {
    return null;
  }
  const recorded = latestEvidence(records, groupId);
  // Without a recorded Evidence Gate result the states are derived from the run status alone. `recorded` says so.
  const evidence = recorded ?? initialEvidence({ status: summary.result.status, sandbox: 'workspace-write', verificationRequired: false, checks: [], changedFiles: [] });
  return { summary, evidence, recorded: recorded !== null };
}

/** Build and save the passport for a task group from its history. */
export async function savePassportFor(config: ChimeraConfig, groupId: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const gitCommit = await gitHead(config.workspaceRoot);
  const passport = buildPassport(groupId, readRecords().records, gitCommit, undefined, config.workspaceRoot);
  if (!passport) {
    return { ok: false, error: 'No such task.' };
  }
  return { ok: true, path: savePassport(passport) };
}

/**
 * Manual handoff: start a new task on another agent from a saved passport. It runs only when the
 * user asks for it. Files changed since the passport was saved block the handoff unless accepted.
 */
/**
 * Every reason a handoff must not start, checked before any agent process exists. Returns null when
 * the handoff may start. Pure: it reads the passport, configuration, history and availability only.
 */
export function handoffRefusal(
  config: ChimeraConfig,
  passport: TaskPassport,
  to: AgentKey,
  records: RunRecord[],
  available: Record<AgentKey, boolean>,
  acceptCurrentState: boolean,
  now: number = Date.now(),
): string | null {
  const settings = config.agents[to];
  if (!settings.enabled) {
    return `Target agent ${to} is disabled in agent settings.`;
  }
  if (available[to] !== true) {
    return `Target agent ${to} is not available: it was not installed or not signed in at the last check.`;
  }
  if (passport.kind && !settings.capabilities.includes(passport.kind)) {
    return `Target agent ${to} does not declare the capability "${passport.kind}" this task needs.`;
  }
  // Sequential handoffs are limited by maxHandoffs, counted from history. maxDepth limits nested
  // calls and is not involved here. A count that cannot be proven is refused, never taken as zero.
  const chain = handoffChain(records, passport.groupId);
  if (!chain.verified) {
    return `Handoff refused: the handoff count cannot be verified because ${chain.reason}.`;
  }
  if (chain.count + 1 > config.multiAi.maxHandoffs) {
    return `Handoff limit reached: this would be handoff ${chain.count + 1} in the chain, and maxHandoffs=${config.multiAi.maxHandoffs}.`;
  }
  const since = new Date(now - 24 * 3600_000).toISOString();
  const budget = budgetState(records, to, settings.budgetUsd, since);
  if (budget.state === 'exceeded') {
    return `Daily budget reached for ${to} ($${budget.spentUsd.toFixed(4)} of $${budget.limitUsd}).`;
  }
  const drift = passportDrift(passport, config.workspaceRoot);
  if (drift.length > 0 && !acceptCurrentState) {
    return `Workspace changed since the passport was saved: ${drift.map((d) => d.path).join(', ')}. Add accept-current-state to continue anyway.`;
  }
  return null;
}

export interface HandoffOverview {
  chain: HandoffChain;
  maxHandoffs: number;
  /** Per target agent: null when a handoff may start, otherwise the reason it would be refused. */
  targets: Record<AgentKey, { allowed: boolean; refusal: string | null }>;
}

/** What a handoff of this passport would do, without starting anything. Uses the same checks as handoffTask. */
export function handoffOverview(
  config: ChimeraConfig,
  passport: TaskPassport,
  records: RunRecord[],
  available: Record<AgentKey, boolean>,
  acceptCurrentState = false,
): HandoffOverview {
  const targets = {} as HandoffOverview['targets'];
  for (const to of ['codex', 'claude', 'local'] as AgentKey[]) {
    const refusal = handoffRefusal(config, passport, to, records, available, acceptCurrentState);
    targets[to] = { allowed: refusal === null, refusal };
  }
  return { chain: handoffChain(records, passport.groupId), maxHandoffs: config.multiAi.maxHandoffs, targets };
}

/**
 * Manual handoff: start a new task on the named agent from a saved passport. It runs only when the
 * user asks for it. Every refusal happens before an agent is started.
 */
export interface HandoffInput {
  fromGroupId: string;
  to: AgentKey;
  acceptCurrentState: boolean;
  timeoutSec: number | undefined;
  /** The user's instruction for the next agent. Text only: it cannot change permissions, budget or limits. */
  instruction?: string | null;
}

/**
 * Every check a handoff needs, then the exact context to send. Starts nothing, so the CLI, the API and
 * the GUI show the same preview and `handoffTask` sends exactly this text.
 */
export function prepareHandoff(
  config: ChimeraConfig,
  input: HandoffInput,
  available: Record<AgentKey, boolean>,
): { ok: true; passport: TaskPassport; context: HandoffContext } | { ok: false; error: string } {
  if (!/^[0-9a-f-]{36}$/.test(input.fromGroupId)) {
    return { ok: false, error: 'Passport refused: invalid task id.' };
  }
  if (typeof input.instruction === 'string' && input.instruction.length > INSTRUCTION_MAX) {
    return { ok: false, error: `Instruction refused: it is longer than ${INSTRUCTION_MAX} characters.` };
  }
  const loaded = loadPassport(input.fromGroupId);
  if (!loaded.passport) {
    return { ok: false, error: `Passport refused: ${loaded.check.errors.join('; ')}` };
  }
  const passport = loaded.passport;
  const records = readRecords().records;
  const refusal = handoffRefusal(config, passport, input.to, records, available, input.acceptCurrentState);
  if (refusal !== null) {
    return { ok: false, error: refusal };
  }
  const built = buildHandoffContext({
    passport,
    records,
    root: config.workspaceRoot,
    target: input.to,
    instruction: input.instruction ?? null,
    maxChars: config.multiAi.handoffContextMaxChars,
  });
  return built.ok ? { ok: true, passport, context: built.context } : built;
}

export function handoffTask(
  config: ChimeraConfig,
  input: HandoffInput,
  groupId: string,
  signal: AbortSignal,
  log: (line: string) => void,
  available: Record<AgentKey, boolean>,
  injected?: Map<string, AgentAdapter>,
): { ok: true; handle: TaskHandle; context: HandoffContext } | { ok: false; error: string } {
  const prepared = prepareHandoff(config, input, available);
  if (!prepared.ok) {
    return prepared;
  }
  const { passport, context } = prepared;
  const prompt = context.text;
  const handle = startTask(
    config,
    {
      prompt,
      kind: passport.kind ?? null,
      cwd: undefined,
      agent: input.to,
      sandbox: 'read-only',
      timeoutSec: input.timeoutSec,
      pinAgent: true,
      handoffFrom: input.fromGroupId,
      handoff: context.meta,
    },
    groupId,
    signal,
    log,
    available,
    injected,
  );
  return { ok: true, handle, context };
}

export function costSummary(sinceHours: number | null): ReturnType<typeof summarizeCosts> {
  const since = sinceHours === null ? undefined : new Date(Date.now() - sinceHours * 3600_000).toISOString();
  return summarizeCosts(readRecords().records, since);
}

export const AGENT_KEYS: AgentKey[] = ['codex', 'claude', 'local'];

export interface DispatchPreview {
  started: false;
  mode: string;
  smartDispatchEnabled: boolean;
  criticalKinds: string[];
  selectedAgent: AgentKey;
  enabledByPriority: AgentKey[];
  extraCall: boolean;
  decision: DispatchDecision;
}

/**
 * Dry run of the dispatch rules: reads configuration only and starts no agent. Shared by the API, the CLI
 * and the MCP server so they cannot disagree. The caller validates `kind` and `agent` first.
 */
export function dispatchPreview(config: ChimeraConfig, input: { kind: string | null; agent?: AgentKey; reviewRequested: boolean }): DispatchPreview {
  const agent = input.agent ?? config.multiAi.mainAgent;
  const plan = planDispatch(config, { kind: input.kind, reviewRequested: input.reviewRequested, available: new Map(), main: agent });
  const order = AGENT_KEYS.filter((id) => config.agents[id].enabled).sort((a, b) => config.agents[a].priority - config.agents[b].priority);
  return {
    started: false,
    mode: config.multiAi.enabled ? config.multiAi.mode : 'single',
    smartDispatchEnabled: config.multiAi.smartDispatch.enabled,
    criticalKinds: config.multiAi.smartDispatch.criticalKinds,
    selectedAgent: agent,
    enabledByPriority: order,
    extraCall: plan.action === 'REQUIRE_INDEPENDENT_REVIEW' || plan.action === 'CALL_OTHER_PROVIDER',
    decision: plan,
  };
}

/** The folder label for a new summary record. A failure to make one leaves the field out, which reads as UNKNOWN. */
function workspaceField(root: string): { workspace?: string } {
  try {
    const id = workspaceIdFor(root, true);
    return id === null ? {} : { workspace: id };
  } catch {
    return {};
  }
}

export interface RecentTask {
  groupId: string;
  /** The stored folder label, if any. Callers turn it into SAME / OTHER / UNKNOWN; it is not shown to clients. */
  workspace: string | null;
  recordedAt: string;
  kind: string | null;
  agent: string;
  execution: Evidence['execution'];
  verification: Evidence['verification'];
  acceptance: Evidence['acceptance'];
}

/** Optional narrowing for `recentTasks`. Every given field must match. `allow` is how a caller applies its own scope before the limit. */
export interface RecentFilter {
  agent?: string;
  execution?: Evidence['execution'];
  verification?: Evidence['verification'];
  acceptance?: Evidence['acceptance'];
  taskId?: string;
  allow?: (groupId: string) => boolean;
}

/** The newest user tasks, newest first. No prompt or output text: only identifiers and states. */
export function recentTasks(records: RunRecord[], limit: number, filter: RecentFilter = {}): RecentTask[] {
  const out: RecentTask[] = [];
  const seen = new Set<string>();
  for (let i = records.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const r = records[i];
    if (r.role !== 'summary' || seen.has(r.groupId)) {
      continue;
    }
    seen.add(r.groupId);
    if ((filter.taskId !== undefined && r.groupId !== filter.taskId) || (filter.allow !== undefined && !filter.allow(r.groupId))) {
      continue;
    }
    const ev = latestEvidence(records, r.groupId) ?? r.evidence;
    if (!ev) {
      continue;
    }
    if (
      (filter.agent !== undefined && r.result.agent !== filter.agent) ||
      (filter.execution !== undefined && ev.execution !== filter.execution) ||
      (filter.verification !== undefined && ev.verification !== filter.verification) ||
      (filter.acceptance !== undefined && ev.acceptance !== filter.acceptance)
    ) {
      continue;
    }
    out.push({ groupId: r.groupId, workspace: r.workspace ?? null, recordedAt: r.recordedAt, kind: r.kind, agent: r.result.agent, execution: ev.execution, verification: ev.verification, acceptance: ev.acceptance });
  }
  return out;
}

export type ContinuationState = 'CLEAR' | 'CAUTION' | 'BLOCKED';

export interface ContinuationAssessment {
  state: ContinuationState;
  /** Why, in plain words. Empty only for CLEAR. */
  reasons: string[];
  /** The latest state in history, which can be newer than the saved passport. Null when history holds no Evidence Gate record. */
  historyState: { execution: Evidence['execution']; verification: Evidence['verification']; acceptance: Evidence['acceptance'] } | null;
  passportCurrent: boolean;
  openIssueCount: number;
  nextStepRecorded: boolean;
  /** Files the passport names whose content differs from the workspace now (paths only). */
  drift: { path: string; state: 'CHANGED' | 'MISSING_OR_UNREADABLE' }[];
}

/**
 * Can the saved data of a task be picked up again, and what should be looked at first? Read-only, from the
 * verified passport, the history and the current workspace files. It restores no session and starts nothing.
 * CLEAR means the saved data is complete and consistent. It is not an approval and not an instruction.
 */
export function continuationAssessment(config: ChimeraConfig, passport: TaskPassport, records: RunRecord[], historyComplete = true): ContinuationAssessment {
  const reasons: string[] = [];
  let blocked = false;
  if (!historyComplete) {
    reasons.push('Some history lines could not be read, so a newer state (for example a rejection) may be missing.');
  }
  const latest = latestEvidence(records, passport.groupId);
  const historyState = latest ? { execution: latest.execution, verification: latest.verification, acceptance: latest.acceptance } : null;
  const saved = passport.status;
  const passportCurrent = historyState === null || (historyState.execution === saved.execution && historyState.verification === saved.verification && historyState.acceptance === saved.acceptance);
  const now = historyState ?? saved;
  if (historyState === null) {
    reasons.push('No Evidence Gate record was found in history for this task; only the passport states are known.');
  } else if (!passportCurrent) {
    reasons.push('History shows a newer state than the saved passport. Save the passport again before relying on it.');
  }
  if (now.execution !== 'SUCCESS') {
    blocked = true;
    reasons.push(`Execution is ${now.execution}.`);
  }
  if (now.verification === 'FAIL') {
    blocked = true;
    reasons.push('Verification failed.');
  } else if (now.verification !== 'PASS') {
    reasons.push(`Verification is ${now.verification}; nothing is confirmed by ORNELYON's checks.`);
  }
  if (now.acceptance === 'REJECTED') {
    blocked = true;
    reasons.push('The user rejected this task.');
  } else if (now.acceptance === 'PENDING') {
    reasons.push('No user decision is recorded.');
  }
  const openIssueCount = passport.openIssues.length;
  if (openIssueCount > 0) {
    reasons.push(`${openIssueCount} open issue(s) are recorded.`);
  }
  const nextStepRecorded = passport.nextStep.trim() !== '';
  if (!nextStepRecorded) {
    reasons.push('No next step is recorded.');
  }
  if (passport.agentReport === undefined) {
    reasons.push('The agent report was not recorded (passport saved before v0.3.1).');
  }
  const drift = passportDrift(passport, config.workspaceRoot).map((d) => ({ path: d.path, state: (d.actual === null ? 'MISSING_OR_UNREADABLE' : 'CHANGED') as 'CHANGED' | 'MISSING_OR_UNREADABLE' }));
  if (drift.length > 0) {
    reasons.push(`${drift.length} file(s) named by the passport differ from the workspace now.`);
  }
  return { state: blocked ? 'BLOCKED' : reasons.length > 0 ? 'CAUTION' : 'CLEAR', reasons, historyState, passportCurrent, openIssueCount, nextStepRecorded, drift };
}
