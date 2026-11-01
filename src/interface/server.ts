import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import {
  applyPreset,
  loadConfig,
  normalizeConfig,
  saveConfig,
  type AgentKey,
  type ChimeraConfig,
  type Preset,
  type ToolState,
} from '../core/config.js';
import { readRecords } from '../core/history.js';
import type { Evidence } from '../core/evidence.js';
import { tokenEconomizerStatus } from '../integrations/token-economizer.js';
import { INSTRUCTION_MAX, loadPassport } from '../core/passport.js';
import { harness2Availability } from '../improvement/harness2.js';
import { packageRoot } from '../core/paths.js';
import { setToolState, TOOL_STATES } from '../optimization/dormancy.js';
import type { OrchestrateOutput } from '../orchestrator/orchestrator.js';
import {
  clearDetectionCache,
  costSummary,
  availabilityFrom,
  decideTask,
  handoffOverview,
  handoffTask,
  prepareHandoff,
  savePassportFor,
  detectAgents,
  runSetupChecks,
  setupCanComplete,
  startTask,
  systemInfo,
  type TaskHandle,
  dispatchPreview,
} from './service.js';

const MAX_BODY = 1024 * 1024;
const LOG_LIMIT = 300;

/** Task runs started in this server process. History on disk holds the durable record. */
const runs = new Map<string, RunState>();

interface RunState {
  groupId: string;
  status: 'running' | 'done' | 'cancelled' | 'error';
  startedAt: string;
  logs: string[];
  output: OrchestrateOutput | null;
  error: string | null;
  controller: AbortController;
}

export interface RunningServer {
  url: string;
  token: string;
  close: () => Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) {
      throw new HttpError(413, 'Request body is too large.');
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) {
    return false;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const AGENT_KEYS: AgentKey[] = ['codex', 'claude', 'local'];

/** The optional instruction for the next agent: a string up to INSTRUCTION_MAX, or absent. */
function readInstruction(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.length > INSTRUCTION_MAX) {
    throw new HttpError(400, `instruction must be a string of at most ${INSTRUCTION_MAX} characters.`);
  }
  return value;
}
const SANDBOXES = ['read-only', 'workspace-write'] as const;

function loadOrThrow(): ChimeraConfig {
  return loadConfig().config;
}

function persist(config: ChimeraConfig): void {
  saveConfig(config);
  clearDetectionCache();
}

