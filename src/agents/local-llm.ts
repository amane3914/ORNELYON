import { classifyFailure } from '../core/errors.js';
import type { ToolEntry } from '../core/config.js';
import { redact } from '../core/redact.js';
import type { AgentAdapter, DetectionResult, RunContext, TaskRequest, TaskResult, Usage, Provenance } from '../core/types.js';
import { buildResult, failureResult, UNKNOWN_USAGE } from './base.js';
import { activeTools } from '../optimization/dormancy.js';

export interface LocalLlmOptions {
  baseUrl: string;
  model: string | null;
  /** Name of the env var holding the API key. The key value is read at call time and never stored. */
  apiKeyEnv: string | null;
  tools: ToolEntry[];
  /** Test hook: replaces the global fetch so unit tests do not need a server. */
  fetchImpl?: typeof fetch;
}

/**
 * Adapter for any OpenAI-compatible chat endpoint (Ollama, LM Studio, llama.cpp server, vLLM…).
 * Only ACTIVE tools are described in the request. DORMANT, QUARANTINED and DISABLED tools are
 * removed from the request body, so they cost no input tokens.
 */
export class LocalLlmAdapter implements AgentAdapter {
  readonly id = 'local';
  readonly displayName = 'Local LLM (OpenAI-compatible)';

  get provenance(): Provenance {
    return this.options.fetchImpl ? 'test-command' : 'local-endpoint';
  }

  constructor(private readonly options: LocalLlmOptions) {}

  private get fetcher(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const key = this.apiKeyValue();
    if (key) {
      headers.authorization = `Bearer ${key}`;
    }
    return headers;
  }

  private apiKeyValue(): string | null {
    if (!this.options.apiKeyEnv) {
      return null;
    }
    const value = process.env[this.options.apiKeyEnv];
    return value && value.length > 0 ? value : null;
  }

  async detect(): Promise<DetectionResult> {
    const keyNeeded = this.options.apiKeyEnv !== null;
    const keyPresent = this.apiKeyValue() !== null;
    try {
      const res = await this.fetcher(`${this.base()}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(3_000),
      });
      const reachable = res.status < 500;
      return {
        installed: reachable,
        version: null,
        executable: this.options.baseUrl,
        authenticated: keyNeeded ? keyPresent && res.status !== 401 : null,
        authNote: keyNeeded
          ? keyPresent
            ? res.status === 401
              ? 'The server rejected the API key.'
              : 'API key found in the environment variable.'
            : `Environment variable ${this.options.apiKeyEnv ?? ''} is not set.`
          : 'No API key configured (local servers usually need none).',
      };
    } catch {
      return {
        installed: false,
        version: null,
        executable: this.options.baseUrl,
        authenticated: null,
        authNote: `Could not reach ${this.options.baseUrl}. Start your local LLM server and check the URL.`,
      };
    }
  }

  private base(): string {
    return this.options.baseUrl.replace(/\/+$/, '');
  }

  async run(request: TaskRequest, ctx: RunContext): Promise<TaskResult> {
    const startedAtMs = Date.now();
    const secrets = [this.apiKeyValue()].filter((v): v is string => v !== null);
    const tools = activeTools(this.options.tools);
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (tools.length > 0) {
      const list = tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
      messages.push({ role: 'system', content: `Tools you may refer to:\n${list}` });
    }
    messages.push({ role: 'user', content: request.prompt });

    const body = JSON.stringify({ model: this.options.model ?? 'default', messages, stream: false });
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal = AbortSignal.any([ctx.signal, timeout]);

    ctx.log(`local: POST ${this.base()}/chat/completions (${tools.length} active tools)`);
    // The connection can fail before the headers arrive (fetch) or while the body is read (text()): both end the same way.
    const networkFailure = (err: unknown): TaskResult => {
      const message = err instanceof Error ? err.message : String(err);
      const cancelled = ctx.signal.aborted;
      const timedOut = !cancelled && timeout.aborted;
      const kind = cancelled ? 'cancelled' : timedOut ? 'timeout' : /ECONNREFUSED|fetch failed|ENOTFOUND/i.test(message) ? 'not_installed' : 'unknown';
      return failureResult({
        taskId: request.id,
        agent: this.id,
        startedAtMs,
        model: this.options.model,
        usage: UNKNOWN_USAGE,
        costUsd: null,
        error: {
          kind,
          message:
            kind === 'not_installed'
              ? `Local LLM server is not reachable at ${this.base()}.`
              : redact(message, secrets).slice(0, 300),
          signature: kind === 'unknown' ? 'local-network-error' : kind,
        },
      });
    };
    let res: Response;
    let raw: string;
    try {
      res = await this.fetcher(`${this.base()}/chat/completions`, { method: 'POST', headers: this.headers(), body, signal });
      raw = await res.text();
    } catch (err) {
      return networkFailure(err);
    }
    const base = { taskId: request.id, agent: this.id, startedAtMs, costUsd: null as number | null };
    if (!res.ok) {
      const error = classifyFailure(
        { spawnError: null, exitCode: 1, stdout: '', stderr: `HTTP ${res.status} ${redact(raw, secrets).slice(0, 300)}`, timedOut: false, cancelled: false },
        secrets,
      );
      const kind = res.status === 401 || res.status === 403 ? 'not_authenticated' : error.kind;
      return failureResult({ ...base, model: this.options.model, usage: UNKNOWN_USAGE, error: { ...error, kind } });
    }

    const parsed = parseChatCompletion(raw);
    if (parsed === null) {
      return failureResult({
        ...base,
        model: this.options.model,
        usage: UNKNOWN_USAGE,
        error: { kind: 'unknown', message: 'The server response did not contain a chat completion.', signature: 'bad-response' },
      });
    }
    return buildResult({
      ...base,
      model: parsed.model ?? this.options.model,
      usage: parsed.usage,
      status: 'success',
      output: parsed.content,
      error: null,
    });
  }
}

interface ParsedCompletion {
  content: string;
  model: string | null;
  usage: Usage;
}

export function parseChatCompletion(raw: string): ParsedCompletion | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const d = data as Record<string, unknown>;
  const choices = Array.isArray(d.choices) ? (d.choices as unknown[]) : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = first?.message?.content;
  if (typeof content !== 'string') {
    return null;
  }
  const u = (d.usage ?? {}) as Record<string, unknown>;
  return {
    content,
    model: typeof d.model === 'string' ? d.model : null,
    usage: {
      inputTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : null,
      outputTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : null,
    },
  };
}
