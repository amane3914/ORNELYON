import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { classifyFailure } from '../core/errors.js';
import { dataDir } from '../core/paths.js';
import { resolveExecutable, runProcess } from '../core/process.js';
import type { AgentAdapter, DetectionResult, RunContext, TaskRequest, TaskResult, Usage, Provenance } from '../core/types.js';
import { buildResult, failureResult, firstLine, UNKNOWN_USAGE } from './base.js';
import type { CommandSpec } from './spec.js';

/** Feature flags that let Codex start sub-agents. Disabled unless allowSubagents is on. */
const SUBAGENT_FEATURES = ['multi_agent', 'multi_agent_v2'];

export interface CodexOptions {
  model: string | null;
  allowSubagents: boolean;
  /** Absolute path to the executable. When unset, the first match on PATH is used. */
  executable?: string | null;
  /** Test hook: run a different executable with the same arguments. Production leaves this unset. */
  spec?: CommandSpec;
  secrets?: string[];
}

/**
 * Adapter for the official Codex CLI (`codex exec`). The prompt goes through stdin
 * and the final message is read from the `-o` file, with JSONL events as a fallback.
 */
export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'OpenAI Codex';

  get provenance(): Provenance {
    return this.options.spec ? 'test-command' : 'cli';
  }

  constructor(private readonly options: CodexOptions) {}

  private spec(): CommandSpec | null {
    if (this.options.spec) {
      return this.options.spec;
    }
    const exe = this.options.executable ?? resolveExecutable('codex');
    return exe ? { command: exe, prefixArgs: [], extraEnv: {} } : null;
  }

  async detect(): Promise<DetectionResult> {
    const spec = this.spec();
    if (!spec) {
      return {
        installed: false,
        version: null,
        executable: null,
        authenticated: null,
        authNote: 'codex was not found. Install the official Codex CLI and run `codex login`.',
      };
    }
    const cwd = process.cwd();
    const env = { ...process.env, ...spec.extraEnv };
    const version = await runProcess({ command: spec.command, args: [...spec.prefixArgs, '--version'], cwd, timeoutMs: 15_000, env });
    const installed = version.code === 0;
    const status = await runProcess({ command: spec.command, args: [...spec.prefixArgs, 'login', 'status'], cwd, timeoutMs: 15_000, env });
    const loggedIn = status.code === 0 && /logged in/i.test(`${status.stdout}\n${status.stderr}`);
    return {
      installed,
      version: installed ? firstLine(version.stdout) : null,
      executable: spec.command,
      authenticated: installed ? loggedIn : null,
      authNote: loggedIn
        ? `Signed in (${firstLine(status.stdout + status.stderr, 80)})`
        : 'Not signed in. Run `codex login` and follow the official sign-in flow.',
    };
  }

  async run(request: TaskRequest, ctx: RunContext): Promise<TaskResult> {
    const startedAtMs = Date.now();
    const secrets = this.options.secrets ?? [];
    const spec = this.spec();
    if (!spec) {
      return failureResult({
        taskId: request.id,
        agent: this.id,
        startedAtMs,
        model: this.options.model,
        usage: UNKNOWN_USAGE,
        costUsd: null,
        error: classifyFailure({ spawnError: 'ENOENT', exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: false }),
      });
    }

    const dir = join(dataDir(), 'tmp');
    mkdirSync(dir, { recursive: true });
    const outFile = join(dir, `codex-${request.id}-${randomUUID()}.txt`);
    const args = [...spec.prefixArgs, 'exec'];
    if (!this.options.allowSubagents) {
      for (const feature of SUBAGENT_FEATURES) {
        args.push('--disable', feature);
      }
    }
    args.push('--json', '--skip-git-repo-check', '--ephemeral', '-C', request.cwd, '-s', request.sandbox, '-o', outFile);
    if (this.options.model) {
      args.push('-m', this.options.model);
    }
    args.push('-');

    ctx.log(`codex: starting (sandbox=${request.sandbox})`);
    const proc = await runProcess({
      command: spec.command,
      args,
      cwd: request.cwd,
      input: request.prompt,
      timeoutMs: request.timeoutMs,
      signal: ctx.signal,
      env: { ...process.env, ...spec.extraEnv },
    });

    const parsed = parseEvents(proc.stdout);
    let output = '';
    if (existsSync(outFile)) {
      output = readFileSync(outFile, 'utf8').trim();
      rmSync(outFile, { force: true });
    }
    if (output === '') {
      output = parsed.lastMessage;
    }
    ctx.log(`codex: exited with code ${String(proc.code)}`);

    const usage: Usage = parsed.usage ?? UNKNOWN_USAGE;
    const base = { taskId: request.id, agent: this.id, startedAtMs, model: this.options.model, usage, costUsd: null };

    if (proc.cancelled || proc.timedOut || proc.spawnError !== null) {
      return failureResult({
        ...base,
        error: classifyFailure(
          {
            spawnError: proc.spawnError,
            exitCode: proc.code,
            stdout: proc.stdout,
            stderr: proc.stderr,
            timedOut: proc.timedOut,
            cancelled: proc.cancelled,
          },
          secrets,
        ),
      });
    }
    // Exit code 0 only means the process finished. A turn that reported failure after an earlier
    // message is still a failed task, so it is checked separately.
    if (proc.code === 0 && output !== '' && !parsed.turnFailed) {
      return buildResult({ ...base, status: 'success', output, error: null });
    }
    if (parsed.turnFailed) {
      const error = classifyFailure({ spawnError: null, exitCode: proc.code, stdout: parsed.errorText, stderr: proc.stderr, timedOut: false, cancelled: false }, secrets);
      return failureResult({ ...base, error });
    }
    const error = classifyFailure(
      { spawnError: null, exitCode: proc.code, stdout: `${parsed.errorText}\n${proc.stdout}`, stderr: proc.stderr, timedOut: false, cancelled: false },
      secrets,
    );
    if (proc.code === 0) {
      return failureResult({ ...base, error: { ...error, kind: 'unknown', message: 'Codex finished without a readable final message.', signature: 'no-final-message' } });
    }
    return failureResult({ ...base, error });
  }
}

