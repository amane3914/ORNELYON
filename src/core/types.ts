/**
 * Shared task contract. Every adapter, the orchestrator, the CLI and the GUI
 * speak in these types only.
 */

export type AgentId = string;

export type ErrorKind =
  | 'not_installed'
  | 'not_authenticated'
  | 'rate_limited'
  | 'timeout'
  | 'cancelled'
  | 'invalid_request'
  | 'agent_failed'
  | 'unknown';

export type RunStatus = 'success' | 'failed' | 'timeout' | 'cancelled' | 'unavailable';

/** Sandbox level requested for an agent run. `read-only` is the default. */
export type SandboxMode = 'read-only' | 'workspace-write';

export interface TaskRequest {
  id: string;
  prompt: string;
  /** Working directory the agent may use. Must be inside the configured workspace root. */
  cwd: string;
  /** Requested agent. Ignored by orchestrators that choose agents themselves. */
  agent?: AgentId;
  /** Free-form task category used by rule-based routing, e.g. "code" or "text". */
  kind?: string;
  timeoutMs: number;
  sandbox: SandboxMode;
}

/** Token usage. Fields are `null` when the agent did not report them. */
export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface TaskResult {
  taskId: string;
  agent: AgentId;
  status: RunStatus;
  output: string;
  model: string | null;
  errorKind: ErrorKind | null;
  errorMessage: string | null;
  /** Error signature with volatile parts removed. Used by the loop guard. */
  errorSignature: string | null;
  usage: Usage;
  /** Cost in USD exactly as reported by the agent, or `null` when unknown. Never estimated. */
  costUsd: number | null;
  startedAt: string;
  durationMs: number;
}

export interface DetectionResult {
  installed: boolean;
  version: string | null;
  /** Path of the executable that was found, if any. */
  executable: string | null;
  authenticated: boolean | null;
  authNote: string;
}

export interface RunContext {
  signal: AbortSignal;
  /** Called for each log line so the caller can stream progress. Secrets must already be redacted. */
  log: (line: string) => void;
}

/**
 * Where an adapter's answers come from, as ORNELYON itself knows it when it builds the adapter (v0.4.1).
 *   cli             the Codex or Claude Code command, found on PATH or at the configured executable
 *   local-endpoint  an OpenAI-compatible HTTP endpoint chosen in the settings (it may still be a stand-in server)
 *   fake-adapter    a scripted adapter used by tests and demos
 *   test-command    a real adapter class pointed at a replacement command or fetch (test hook)
 * Only `cli` and `local-endpoint` count as real use. An adapter with no value is recorded as unknown.
 */
export type Provenance = 'cli' | 'local-endpoint' | 'fake-adapter' | 'test-command';

export interface AgentAdapter {
  readonly id: AgentId;
  readonly provenance?: Provenance;
  readonly displayName: string;
  detect(): Promise<DetectionResult>;
  run(request: TaskRequest, ctx: RunContext): Promise<TaskResult>;
}