async function availability(config: ChimeraConfig): Promise<Record<AgentKey, boolean>> {
  return availabilityFrom(await detectAgents(config));
}

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, method: string, url: URL): Promise<void> {
  if (method === 'GET' && path === '/api/status') {
    const loaded = loadConfig();
    const detections = await detectAgents(loaded.config);
    const checks = runSetupChecks(loaded.config, detections);
    json(res, 200, {
      system: systemInfo(),
      config: loaded.config,
      configSource: loaded.source,
      configWarnings: loaded.warnings,
      detections,
      checks,
      setupCanComplete: setupCanComplete(checks),
      tokenEconomizer: [
        tokenEconomizerStatus('claude', detections.claude.version),
        tokenEconomizerStatus('codex', detections.codex.version),
      ],
      harness2: await harness2Availability(),
    });
    return;
  }

  if (method === 'GET' && path === '/api/config') {
    const loaded = loadConfig();
    json(res, 200, { config: loaded.config, source: loaded.source, warnings: loaded.warnings });
    return;
  }

  if (method === 'PUT' && path === '/api/config') {
    const body = await readJson(req);
    if (!isObject(body) || !isObject(body.config)) {
      throw new HttpError(400, 'Expected { "config": { ... } }.');
    }
    const current = loadOrThrow();
    const { config, warnings } = normalizeConfig(body.config);
    // Setup completion is only set by /api/setup/complete, never by editing the config.
    config.setupCompleted = current.setupCompleted;
    if (warnings.length > 0) {
      throw new HttpError(400, 'Config has invalid fields.', warnings);
    }
    persist(config);
    json(res, 200, { config });
    return;
  }

  if (method === 'POST' && path === '/api/setup/preset') {
    const body = await readJson(req);
    const preset = isObject(body) ? body.preset : undefined;
    if (preset !== 'lite' && preset !== 'standard' && preset !== 'research') {
      throw new HttpError(400, 'preset must be lite, standard or research.');
    }
    const next = applyPreset(loadOrThrow(), preset as Preset);
    persist(next);
    json(res, 200, { config: next });
    return;
  }

  if (method === 'POST' && path === '/api/setup/check') {
    const config = loadOrThrow();
    const checks = runSetupChecks(config, await detectAgents(config, true));
    json(res, 200, { checks, canComplete: setupCanComplete(checks) });
    return;
  }

  if (method === 'POST' && path === '/api/setup/complete') {
    const config = loadOrThrow();
    const checks = runSetupChecks(config, await detectAgents(config, true));
    if (!setupCanComplete(checks)) {
      json(res, 409, { error: 'Setup has errors. Fix them and check again.', checks, canComplete: false });
      return;
    }
    const next = { ...config, setupCompleted: true };
    persist(next);
    json(res, 200, { config: next, checks, canComplete: true });
    return;
  }

  if (method === 'POST' && path === '/api/tools/state') {
    const body = await readJson(req);
    if (!isObject(body) || typeof body.name !== 'string' || typeof body.state !== 'string') {
      throw new HttpError(400, 'Expected { "name", "state" }.');
    }
    if (!TOOL_STATES.includes(body.state as ToolState)) {
      throw new HttpError(400, `state must be one of ${TOOL_STATES.join(', ')}.`);
    }
    const config = loadOrThrow();
    try {
      const tools = setToolState(config.optimization.tools, body.name, body.state as ToolState);
      const next = { ...config, optimization: { ...config.optimization, tools } };
      persist(next);
      json(res, 200, { tools });
    } catch (err) {
      throw new HttpError(404, err instanceof Error ? err.message : 'Tool not found.');
    }
    return;
  }

  if (method === 'POST' && path === '/api/tasks') {
    const body = await readJson(req);
    if (!isObject(body)) {
      throw new HttpError(400, 'Expected a JSON object.');
    }
    const config = loadOrThrow();
    if (!config.setupCompleted) {
      throw new HttpError(409, 'Setup is not complete. Open the setup screen first.');
    }
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (prompt === '' || prompt.length > 20000) {
      throw new HttpError(400, 'prompt must be 1 to 20000 characters.');
    }
    const kind = body.kind === undefined || body.kind === null || body.kind === '' ? null : String(body.kind);
    if (kind !== null && !/^[a-z0-9-]{1,32}$/.test(kind)) {
      throw new HttpError(400, 'kind must be lowercase letters, digits or hyphens.');
    }
    const agent = body.agent === undefined ? undefined : (body.agent as AgentKey);
    if (agent !== undefined && !AGENT_KEYS.includes(agent)) {
      throw new HttpError(400, 'Unknown agent.');
    }
    const sandbox = body.sandbox === undefined ? config.defaultSandbox : body.sandbox;
    if (!SANDBOXES.includes(sandbox as (typeof SANDBOXES)[number])) {
      throw new HttpError(400, 'sandbox must be read-only or workspace-write.');
    }
    const timeoutSec = body.timeoutSec === undefined ? undefined : Number(body.timeoutSec);
    if (timeoutSec !== undefined && (!Number.isFinite(timeoutSec) || timeoutSec < 5 || timeoutSec > 3600)) {
      throw new HttpError(400, 'timeoutSec must be between 5 and 3600.');
    }
    const cwd = typeof body.cwd === 'string' ? body.cwd : undefined;

    const groupId = randomUUID();
    const controller = new AbortController();
    const state: RunState = {
      groupId,
      status: 'running',
      startedAt: new Date().toISOString(),
      logs: [],
      output: null,
      error: null,
      controller,
    };
    // Registered before the task starts, because agents log synchronously during startup.
    runs.set(groupId, state);
    const available = await availability(config);
    let handle: TaskHandle;
    try {
      handle = startTask(
        config,
        { prompt, kind, cwd, agent, sandbox: sandbox as (typeof SANDBOXES)[number], timeoutSec },
        groupId,
        controller.signal,
        (line) => {
          state.logs.push(line);
          if (state.logs.length > LOG_LIMIT) {
            state.logs.splice(0, state.logs.length - LOG_LIMIT);
          }
        },
        available,
      );
    } catch (err) {
      runs.delete(groupId);
      throw new HttpError(400, err instanceof Error ? err.message : 'Could not start the task.');
    }
    handle.done
      .then((output) => {
        state.output = output;
        state.status = output.final.status === 'cancelled' ? 'cancelled' : 'done';
      })
      .catch((err: unknown) => {
        state.status = 'error';
        state.error = err instanceof Error ? err.message : String(err);
      });
    json(res, 202, { groupId });
    return;
  }

  const runMatch = /^\/api\/tasks\/([0-9a-f-]{36})(\/cancel)?$/.exec(path);
  if (runMatch) {
    const state = runs.get(runMatch[1]);
    if (!state) {
      throw new HttpError(404, 'Task not found in this session.');
    }
    if (runMatch[2] && method === 'POST') {
      state.controller.abort();
      json(res, 202, { groupId: state.groupId, cancelRequested: true });
      return;
    }
    if (method === 'GET' && !runMatch[2]) {
      json(res, 200, {
        groupId: state.groupId,
        status: state.status,
        startedAt: state.startedAt,
        logs: state.logs,
        output: state.output,
        error: state.error,
      });
      return;
    }
  }

  if (method === 'POST' && path === '/api/tasks/decision') {
    // Accept or reject is a user action. Nothing in the agent path calls this route.
    const body = await readJson(req);
    if (!isObject(body)) {
      throw new HttpError(400, 'Expected a JSON object.');
    }
    const groupId = typeof body.groupId === 'string' ? body.groupId : '';
    if (!/^[A-Za-z0-9-]{1,64}$/.test(groupId)) {
      throw new HttpError(400, 'groupId is not valid.');
    }
    if (body.action !== 'accept' && body.action !== 'reject') {
      throw new HttpError(400, 'action must be accept or reject.');
    }
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : '';
    const result = decideTask(groupId, body.action, reason, body.override === true);
    if (!result.ok) {
      json(res, 409, { error: result.error });
      return;
    }
    json(res, 200, { evidence: result.evidence });
    return;
  }

  if (method === 'POST' && path === '/api/passports') {
    const body = await readJson(req);
    if (!isObject(body)) {
      throw new HttpError(400, 'Expected a JSON object.');
    }
    const groupId = typeof body.groupId === 'string' ? body.groupId : '';
    if (!/^[0-9a-f-]{36}$/.test(groupId)) {
      throw new HttpError(400, 'groupId is not valid.');
    }
    const saved = await savePassportFor(loadOrThrow(), groupId);
    json(res, saved.ok ? 200 : 404, saved.ok ? { path: saved.path } : { error: saved.error });
    return;
  }

  if (method === 'GET' && path.startsWith('/api/passports/')) {
    const groupId = decodeURIComponent(path.slice('/api/passports/'.length));
    if (!/^[0-9a-f-]{36}$/.test(groupId)) {
      throw new HttpError(400, 'groupId is not valid.');
    }
    const loaded = loadPassport(groupId);
    let handoff: ReturnType<typeof handoffOverview> | null = null;
    if (loaded.passport) {
      const config = loadOrThrow();
      handoff = handoffOverview(config, loaded.passport, readRecords().records, await availability(config));
    }
    json(res, loaded.passport ? 200 : 404, { passport: loaded.passport, errors: loaded.check.errors, handoff });
    return;
  }

  if (method === 'POST' && path === '/api/dispatch/plan') {
    // Dry run of the dispatch rules: reads configuration only and starts no agent.
    const body = await readJson(req);
    const config = loadOrThrow();
    const o = isObject(body) ? body : {};
    const kind = o.kind === undefined || o.kind === null || o.kind === '' ? null : String(o.kind);
    if (kind !== null && !/^[a-z0-9-]{1,32}$/.test(kind)) {
      throw new HttpError(400, 'kind must be lowercase letters, digits or hyphens.');
    }
    const agent = o.agent === undefined ? undefined : (o.agent as AgentKey);
    if (agent !== undefined && !AGENT_KEYS.includes(agent)) {
      throw new HttpError(400, 'Unknown agent.');
    }
    json(res, 200, dispatchPreview(config, { kind, agent, reviewRequested: o.reviewRequested === true }));
    return;
  }

  if (method === 'POST' && path === '/api/handoffs/preview') {
    // Same checks and the same context as a real handoff, but nothing starts, so no confirm flag is needed.
    const body = await readJson(req);
    if (!isObject(body)) {
      throw new HttpError(400, 'Expected a JSON object.');
    }
    const fromGroupId = typeof body.fromGroupId === 'string' ? body.fromGroupId : '';
    if (!/^[0-9a-f-]{36}$/.test(fromGroupId)) {
      throw new HttpError(400, 'fromGroupId is not valid.');
    }
    const to = body.to as AgentKey;
    if (!AGENT_KEYS.includes(to)) {
      throw new HttpError(400, 'to must be codex, claude or local.');
    }
    const instruction = readInstruction(body.instruction);
    const config = loadOrThrow();
    const prepared = prepareHandoff(config, { fromGroupId, to, acceptCurrentState: body.acceptCurrentState === true, timeoutSec: undefined, instruction }, await availability(config));
    if (!prepared.ok) {
      json(res, 200, { started: false, allowed: false, refusal: prepared.error, context: null });
      return;
    }
    const c = prepared.context;
    json(res, 200, {
      started: false,
      allowed: true,
      refusal: null,
      context: { text: c.text, chars: c.chars, sha256: c.sha256, report: c.report, files: c.files, truncated: c.truncated, missing: c.missing, warnings: c.warnings, instructionSource: c.meta.instructionSource },
    });
    return;
  }

  if (method === 'POST' && path === '/api/handoffs') {
    // A handoff starts an agent, so it needs the explicit confirm flag the GUI sends only from its button.
    const body = await readJson(req);
    if (!isObject(body)) {
      throw new HttpError(400, 'Expected a JSON object.');
    }
    if (body.confirm !== true) {
      throw new HttpError(400, 'A handoff starts an agent. Send "confirm": true to run it.');
    }
    const fromGroupId = typeof body.fromGroupId === 'string' ? body.fromGroupId : '';
    if (!/^[0-9a-f-]{36}$/.test(fromGroupId)) {
      throw new HttpError(400, 'fromGroupId is not valid.');
    }
    const to = body.to as AgentKey;
    if (!AGENT_KEYS.includes(to)) {
      throw new HttpError(400, 'to must be codex, claude or local.');
    }
    const timeoutSec = body.timeoutSec === undefined ? undefined : Number(body.timeoutSec);
    if (timeoutSec !== undefined && (!Number.isFinite(timeoutSec) || timeoutSec < 5 || timeoutSec > 3600)) {
      throw new HttpError(400, 'timeoutSec must be between 5 and 3600.');
    }
    const instruction = readInstruction(body.instruction);
    const config = loadOrThrow();
    if (!config.setupCompleted) {
      throw new HttpError(409, 'Setup is not complete. Open the setup screen first.');
    }
    const groupId = randomUUID();
    const controller = new AbortController();
    const state: RunState = { groupId, status: 'running', startedAt: new Date().toISOString(), logs: [], output: null, error: null, controller };
    runs.set(groupId, state);
    const started = handoffTask(
      config,
      { fromGroupId, to, acceptCurrentState: body.acceptCurrentState === true, timeoutSec, instruction },
      groupId,
      controller.signal,
      (line) => {
        state.logs.push(line);
        if (state.logs.length > LOG_LIMIT) {
          state.logs.splice(0, state.logs.length - LOG_LIMIT);
        }
      },
      await availability(config),
    );
    if (!started.ok) {
      runs.delete(groupId);
      json(res, 409, { error: started.error });
      return;
    }
    started.handle.done
      .then((output) => {
        state.output = output;
        state.status = output.final.status === 'cancelled' ? 'cancelled' : 'done';
      })
      .catch((err: unknown) => {
        state.status = 'error';
        state.error = err instanceof Error ? err.message : String(err);
      });
    const c = started.context;
    json(res, 202, { groupId, context: { chars: c.chars, sha256: c.sha256, report: c.report, truncated: c.truncated, missing: c.missing, warnings: c.warnings, instructionSource: c.meta.instructionSource } });
    return;
  }

  if (method === 'GET' && path === '/api/history') {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
    const read = readRecords();
    // The current evidence per task (the last record that carries evidence, the same rule the CLI uses),
    // so a row never shows an older acceptance after a decision has been recorded.
    const latest: Record<string, Evidence> = {};
    for (const r of read.records) {
      if (r.evidence) {
        latest[r.groupId] = r.evidence;
      }
    }
    json(res, 200, { records: read.records.slice(-limit).reverse(), skippedLines: read.skippedLines, total: read.records.length, latest });
    return;
  }

  if (method === 'GET' && path === '/api/cost') {
    const hoursParam = url.searchParams.get('hours');
    const hours = hoursParam === null ? null : Math.max(1, Number(hoursParam) || 24);
    json(res, 200, { hours, agents: costSummary(hours) });
    return;
  }

  throw new HttpError(404, 'Not found.');
}