interface ParsedEvents {
  lastMessage: string;
  errorText: string;
  usage: Usage | null;
  /** True when the event stream reported a failed turn or an error event. */
  turnFailed: boolean;
}

/** Read the JSONL event stream defensively. Unknown event shapes are ignored, never guessed. */
export function parseEvents(stdout: string): ParsedEvents {
  let lastMessage = '';
  let errorText = '';
  let usage: Usage | null = null;
  let turnFailed = false;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event !== 'object' || event === null) {
      continue;
    }
    const outer = event as Record<string, unknown>;
    // Codex's own session files wrap events as { type: "event_msg", payload: { type: ... } }.
    // Both wrappers are accepted; the payload is what carries the event name.
    const e = outer.type === 'event_msg' && typeof outer.payload === 'object' && outer.payload !== null
      ? (outer.payload as Record<string, unknown>)
      : outer;
    const item = e.item as Record<string, unknown> | undefined;
    if (item && item.type === 'agent_message' && typeof item.text === 'string') {
      lastMessage = item.text;
    }
    // Completion events. `task_complete` carries the final agent message in `last_agent_message`.
    if (e.type === 'task_complete' && typeof e.last_agent_message === 'string' && e.last_agent_message !== '') {
      lastMessage = e.last_agent_message;
    }
    // `token_count` reports cumulative totals in info.total_token_usage. The last event wins.
    const info = e.info as Record<string, unknown> | undefined;
    const tokenTotals = (e.type === 'token_count' && info && typeof info.total_token_usage === 'object' ? info.total_token_usage : undefined) as
      | Record<string, unknown>
      | undefined;
    const usageSource = e.type === 'turn.completed' && typeof e.usage === 'object' && e.usage !== null ? (e.usage as Record<string, unknown>) : tokenTotals;
    if (usageSource) {
      usage = {
        inputTokens: typeof usageSource.input_tokens === 'number' ? usageSource.input_tokens : null,
        outputTokens: typeof usageSource.output_tokens === 'number' ? usageSource.output_tokens : null,
      };
    }
    if (e.type === 'error' && typeof e.message === 'string') {
      errorText = e.message;
      turnFailed = true;
    }
    if (e.type === 'turn.failed') {
      turnFailed = true;
      const message = typeof e.error === 'object' && e.error !== null ? (e.error as Record<string, unknown>).message : undefined;
      if (typeof message === 'string') {
        errorText = message;
      }
    }
    // `turn_aborted` is the on-disk name for a turn that ended without finishing.
    if (e.type === 'turn_aborted') {
      turnFailed = true;
      if (typeof e.reason === 'string') {
        errorText = e.reason;
      }
    }
  }
  return { lastMessage, errorText, usage, turnFailed };
}
