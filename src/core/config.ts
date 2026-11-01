import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { configPath, dataDir } from './paths.js';
import type { SandboxMode } from './types.js';

export type Preset = 'lite' | 'standard' | 'research';
export type CollabMode = 'manual' | 'review' | 'auto';
export type ToolState = 'ACTIVE' | 'DORMANT' | 'QUARANTINED' | 'DISABLED';
export type AgentKey = 'codex' | 'claude' | 'local';

export interface AgentSettings {
  enabled: boolean;
  /** Free-form labels such as "code" or "text". Routing uses only these declared labels. */
  capabilities: string[];
  /** Lower number is tried first in rule-based routing. */
  priority: number;
  /** Maximum spend in USD for this agent per day, counted from reported costs only. `null` = no limit. */
  budgetUsd: number | null;
  timeoutSec: number;
  model: string | null;
  /** Text added before every task sent to this agent. Only Research apply changes it. */
  promptPrefix: string;
  /**
   * Absolute path to the CLI executable. Set it when several installs exist on PATH and the
   * first one is broken. `null` means search PATH.
   */
  executable: string | null;
}

export interface LocalSettings extends AgentSettings {
  /** OpenAI-compatible base URL, e.g. http://localhost:11434/v1 */
  baseUrl: string;
  /** Name of the environment variable that holds the API key. The key itself is never stored. */
  apiKeyEnv: string | null;
}

export interface ToolEntry {
  name: string;
  description: string;
  state: ToolState;
}

export interface ChimeraConfig {
  version: 1;
  preset: Preset;
  setupCompleted: boolean;
  workspaceRoot: string;
  defaultSandbox: SandboxMode;
  /**
   * Whether agents may start their own sub-agents. Off by default. Enforced per agent:
   * Claude Code denies its sub-agent tools, Codex runs with the multi_agent features disabled.
   */
  allowSubagents: boolean;
  multiAi: {
    enabled: boolean;
    mainAgent: AgentKey;
    mode: CollabMode;
    /** Hard cap on agent invocations for one user task (main + reviewers + fallbacks). */
    maxCalls: number;
    /** Hard cap on nested agent-to-agent calls. Agents never call other agents at depth > maxDepth. */
    maxDepth: number;
    /**
     * Hard cap on sequential manual handoffs in one chain of tasks (v0.3). Separate from maxDepth, which
     * limits nested calls. Counted from history, so a regenerated passport cannot reset it.
     */
    maxHandoffs: number;
    /** Upper bound, in characters, of the context sent to the next agent in a handoff (v0.3.1). */
    handoffContextMaxChars: number;
    /** Smart Dispatch (v0.2). Off by default; when off, routing is exactly as in v0.1. */
    smartDispatch: { enabled: boolean; criticalKinds: string[] };
  };
  /**
   * Verification commands are registered here by the user. Agents cannot add entries or switch
   * allowCommands on. Each command runs without a shell and only when a task names it.
   */
  verification: {
    allowCommands: boolean;
    commands: Record<string, TrustedCommand>;
  };
  agents: {
    codex: AgentSettings;
    claude: AgentSettings;
    local: LocalSettings;
  };
  optimization: {
    loopGuard: { enabled: boolean; maxRetries: number; stopAfterSameErrors: number };
    /**
     * Tool states are changed only by the user. ORNELYON cannot observe which tools an
     * external agent calls internally, so it never sets a tool to DORMANT on its own.
     */
    tools: ToolEntry[];
  };
  gui: { port: number };
}

export class ConfigError extends Error {}

export interface TrustedCommand {
  /** Absolute path to the executable. */
  command: string;
  args: string[];
  timeoutSec: number;
}

function agentDefaults(priority: number, capabilities: string[], enabled: boolean): AgentSettings {
  return { enabled, capabilities, priority, budgetUsd: null, timeoutSec: 600, model: null, promptPrefix: '', executable: null };
}

export function defaultConfig(): ChimeraConfig {
  return {
    version: 1,
    preset: 'lite',
    setupCompleted: false,
    workspaceRoot: join(dataDir(), 'workspace'),
    defaultSandbox: 'read-only',
    allowSubagents: false,
    multiAi: {
      enabled: false,
      mainAgent: 'codex',
      mode: 'manual',
      maxCalls: 3,
      maxDepth: 1,
      maxHandoffs: 2,
      handoffContextMaxChars: 6000,
      smartDispatch: { enabled: false, criticalKinds: [] },
    },
    verification: { allowCommands: false, commands: {} },
    agents: {
      codex: agentDefaults(1, ['code', 'text'], true),
      claude: agentDefaults(2, ['code', 'text'], false),
      local: {
        ...agentDefaults(3, ['text'], false),
        baseUrl: 'http://localhost:11434/v1',
        apiKeyEnv: null,
      },
    },
    optimization: {
      loopGuard: { enabled: true, maxRetries: 2, stopAfterSameErrors: 3 },
      tools: [],
    },
    gui: { port: 7777 },
  };
}

