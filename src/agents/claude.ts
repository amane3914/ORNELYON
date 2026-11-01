import { classifyFailure } from '../core/errors.js';
import { resolveExecutable, runProcess } from '../core/process.js';
import type { ToolEntry } from '../core/config.js';
import type { AgentAdapter, DetectionResult, RunContext, TaskRequest, TaskResult, Usage, Provenance } from '../core/types.js';
import { buildResult, failureResult, firstLine, UNKNOWN_USAGE } from './base.js';
import type { CommandSpec } from './spec.js';
import { dormantToolNames } from '../optimization/dormancy.js';

/** Claude Code's sub-agent tool. Its name differs between CLI versions, so both are denied. Unverified against 2.1.311. */
const SUBAGENT_TOOL_NAMES = ['Task', 'Agent'];

export interface ClaudeOptions {
  model: string | null;
  budgetUsd: number | null;
  tools: ToolEntry[];
  allowSubagents: boolean;
  /** Absolute path to the executable. When unset, the first match on PATH is used. */
  executable?: string | null;
  /** Test hook: run a different executable with the same arguments. Production leaves this unset. */
  spec?: CommandSpec;
  secrets?: string[];
}

/**
 * Adapter for the official Claude Code CLI in non-interactive mode (`claude -p`).
 * Read-only tasks run in plan mode. Write-capable tasks use `acceptEdits`: file edits are
 * accepted automatically, and anything else that would need approval is refused, because
 * headless mode cannot ask. This adapter never uses a permission-bypass mode.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';

  get provenance(): Provenance {
    return this.options.spec ? 'test-command' : 'cli';
  }

  constructor(private readonly options: ClaudeOptions) {}

  private spec(): CommandSpec | null {
    if (this.options.spec) {
      return this.options.spec;
    }
    const exe = this.options.executable ?? resolveExecutable('claude');
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
        authNote: 'claude was not found. Install Claude Code from the official site and run `claude auth login`.',
      };
    }
    const cwd = process.cwd();
    const env = { ...process.env, ...spec.extraEnv };
    const version = await runProcess({ command: spec.command, args: [...spec.prefixArgs, '--version'], cwd, timeoutMs: 15_000, env });
    const installed = version.code === 0;
    const status = await runProcess({ command: spec.command, args: [...spec.prefixArgs, 'auth', 'status', '--json'], cwd, timeoutMs: 15_000, env });
    let loggedIn = false;
    let method = '';
    try {
      const parsed = JSON.parse(status.stdout) as { loggedIn?: unknown; authMethod?: unknown };
      loggedIn = parsed.loggedIn === true;
      method = typeof parsed.authMethod === 'string' ? parsed.authMethod : '';
    } catch {
      loggedIn = false;
    }
    return {
      installed,
      version: installed ? firstLine(version.stdout) : null,
      executable: spec.command,
      authenticated: installed ? loggedIn : null,
      // The account email is never copied into the note.
      authNote: loggedIn
        ? `Signed in${method ? ` (${method})` : ''}`
        : 'Not signed in. Run `claude auth login` and follow the official sign-in flow.',
    };
  }

  async run(request: TaskRequest, ctx: RunContext): Promise<TaskResult> {
    const startedAtMs = Date.now();
    const secrets = this.options.secrets ?? [];
    const spec = this.spec();
    const model = this.options.model;
    if (!spec) {
      return failureResult({
        taskId: request.id,
        agent: this.id,
        startedAtMs,
        model,
        usage: UNKNOWN_USAGE,
        costUsd: null,
        error: classifyFailure({ spawnError: 'ENOENT', exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: false }),
      });
    }

    const permissionMode = request.sandbox === 'read-only' ? 'plan' : 'acceptEdits';
    const disallowed = [
      ...new Set([...dormantToolNames(this.options.tools), ...(this.options.allowSubagents ? [] : SUBAGENT_TOOL_NAMES)]),
    ];
    const args = [
      ...spec.prefixArgs,
      '-p',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--permission-mode',
      permissionMode,
    ];
    if (model) {
      args.push('--model', model);
    }
    if (this.options.budgetUsd !== null) {
      args.push('--max-budget-usd', String(this.options.budgetUsd));
    }
    if (disallowed.length > 0) {
      // Must stay the last option: --disallowedTools takes a variadic list.
      args.push('--disallowedTools', ...disallowed);
    }

    ctx.log(`claude: starting (permission=${permissionMode}, denied tools=${disallowed.length})`);
    const proc = await runProcess({
      command: spec.command,
      args,
      cwd: request.cwd,
      input: request.prompt,
      timeoutMs: request.timeoutMs,
      signal: ctx.signal,
      env: { ...process.env, ...spec.extraEnv },
    });
    ctx.log(`claude: exited with code ${String(proc.code)}`);

    const parsed = parseClaudeJson(proc.stdout);
    const usage: Usage = parsed.usage ?? UNKNOWN_USAGE;
    const base = {
      taskId: request.id,
      agent: this.id,
      startedAtMs,
      model: parsed.model ?? model,
      usage,
      costUsd: parsed.costUsd,
    };

    if (proc.cancelled || proc.timedOut || proc.spawnError !== null) {
      return failureResult({
        ...base,
        error: classifyFailure(
          { spawnError: proc.spawnError, exitCode: proc.code, stdout: proc.stdout, stderr: proc.stderr, timedOut: proc.timedOut, cancelled: proc.cancelled },
          secrets,
        ),
      });
    }
    // A subtype other than "success" (for example error_max_turns) means the run did not finish its task.
    // An absent subtype is not treated as failure, because the output shape is not verified against the CLI.
    const subtypeOk = parsed.subtype === null || parsed.subtype === 'success';
    if (parsed.result !== null && !parsed.isError && subtypeOk && proc.code === 0) {
      return buildResult({ ...base, status: 'success', output: parsed.result, error: null });
    }
    const error = classifyFailure(
      {
        spawnError: null,
        exitCode: proc.code,
        stdout: `${parsed.result ?? ''}\n${proc.stdout}`,
        stderr: proc.stderr,
        timedOut: false,
        cancelled: false,
      },
      secrets,
    );
    return failureResult({ ...base, error });
  }
}

interface ParsedClaude {
  result: string | null;
  isError: boolean;
  /** The result subtype reported by the CLI, e.g. "success" or "error_max_turns". Null when absent. */
  subtype: string | null;
  usage: Usage | null;
  costUsd: number | null;
  model: string | null;
}

