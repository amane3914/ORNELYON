#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, type AgentKey, type ToolState } from '../core/config.js';
import { configPath, dataDir, packageRoot } from '../core/paths.js';
import { MCP_TOOL_NAMES, registrationHelp, serveStdio } from './mcp.js';
import { selfTest } from './mcp-selftest.js';
import { diagnoseMcp } from './doctor.js';
import { cmdBenchmark } from './cli-benchmark.js';
import { readRecords } from '../core/history.js';
import { setToolState, TOOL_STATES } from '../optimization/dormancy.js';
import { startServer, type RunningServer } from './server.js';
import { applyCandidate, listCandidates, loadCandidate, rejectCandidate, runResearch } from '../improvement/research.js';
import { createAdapter } from '../agents/registry.js';
import { describeAcceptance, type AcceptAction, type Evidence } from '../core/evidence.js';
import { handoffChain, loadPassport, type HandoffContext } from '../core/passport.js';
import { planDispatch } from '../orchestrator/orchestrator.js';
import type { VerifyInput } from './service.js';
import { appendRecord } from '../core/history.js';
import { historyPath, resolveWorkspacePath } from '../core/paths.js';
import {
  clearDetectionCache,
  costSummary,
  decideTask,
  evidenceFor,
  handoffTask,
  prepareHandoff,
  savePassportFor,
  availabilityFrom,
  detectAgents,
  recentTasks,
  runSetupChecks,
  setupCanComplete,
  startTask,
  systemInfo,
  type TaskHandle,
} from './service.js';