/** Presets only set starting values. Each value stays editable afterwards. */
export function applyPreset(config: ChimeraConfig, preset: Preset): ChimeraConfig {
  const next = structuredClone(config);
  next.preset = preset;
  if (preset === 'lite') {
    next.multiAi.enabled = false;
    next.multiAi.mode = 'manual';
  } else if (preset === 'standard') {
    next.multiAi.enabled = true;
    next.multiAi.mode = 'manual';
  } else {
    next.multiAi.enabled = true;
    next.multiAi.mode = 'auto';
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function pickStringOrNull(value: unknown, fallback: string | null): string | null {
  if (value === null) {
    return null;
  }
  return typeof value === 'string' ? value : fallback;
}

function pickAbsolutePathOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  return isAbsolute(value.trim()) ? value.trim() : null;
}

function pickAgentSettings(raw: unknown, base: AgentSettings): AgentSettings {
  const r = isRecord(raw) ? raw : {};
  const capabilities = Array.isArray(r.capabilities)
    ? r.capabilities.filter((c): c is string => typeof c === 'string' && /^[a-z0-9-]{1,32}$/.test(c))
    : base.capabilities;
  return {
    enabled: pickBool(r.enabled, base.enabled),
    capabilities,
    priority: pickNumber(r.priority, base.priority, 1, 99),
    budgetUsd: r.budgetUsd === null ? null : pickNumber(r.budgetUsd, base.budgetUsd ?? 0, 0, 100000) || null,
    timeoutSec: pickNumber(r.timeoutSec, base.timeoutSec, 5, 3600),
    model: pickStringOrNull(r.model, base.model),
    promptPrefix: pickString(r.promptPrefix, base.promptPrefix).slice(0, 2000),
    executable: pickAbsolutePathOrNull(r.executable),
  };
}

function pickSmartDispatch(raw: unknown): { enabled: boolean; criticalKinds: string[] } {
  const r = isRecord(raw) ? raw : {};
  const kinds = Array.isArray(r.criticalKinds)
    ? r.criticalKinds.filter((k): k is string => typeof k === 'string' && /^[a-z0-9-]{1,32}$/.test(k)).slice(0, 20)
    : [];
  return { enabled: pickBool(r.enabled, false), criticalKinds: kinds };
}

function pickVerification(raw: unknown): { allowCommands: boolean; commands: Record<string, TrustedCommand> } {
  const r = isRecord(raw) ? raw : {};
  const commands: Record<string, TrustedCommand> = {};
  if (isRecord(r.commands)) {
    for (const [name, value] of Object.entries(r.commands).slice(0, 20)) {
      if (!/^[a-z0-9-]{1,32}$/.test(name) || !isRecord(value)) {
        continue;
      }
      const command = pickAbsolutePathOrNull(value.command);
      if (command === null) {
        continue;
      }
      const args = Array.isArray(value.args)
        ? value.args.filter((a): a is string => typeof a === 'string' && !a.includes('\0')).slice(0, 20)
        : [];
      commands[name] = { command, args, timeoutSec: pickNumber(value.timeoutSec, 120, 5, 600) };
    }
  }
  return { allowCommands: pickBool(r.allowCommands, false), commands };
}

/**
 * Merge an untrusted object (usually parsed JSON) onto defaults. Unknown or
 * wrongly typed values are replaced by defaults and reported in `warnings`.
 */
export function normalizeConfig(raw: unknown): { config: ChimeraConfig; warnings: string[] } {
  const base = defaultConfig();
  const warnings: string[] = [];
  if (!isRecord(raw)) {
    return { config: base, warnings: ['config is not an object; defaults were used'] };
  }
  const preset = ['lite', 'standard', 'research'].includes(String(raw.preset)) ? (raw.preset as Preset) : base.preset;
  const sandbox: SandboxMode = raw.defaultSandbox === 'workspace-write' ? 'workspace-write' : 'read-only';
  const multi = isRecord(raw.multiAi) ? raw.multiAi : {};
  const agents = isRecord(raw.agents) ? raw.agents : {};
  const local = isRecord(agents.local) ? agents.local : {};
  const opt = isRecord(raw.optimization) ? raw.optimization : {};
  const loop = isRecord(opt.loopGuard) ? opt.loopGuard : {};
  const gui = isRecord(raw.gui) ? raw.gui : {};

  const mainAgent = ['codex', 'claude', 'local'].includes(String(multi.mainAgent))
    ? (multi.mainAgent as AgentKey)
    : base.multiAi.mainAgent;
  const mode = ['manual', 'review', 'auto'].includes(String(multi.mode)) ? (multi.mode as CollabMode) : base.multiAi.mode;

  const tools: ToolEntry[] = Array.isArray(opt.tools)
    ? opt.tools
        .filter(isRecord)
        .filter((t) => typeof t.name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(t.name))
        .map((t) => ({
          name: t.name as string,
          description: pickString(t.description, ''),
          state: (['ACTIVE', 'DORMANT', 'QUARANTINED', 'DISABLED'].includes(String(t.state)) ? t.state : 'ACTIVE') as ToolState,
        }))
    : [];

  const config: ChimeraConfig = {
    version: 1,
    preset,
    setupCompleted: pickBool(raw.setupCompleted, false),
    workspaceRoot: pickString(raw.workspaceRoot, base.workspaceRoot),
    defaultSandbox: sandbox,
    allowSubagents: pickBool(raw.allowSubagents, false),
    multiAi: {
      enabled: pickBool(multi.enabled, base.multiAi.enabled),
      mainAgent,
      mode,
      maxCalls: pickNumber(multi.maxCalls, base.multiAi.maxCalls, 1, 10),
      maxDepth: pickNumber(multi.maxDepth, base.multiAi.maxDepth, 0, 3),
      // A config written before v0.3 has no maxHandoffs. It then keeps the limit it had: v0.2.1 counted
      // handoffs against maxDepth, so that value is the safe starting point.
      maxHandoffs: pickNumber(multi.maxHandoffs, typeof multi.maxDepth === 'number' ? multi.maxDepth : base.multiAi.maxHandoffs, 0, 5),
      handoffContextMaxChars: pickNumber(multi.handoffContextMaxChars, base.multiAi.handoffContextMaxChars, 1000, 20000),
      smartDispatch: pickSmartDispatch(multi.smartDispatch),
    },
    verification: pickVerification(raw.verification),
    agents: {
      codex: pickAgentSettings(agents.codex, base.agents.codex),
      claude: pickAgentSettings(agents.claude, base.agents.claude),
      local: {
        ...pickAgentSettings(local, base.agents.local),
        baseUrl: pickString(local.baseUrl, base.agents.local.baseUrl),
        apiKeyEnv: pickStringOrNull(local.apiKeyEnv, null),
      },
    },
    optimization: {
      loopGuard: {
        enabled: pickBool(loop.enabled, base.optimization.loopGuard.enabled),
        maxRetries: pickNumber(loop.maxRetries, base.optimization.loopGuard.maxRetries, 0, 5),
        stopAfterSameErrors: pickNumber(loop.stopAfterSameErrors, base.optimization.loopGuard.stopAfterSameErrors, 2, 10),
      },
      tools,
    },
    gui: { port: pickNumber(gui.port, base.gui.port, 1024, 65535) },
  };
  return { config, warnings };
}

export interface LoadResult {
  config: ChimeraConfig;
  warnings: string[];
  source: 'file' | 'backup' | 'defaults';
}

/**
 * Load the config. If the file is corrupt, the previous backup is used and
 * the corrupt file is kept next to it for inspection. Nothing is deleted.
 */
/**
 * Load the config. `readOnly` makes it a pure read: a damaged file is still replaced by the backup or defaults in
 * memory, but no `.corrupt` copy is written. Servers that only answer questions (MCP) use it.
 */
export function loadConfig(path: string = configPath(), options: { readOnly?: boolean } = {}): LoadResult {
  if (!existsSync(path)) {
    return { config: defaultConfig(), warnings: [], source: 'defaults' };
  }
  const tryParse = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8')) as unknown;
  try {
    const parsed = tryParse(path);
    const { config, warnings } = normalizeConfig(parsed);
    return { config, warnings, source: 'file' };
  } catch (err) {
    const backup = `${path}.bak`;
    const corrupt = `${path}.corrupt`;
    const reason = err instanceof Error ? err.message : String(err);
    if (existsSync(backup)) {
      try {
        const { config, warnings } = normalizeConfig(tryParse(backup));
        if (options.readOnly !== true) {
          copyFileSync(path, corrupt);
        }
        return {
          config,
          warnings: [`config.json was unreadable (${reason}); restored from config.json.bak`, ...warnings],
          source: 'backup',
        };
      } catch {
        // Fall through: the backup is unreadable too.
      }
    }
    if (options.readOnly !== true) {
      copyFileSync(path, corrupt);
    }
    return {
      config: defaultConfig(),
      warnings: [`config.json was unreadable (${reason}) and no usable backup exists; defaults were used`],
      source: 'defaults',
    };
  }
}

/**
 * Save atomically: write a temp file, keep the previous file as `.bak`, then rename.
 * A crash mid-write leaves either the old or the new file, never a partial one.
 */
export function saveConfig(config: ChimeraConfig, path: string = configPath()): void {
  const { config: normalized, warnings } = normalizeConfig(config);
  if (warnings.length > 0) {
    throw new ConfigError(`Invalid config: ${warnings.join('; ')}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  if (existsSync(path)) {
    copyFileSync(path, `${path}.bak`);
  }
  renameSync(tmp, path);
}