export function startServer(port: number, existingToken?: string): Promise<RunningServer> {
  const token = existingToken ?? randomBytes(24).toString('base64url');
  const html = readFileSync(join(packageRoot(), 'web', 'index.html'), 'utf8').replace('__CHIMERA_TOKEN__', token);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const server: Server = createServer((req, res) => {
    const handle = async (): Promise<void> => {
      const host = req.headers.host ?? '';
      if (!allowedHosts.has(host)) {
        throw new HttpError(403, 'Host header not allowed.');
      }
      const url = new URL(req.url ?? '/', `http://${host}`);
      const method = req.method ?? 'GET';
      if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
        });
        res.end(html);
        return;
      }
      if (!url.pathname.startsWith('/api/')) {
        throw new HttpError(404, 'Not found.');
      }
      if (!tokenMatches(req.headers['x-chimera-token'] as string | undefined, token)) {
        throw new HttpError(401, 'Missing or wrong session token. Open ORNELYON from the link printed in the terminal.');
      }
      await handleApi(req, res, url.pathname, method, url);
    };
    handle().catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        json(res, err.status, { error: err.message, details: err.details ?? null });
        return;
      }
      // Unexpected errors are reported without a stack trace, so no file paths leak to the browser.
      json(res, 500, { error: err instanceof Error ? err.message : 'Unexpected error.' });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({
        url: `http://127.0.0.1:${port}/?token=${token}`,
        token,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