const USAGE = `ORNELYON

Usage:
  ornelyon gui [--port N]                 Start the local setup and dashboard (127.0.0.1 only)
  ornelyon doctor [--name <entry>]        Check runtime, agents, sign-in state, setup and the MCP / GUI registration (looks only)
  ornelyon run "<prompt>" [options]       Run one task. Prints the result and its evidence.
      --agent codex|claude|local          Agent to use (L1 manual mode, or the main agent)
      --kind <label>                      Task category for routing, e.g. code
      --cwd <subfolder>                   Working folder inside the workspace root
      --sandbox read-only|workspace-write Default: read-only
      --allow-write                       Required together with --sandbox workspace-write
      --allow-files <a,b>                 Files or folders the run may change (checked afterwards)
      --verify-file <path[:sha256]>       File must exist (and match sha256). Repeatable.
      --verify-json <path>                File must parse as JSON. Repeatable.
      --verify-command <name>             Run a command from the trusted config. Repeatable.
      --require-review                    Ask another enabled agent for an independent review
      --dry-run                           Show the dispatch plan and checks. Starts no agent.
      --timeout <seconds>                 Upper bound for this run
  ornelyon accept <task-id> --reason "…" [--override]
                                          Record that you accept the task. --override is needed when a required check failed or is missing.
  ornelyon reject <task-id> --reason "…"  Record that you reject the task.
  ornelyon verdict <task-id>              Show Execution, Verification and Acceptance with each check
  ornelyon passport save <task-id>        Save a Task Passport (state needed to continue elsewhere)
  ornelyon passport show <task-id>        Check and show a saved passport
  ornelyon handoff <task-id> --to <agent> [--instruction "<text>"] [--preview] [--accept-current-state] [--timeout N]
                                          Continue a saved task on another agent. Runs only when you ask.
                                          The next agent gets the previous report, checks and your instruction.
                                          --preview shows exactly what would be sent and starts nothing.
  ornelyon research run "<task>" --agent <id> --expect <regex> [--samples N] [--cwd sub]
                                          EXPERIMENTAL. Research preset only. Saves a pending candidate if a prompt variant beats the baseline.
  ornelyon research list                  List candidates
  ornelyon research show <id>             Show one candidate with its scores
  ornelyon research apply <id> --yes      Apply a pending candidate (only promptPrefix can change)
  ornelyon research reject <id>           Reject a pending candidate
  ornelyon history [--limit N]            Show recent runs with their Verification and Acceptance
  ornelyon cost [--hours N]               Show reported usage and cost (unknown is shown as unknown)
  ornelyon benchmark [--by agent|kind|shape] [--agent X] [--kind X] [--shape single|multi|handoff] [--hours N] [--json]
                                          Efficiency from history: tasks, calls, tokens, cost, time, success. Reads only; calls no agent.
  ornelyon benchmark compare --a "agent=claude,shape=single" --b "shape=multi" [--json]
                                          Compare two groups of tasks and say what differs. Keys: agent, kind, shape, hours.
      --history <file>                    Read another history file instead of yours (for example synthetic data)
  ornelyon benchmark synth --out <file> [--seed N] [--tasks N]
                                          Write deterministic SYNTHETIC history to test the measuring code. Not real usage.
  ornelyon mcp [--recent N | --allow-task <id> ... | --all-tasks] [--expose-content] [--tools a,b]
                                          Run the read-only MCP server on stdio (an MCP client starts it).
                                          Scope: no task is visible unless you choose: the N newest at start, named ids, or all.
                                          --expose-content adds text (objectives, reports) for the chosen tasks; not with --all-tasks.
  ornelyon mcp --print-config [same options]
                                          Print how to register it with Claude Code, Codex or other clients. Changes nothing.
  ornelyon mcp --self-test [same options]
                                          Start the server as a client would and speak MCP to it: PASS/FAIL. No GUI, no model call.
  ornelyon tool <name> <state>          Set a tool to ACTIVE, DORMANT, QUARANTINED or DISABLED
  ornelyon config path                    Print the config file location

\`chimera\` still works as an alias of \`ornelyon\`.
Data folder: ${dataDir()}
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/** Every value given for a repeatable flag, in order. */
function flagAll(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === name) {
      out.push(args[i + 1]);
    }
  }
  return out;
}

/** Flags that take no value. Every other `--flag` consumes the next argument. */
const BOOLEAN_FLAGS = new Set(['--allow-write', '--yes', '--require-review', '--dry-run', '--override', '--accept-current-state', '--preview', '--expose-content', '--print-config', '--json']);

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) {
      if (!BOOLEAN_FLAGS.has(args[i])) {
        i += 1;
      }
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

async function cmdDoctor(args: string[]): Promise<number> {
  const loaded = loadConfig();
  const det = await detectAgents(loaded.config, true);
  const checks = runSetupChecks(loaded.config, det);
  const sys = systemInfo();
  console.log(`System: ${sys.osLabel} ${sys.osRelease} (${sys.arch}), Node ${sys.nodeVersion}`);
  console.log(`Config: ${loaded.source}${loaded.warnings.length ? ` (${loaded.warnings.join('; ')})` : ''}`);
  for (const key of ['codex', 'claude', 'local'] as AgentKey[]) {
    const d = det[key];
    console.log(`  ${key}: installed=${d.installed} version=${d.version ?? 'unknown'} auth=${String(d.authenticated)} exe=${d.executable ?? '-'}`);
    console.log(`         ${d.authNote}`);
  }
  for (const c of checks) {
    const mark = c.status === 'ok' ? 'OK  ' : c.status === 'warn' ? 'WARN' : 'ERR ';
    console.log(`[${mark}] ${c.label}: ${c.detail}${c.fix ? `\n       fix: ${c.fix}` : ''}`);
  }
  console.log(setupCanComplete(checks) ? 'Setup can be completed.' : 'Setup has errors. Fix them in `ornelyon gui`.');
  // The GUI integration section only looks. Repairs are printed as commands for you to run; nothing is changed.
  const mcp = await diagnoseMcp(fileURLToPath(import.meta.url), loaded.config, ['ornelyon', ...flagAll(args, '--name')]);
  console.log('\nORNELYON MCP / GUI integration (diagnosis only, nothing is changed):');
  for (const i of mcp) {
    console.log(`[${i.status.padEnd(10)}] ${i.label}: ${i.detail}${i.fix ? `\n             fix: ${i.fix}` : ''}`);
  }
  const mcpFailed = mcp.some((i) => i.status === 'FAIL');
  console.log(mcpFailed ? 'MCP integration has FAIL items (see the fix lines).' : 'No MCP integration failure found. UNKNOWN and NOT_TESTED items were not verified.');
  return setupCanComplete(checks) && !mcpFailed ? 0 : 1;
}

/** Parse the verification flags. A `:sha256` suffix pins the exact content that was reviewed. */
function parseVerify(args: string[]): VerifyInput {
  const files = flagAll(args, '--verify-file').map((v) => {
    const m = v.match(/^(.*):([0-9a-f]{64})$/);
    return m ? { path: m[1], sha256: m[2] } : { path: v, sha256: null };
  });
  return { files, jsonFiles: flagAll(args, '--verify-json'), commands: flagAll(args, '--verify-command') };
}

function parseAllowedFiles(args: string[]): string[] | null {
  const raw = flag(args, '--allow-files');
  if (raw === undefined) {
    return null;
  }
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

function printEvidence(groupId: string, ev: Evidence): void {
  console.log(`Execution: ${ev.execution}   Verification: ${ev.verification}   Acceptance: ${ev.acceptance}`);
  for (const c of ev.checks) {
    console.log(`  [${c.result}] ${c.kind} ${c.name}: ${c.detail}`);
  }
  if (ev.changedFiles.length > 0) {
    console.log(`  changed files: ${ev.changedFiles.map((f) => f.path).join(', ')}`);
  }
  if (ev.acceptance === 'PENDING') {
    console.log(`Task id ${groupId}. Record a decision: ornelyon accept ${groupId} --reason "..."  or  ornelyon reject ${groupId} --reason "..."`);
  } else {
    console.log(`Task id ${groupId}. ${describeAcceptance(ev)}`);
  }
}

async function cmdRun(args: string[]): Promise<number> {
  const prompt = positional(args).join(' ').trim();
  if (prompt === '') {
    console.error('Give a prompt, e.g.  ornelyon run "Summarize README.md"');
    return 2;
  }
  const config = loadConfig().config;
  if (!config.setupCompleted) {
    console.error('Setup is not complete. Run `ornelyon gui` and finish the setup screen first.');
    return 2;
  }
  const agent = flag(args, '--agent') as AgentKey | undefined;
  if (agent !== undefined && !['codex', 'claude', 'local'].includes(agent)) {
    console.error('--agent must be codex, claude or local.');
    return 2;
  }
  const sandbox = (flag(args, '--sandbox') ?? config.defaultSandbox) as string;
  if (sandbox !== 'read-only' && sandbox !== 'workspace-write') {
    console.error('--sandbox must be read-only or workspace-write.');
    return 2;
  }
  if (sandbox === 'workspace-write' && !args.includes('--allow-write')) {
    console.error('workspace-write lets the agent change files. Add --allow-write to confirm this run.');
    return 2;
  }
  const kind = flag(args, '--kind') ?? null;
  const allowedFiles = parseAllowedFiles(args);
  const verify = parseVerify(args);
  const reviewRequested = args.includes('--require-review');

  if (args.includes('--dry-run')) {
    // Dry run reads configuration only. No agent is started and availability is not probed.
    const plan = planDispatch(config, { kind, reviewRequested, available: new Map(), main: agent ?? config.multiAi.mainAgent });
    console.log('Dry run. No agent was started, and agent availability was not checked.');
    console.log(`Mode: ${config.multiAi.enabled ? config.multiAi.mode : 'single agent (multi-AI off)'}`);
    console.log(`Smart Dispatch (if the run succeeds): ${plan.action}`);
    for (const r of plan.reasons) {
      console.log(`  - ${r}`);
    }
    console.log('Checks that would run afterwards:');
    console.log(`  files: ${verify.files.length}, json: ${verify.jsonFiles.length}, commands: ${verify.commands.length}` +
      (verify.commands.length > 0 && !config.verification.allowCommands ? ' (commands are disabled in config)' : ''));
    console.log(`  allowed files: ${allowedFiles === null ? 'no file rule' : allowedFiles.join(', ')}`);
    console.log(`  independent review requested: ${reviewRequested ? 'yes' : 'no'}`);
    return 0;
  }

  const timeoutRaw = flag(args, '--timeout');
  const det = await detectAgents(config, true);
  const available = availabilityFrom(det);

  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort();
  process.once('SIGINT', onInterrupt);
  let handle: TaskHandle;
  try {
    handle = startTask(
      config,
      {
        prompt,
        kind,
        cwd: flag(args, '--cwd'),
        agent,
        sandbox: sandbox as 'read-only' | 'workspace-write',
        timeoutSec: timeoutRaw === undefined ? undefined : Number(timeoutRaw),
        allowedFiles,
        reviewRequested,
        verify,
      },
      randomUUID(),
      controller.signal,
      (line) => console.error(`  ${line}`),
      available,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.removeListener('SIGINT', onInterrupt);
    return 2;
  }
  const out = await handle.done;
  process.removeListener('SIGINT', onInterrupt);
  for (const note of out.notes) {
    console.error(`note: ${note}`);
  }
  const f = out.final;
  console.log(`[${out.level}] ${f.agent}: ${f.status}${f.errorMessage ? ` — ${f.errorMessage}` : ''}`);
  if (f.output) {
    console.log(f.output);
  }
  if (out.review) {
    console.log(`\n--- review by ${out.review.agent} (${out.review.status}) ---`);
    console.log(out.review.output);
  }
  console.log('');
  printEvidence(out.groupId, out.evidence);
  // Exit codes: 0 finished and checks not failed, 1 did not finish, 3 a check failed.
  if (f.status !== 'success') {
    return 1;
  }
  return out.evidence.verification === 'FAIL' ? 3 : 0;
}

function cmdDecide(action: AcceptAction, args: string[]): number {
  const [groupId] = positional(args);
  if (!groupId) {
    console.error(`Usage: ornelyon ${action} <task-id> --reason "..."${action === 'accept' ? ' [--override]' : ''}`);
    return 2;
  }
  const result = decideTask(groupId, action, flag(args, '--reason') ?? '', args.includes('--override'));
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }
  console.log(`Task ${groupId}: ${describeAcceptance(result.evidence)}`);
  return 0;
}

function cmdVerdict(args: string[]): number {
  const [groupId] = positional(args);
  if (!groupId) {
    console.error('Usage: ornelyon verdict <task-id>');
    return 2;
  }
  const view = evidenceFor(groupId);
  if (!view) {
    console.error('No such task.');
    return 1;
  }
  printEvidence(groupId, view.evidence);
  return 0;
}

async function cmdPassport(args: string[]): Promise<number> {
  const [sub, groupId] = args;
  if (!groupId || (sub !== 'save' && sub !== 'show')) {
    console.error('Usage: ornelyon passport save|show <task-id>');
    return 2;
  }
  if (sub === 'save') {
    const saved = await savePassportFor(loadConfig().config, groupId);
    if (!saved.ok) {
      console.error(saved.error);
      return 1;
    }
    console.log(`Passport saved: ${saved.path}`);
    return 0;
  }
  const loaded = loadPassport(groupId);
  if (!loaded.passport) {
    console.error(`Passport refused: ${loaded.check.errors.join('; ')}`);
    return 1;
  }
  const p = loaded.passport;
  console.log(`Original objective: ${p.originalObjective === undefined ? 'not recorded (passport saved before v0.3.1)' : (p.originalObjective ?? 'unknown')}`);
  console.log(`Objective: ${p.objective}`);
  console.log(
    `Previous agent report: ${p.agentReport === undefined ? 'not recorded (passport saved before v0.3.1)' : p.agentReport === null ? 'none (the task produced no output text)' : `${p.agentReport.originalChars} characters, sha256 ${p.agentReport.sha256.slice(0, 12)}${p.agentReport.truncated ? ' (copy cut)' : ''}`}`,
  );
  console.log(`Status: execution ${p.status.execution}, verification ${p.status.verification}, acceptance ${p.status.acceptance}`);
  console.log(`Executing agent: ${p.executingAgent ?? 'unknown'}   Git commit: ${p.gitCommit ?? 'none'}`);
  console.log(`Changed files: ${p.changedFiles.map((f) => f.path).join(', ') || 'none'}`);
  console.log(`Open issues: ${p.openIssues.length > 0 ? p.openIssues.join(' | ') : 'none'}`);
  console.log(`Next step: ${p.nextStep}`);
  const chain = handoffChain(readRecords().records, groupId);
  console.log(
    chain.verified
      ? `Handoffs so far in this chain: ${chain.count} (limit ${loadConfig().config.multiAi.maxHandoffs})`
      : `Handoffs so far: cannot be verified (${chain.reason}); a handoff from this passport would be refused`,
  );
  return 0;
}

/** The same facts the API and the GUI show about a handoff context. */
function printContextSummary(c: HandoffContext): void {
  console.error(`Handoff context: ${c.chars} characters, sha256 ${c.sha256.slice(0, 12)}, report ${c.report}, instruction ${c.meta.instructionSource}`);
  for (const w of c.warnings) {
    console.error(`  warning: ${w}`);
  }
}

async function cmdHandoff(args: string[]): Promise<number> {
  const [fromGroupId] = positional(args);
  const to = flag(args, '--to') as AgentKey | undefined;
  if (!fromGroupId || !to || !['codex', 'claude', 'local'].includes(to)) {
    console.error('Usage: ornelyon handoff <task-id> --to codex|claude|local [--instruction "<text>"] [--preview] [--accept-current-state] [--timeout N]');
    return 2;
  }
  const config = loadConfig().config;
  const det = await detectAgents(config, true);
  const timeoutRaw = flag(args, '--timeout');
  const instruction = flag(args, '--instruction') ?? null;
  if (args.includes('--preview')) {
    const prepared = prepareHandoff(config, { fromGroupId, to, acceptCurrentState: args.includes('--accept-current-state'), timeoutSec: undefined, instruction }, availabilityFrom(det));
    if (!prepared.ok) {
      console.error(prepared.error);
      return 1;
    }
    printContextSummary(prepared.context);
    console.log('');
    console.log(prepared.context.text);
    return 0;
  }
  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort();
  process.once('SIGINT', onInterrupt);
  const started = handoffTask(
    config,
    {
      fromGroupId,
      to,
      acceptCurrentState: args.includes('--accept-current-state'),
      timeoutSec: timeoutRaw === undefined ? undefined : Number(timeoutRaw),
      instruction,
    },
    randomUUID(),
    controller.signal,
    (line) => console.error(`  ${line}`),
    availabilityFrom(det),
  );
  if (!started.ok) {
    process.removeListener('SIGINT', onInterrupt);
    console.error(started.error);
    return 1;
  }
  printContextSummary(started.context);
  const out = await started.handle.done;
  process.removeListener('SIGINT', onInterrupt);
  console.log(`[handoff to ${to}] ${out.final.status}${out.final.errorMessage ? ` — ${out.final.errorMessage}` : ''}`);
  if (out.final.output) {
    console.log(out.final.output);
  }
  console.log('');
  printEvidence(out.groupId, out.evidence);
  return out.final.status === 'success' ? 0 : 1;
}

async function cmdResearch(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const config = loadConfig().config;
  if (sub === 'list') {
    const items = listCandidates();
    if (items.length === 0) {
      console.log('No research candidates yet.');
    }
    for (const c of items) {
      console.log(`${c.id}  ${c.status.padEnd(8)} ${c.agent.padEnd(7)} ${c.createdAt}  evidence=${c.evidence}  "${c.change.value.slice(0, 50)}"`);
    }
    return 0;
  }
  if (sub === 'show' || sub === 'apply' || sub === 'reject') {
    const id = positional(rest)[0] ?? '';
    try {
      if (sub === 'show') {
        console.log(JSON.stringify(loadCandidate(id), null, 2));
        return 0;
      }
      if (sub === 'reject') {
        rejectCandidate(id);
        console.log(`Rejected ${id}. Configuration unchanged.`);
        return 0;
      }
      if (!rest.includes('--yes')) {
        console.error('Applying changes the agent configuration. Review with `research show <id>`, then add --yes.');
        return 2;
      }
      applyCandidate(config, id);
      clearDetectionCache();
      console.log(`Applied ${id}. Only the promptPrefix of the candidate's agent changed.`);
      return 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }
  if (sub !== 'run') {
    console.error('Usage: ornelyon research run|list|show|apply|reject ...');
    return 2;
  }
  if (config.preset !== 'research') {
    console.error('Research runs only with the Research preset. Change the preset in `ornelyon gui` Setup first.');
    return 2;
  }
  const task = positional(rest).join(' ').trim();
  const agent = flag(rest, '--agent') as AgentKey | undefined;
  const expect = flag(rest, '--expect');
  if (!task || !agent || !expect || !['codex', 'claude', 'local'].includes(agent)) {
    console.error('Usage: ornelyon research run "<task>" --agent codex|claude|local --expect <regex> [--samples N]');
    return 2;
  }
  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort();
  process.once('SIGINT', onInterrupt);
  try {
    const outcome = await runResearch({
      config,
      agent,
      adapter: createAdapter(config, agent),
      task,
      expect,
      samples: Number(flag(rest, '--samples') ?? 1),
      cwd: resolveWorkspacePath(config.workspaceRoot, flag(rest, '--cwd')),
      timeoutMs: 600_000,
      signal: controller.signal,
      log: (line) => console.error(`  ${line}`),
      records: () => readRecords().records,
      record: (record) => appendRecord(record, historyPath()),
    });
    for (const s of outcome.scores) {
      console.log(`variant ${JSON.stringify(s.variant.slice(0, 60))}: ${s.passes}/${s.samples} passed`);
    }
    console.log(outcome.reason);
    if (outcome.candidate) {
      console.log(`Candidate ${outcome.candidate.id} (evidence: ${outcome.candidate.evidence}). Review it with \`research show ${outcome.candidate.id}\`.`);
    }
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }
}

