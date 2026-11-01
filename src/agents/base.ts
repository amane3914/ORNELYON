import type { ClassifiedError } from '../core/errors.js';
import type { AgentId, ErrorKind, RunStatus, TaskResult, Usage } from '../core/types.js';

export interface ResultInput {
  taskId: string;
  agent: AgentId;
  startedAtMs: number;
  status: RunStatus;
  output: string;
  model: string | null;
  usage: Usage;
  costUsd: number | null;
  error: ClassifiedError | null;
}

export const UNKNOWN_USAGE: Usage = { inputTokens: null, outputTokens: null };

export function buildResult(input: ResultInput): TaskResult {
  return {
    taskId: input.taskId,
    agent: input.agent,
    status: input.status,
    output: input.output,
    model: input.model,
    errorKind: input.error?.kind ?? null,
    errorMessage: input.error?.message ?? null,
    errorSignature: input.error?.signature ?? null,
    usage: input.usage,
    costUsd: input.costUsd,
    startedAt: new Date(input.startedAtMs).toISOString(),
    durationMs: Date.now() - input.startedAtMs,
  };
}

/** Map an error kind to the run status shown to the user. */
export function statusForKind(kind: ErrorKind): RunStatus {
  switch (kind) {
    case 'cancelled':
      return 'cancelled';
    case 'timeout':
      return 'timeout';
    case 'not_installed':
    case 'not_authenticated':
      return 'unavailable';
    default:
      return 'failed';
  }
}

export function failureResult(input: Omit<ResultInput, 'status' | 'output' | 'error'> & { error: ClassifiedError }): TaskResult {
  return buildResult({ ...input, status: statusForKind(input.error.kind), output: '' });
}

/** Trim a line of human text for a status note. Never includes account identifiers or raw key names. */
export function firstLine(text: string, max = 160): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.trim().slice(0, max);
}