/**
 * Read `claude -p --output-format json`. Accepts either one result object or an array of
 * events. Unknown fields are ignored. Cost is taken only when the CLI reports it.
 */
export function parseClaudeJson(stdout: string): ParsedClaude {
  const empty: ParsedClaude = { result: null, isError: false, subtype: null, usage: null, costUsd: null, model: null };
  let data: unknown;
  try {
    data = JSON.parse(stdout.trim());
  } catch {
    return empty;
  }
  const events: unknown[] = Array.isArray(data) ? data : [data];
  const resultEvent = [...events]
    .reverse()
    .find((e): e is Record<string, unknown> => typeof e === 'object' && e !== null && (e as Record<string, unknown>).type === 'result');
  if (!resultEvent) {
    return empty;
  }
  const usageRaw = resultEvent.usage as Record<string, unknown> | undefined;
  const usage: Usage | null =
    usageRaw && typeof usageRaw === 'object'
      ? {
          inputTokens: typeof usageRaw.input_tokens === 'number' ? usageRaw.input_tokens : null,
          outputTokens: typeof usageRaw.output_tokens === 'number' ? usageRaw.output_tokens : null,
        }
      : null;
  const modelUsage = resultEvent.modelUsage as Record<string, unknown> | undefined;
  const model = modelUsage && typeof modelUsage === 'object' ? (Object.keys(modelUsage)[0] ?? null) : null;
  return {
    result: typeof resultEvent.result === 'string' ? resultEvent.result : null,
    isError: resultEvent.is_error === true,
    subtype: typeof resultEvent.subtype === 'string' ? resultEvent.subtype : null,
    usage,
    costUsd: typeof resultEvent.total_cost_usd === 'number' ? resultEvent.total_cost_usd : null,
    model,
  };
}