function cmdHistory(args: string[]): number {
  const limit = Math.max(1, Number(flag(args, '--limit') ?? 20) || 20);
  const read = readRecords();
  const rows = read.records.slice(-limit);
  if (rows.length === 0) {
    console.log('No runs recorded yet.');
  }
  for (const r of rows) {
    const res = r.result;
    const ev = r.evidence ? `  exec=${r.evidence.execution} verify=${r.evidence.verification} accept=${r.evidence.acceptance}` : '';
    const prompt = r.prompt === '' ? '' : `  ${r.prompt.slice(0, 60)}`;
    console.log(`${r.recordedAt}  ${r.mode} ${r.role.padEnd(8)} ${res.agent.padEnd(7)} ${res.status.padEnd(11)} ${String(res.durationMs).padStart(7)}ms${ev}${prompt}`);
  }
  if (read.skippedLines > 0) {
    console.log(`(${read.skippedLines} unreadable history lines were skipped and kept on disk)`);
  }
  return 0;
}

function cmdCost(args: string[]): number {
  const hours = Number(flag(args, '--hours') ?? 24) || 24;
  const rows = costSummary(hours);
  if (rows.length === 0) {
    console.log(`No runs in the last ${hours} hours.`);
    return 0;
  }
  for (const s of rows) {
    const tokens = s.inputTokens === null ? 'unknown' : `in=${s.inputTokens} out=${s.outputTokens ?? 'unknown'}`;
    const cost = s.reportedCostUsd === null ? 'unknown' : `$${s.reportedCostUsd.toFixed(4)}`;
    console.log(`${s.agent}: runs=${s.runs} ok=${s.succeeded} failed=${s.failed} tokens=${tokens} (unreported runs: ${s.tokenUnknownRuns}) cost=${cost} (unreported runs: ${s.costUnknownRuns})`);
  }
  return 0;
}

