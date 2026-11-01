import { classifyFailure } from '../core/errors.js';
import type { AgentAdapter, DetectionResult, RunContext, TaskRequest, TaskResult } from '../core/types.js';
import { buildResult, failureResult, UNKNOWN_USAGE } from '../agents/base.js';

export interface ScriptedReply {
  status: 'success' | 'failed';
  output?: string;
  /** Error text for failed replies. Classified through the same code path as real agents. */
  stderr?: string;
  exitCode?: number;
  costUsd?: number | null;
}

/**
 * Scripted adapter for tests and demos. It replays replies in order and repeats the last one
 * when the script runs out. It is never registered in the production registry.
 */
export class FakeAdapter implements AgentAdapter {
  readonly displayName: string;
  readonly provenance = 'fake-adapter' as const;
  readonly calls: TaskRequest[] = [];

  constructor(
    readonly id: string,
    private readonly script: ScriptedReply[],
    private readonly installed = true,
  ) {
    this.displayName = `Fake ${id}`;
  }

  async detect(): Promise<DetectionResult> {
    return {
      installed: this.installed,
      version: 'fake-1.0',
      executable: null,
      authenticated: this.installed,
      authNote: this.installed ? 'fake signed in' : 'fake not installed',
    };
  }

  async run(request: TaskRequest, _ctx: RunContext): Promise<TaskResult> {
    this.calls.push(request);
    const startedAtMs = Date.now();
    const index = Math.min(this.calls.length - 1, this.script.length - 1);
    const reply = this.script[index];
    if (reply.status === 'success') {
      return buildResult({
        taskId: request.id,
        agent: this.id,
        startedAtMs,
        status: 'success',
        output: reply.output ?? '',
        model: 'fake-model',
        usage: { inputTokens: 10, outputTokens: 5 },
        costUsd: reply.costUsd ?? null,
        error: null,
      });
    }
    const error = classifyFailure({
      spawnError: null,
      exitCode: reply.exitCode ?? 1,
      stdout: '',
      stderr: reply.stderr ?? 'fake failure',
      timedOut: false,
      cancelled: false,
    });
    return failureResult({
      taskId: request.id,
      agent: this.id,
      startedAtMs,
      model: 'fake-model',
      usage: UNKNOWN_USAGE,
      costUsd: reply.costUsd ?? null,
      error,
    });
  }
}