async function cmdMcp(args: string[]): Promise<number> {
  const exposeContent = args.includes('--expose-content');
  const allTasks = args.includes('--all-tasks');
  const named = flagAll(args, '--allow-task');
  const recentRaw = flag(args, '--recent');
  const recent = recentRaw === undefined ? null : Number(recentRaw);
  if (recent !== null && (!Number.isInteger(recent) || recent < 1 || recent > 20)) {
    console.error('--recent must be a whole number from 1 to 20.');
    return 2;
  }
  if (allTasks && (named.length > 0 || recent !== null)) {
    console.error('--all-tasks cannot be combined with --allow-task or --recent.');
    return 2;
  }
  if (allTasks && exposeContent) {
    console.error('--expose-content cannot be combined with --all-tasks. Name the tasks whose content may be shown.');
    return 2;
  }
  if (named.some((t) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(t))) {
    console.error('--allow-task needs a task id (UUID).');
    return 2;
  }
  if (args.includes('--print-config')) {
    console.log(registrationHelp(fileURLToPath(import.meta.url), { exposeContent, tasks: allTasks ? 'all' : named, recent }));
    return 0;
  }
  if (args.includes('--self-test')) {
    const result = await selfTest(fileURLToPath(import.meta.url), args.filter((a) => a !== '--self-test'));
    console.log(result.lines.join('\n'));
    console.log(result.ok ? 'SELF-TEST PASS (this server only; a GUI connection is NOT_TESTED by this command)' : 'SELF-TEST FAIL');
    return result.ok ? 0 : 1;
  }
  const toolsArg = flag(args, '--tools');
  const tools = toolsArg === undefined ? undefined : toolsArg.split(',').map((t) => t.trim()).filter((t) => t !== '');
  const unknown = tools?.filter((t) => !MCP_TOOL_NAMES.includes(t)) ?? [];
  if (unknown.length > 0) {
    console.error('Unknown tool(s): ' + unknown.join(', ') + '. Available: ' + MCP_TOOL_NAMES.join(', '));
    return 2;
  }
  // The scope is fixed here, once. Tasks recorded later are not visible until the server is restarted.
  const tasks = allTasks ? 'all' : [...new Set([...named, ...(recent === null ? [] : recentTasks(readRecords().records, recent).map((t) => t.groupId))])];
  const version = (JSON.parse(readFileSync(packageRoot() + '/package.json', 'utf8')) as { version: string }).version;
  // stdout belongs to the protocol. Anything for people goes to stderr.
  console.error('ORNELYON MCP server ' + version + ' (read-only, stdio). Tasks in scope: ' + (tasks === 'all' ? 'ALL' : String(tasks.length)) + '. Content mode: ' + (exposeContent ? 'ON' : 'off') + '. Waiting for an MCP client.');
  await serveStdio({ tasks, exposeContent, tools, version });
  return 0;
}

function cmdTool(args: string[]): number {
  const [name, state] = positional(args);
  if (!name || !state) {
    console.error(`Usage: ornelyon tool <name> <${TOOL_STATES.join('|')}>`);
    return 2;
  }
  const loaded = loadConfig();
  try {
    const tools = setToolState(loaded.config.optimization.tools, name, state as ToolState);
    saveConfig({ ...loaded.config, optimization: { ...loaded.config.optimization, tools } });
    clearDetectionCache();
    console.log(`${name} -> ${state}`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function cmdGui(args: string[]): Promise<number> {
  const config = loadConfig().config;
  const port = Number(flag(args, '--port') ?? config.gui.port);
  let server: RunningServer;
  try {
    server = await startServer(port);
  } catch (err) {
    console.error(`Could not start the GUI on 127.0.0.1:${port}: ${err instanceof Error ? err.message : String(err)}`);
    console.error('Try another port with --port.');
    return 1;
  }
  console.log('ORNELYON Setup and dashboard is running.');
  console.log(`Open this link in your browser (keep this window open):\n  ${server.url}`);
  console.log('Press Ctrl+C to stop.');
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void server.close().then(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'gui':
      return cmdGui(rest);
    case 'doctor':
      return cmdDoctor(rest);
    case 'run':
      return cmdRun(rest);
    case 'history':
      return cmdHistory(rest);
    case 'accept':
      return cmdDecide('accept', rest);
    case 'reject':
      return cmdDecide('reject', rest);
    case 'verdict':
      return cmdVerdict(rest);
    case 'passport':
      return cmdPassport(rest);
    case 'handoff':
      return cmdHandoff(rest);
    case 'cost':
      return cmdCost(rest);
    case 'benchmark':
      return cmdBenchmark(rest);
    case 'mcp':
      return cmdMcp(rest);
    case 'tool':
      return cmdTool(rest);
    case 'research':
      return cmdResearch(rest);
    case 'config':
      if (rest[0] === 'path') {
        console.log(configPath());
        return 0;
      }
      break;
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE);
      return 0;
  }
  console.error(USAGE);
  return 2;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
