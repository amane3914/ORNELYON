import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { createServer as createHttpServer, request as httpRequest, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultConfig, loadConfig, saveConfig, type ChimeraConfig } from '../core/config.js';
import { appendRecord, readRecords, type RunRecord } from '../core/history.js';
import { historyPath } from '../core/paths.js';
import { initialEvidence } from '../core/evidence.js';
import { passportPath } from '../core/passport.js';
import { startServer, type RunningServer } from '../interface/server.js';

/*
 * HTTP integration tests. The real server listens on 127.0.0.1 and talks through its routes.
 * The only fake is the agent: a localhost OpenAI-style server that the real local-LLM adapter calls.
 * Nothing leaves the machine and no paid service is used. The data folder is a temporary one.
 */

interface Reply {
  status: number;
  body: string;
  json: unknown;
}

let fakeLlm: HttpServer;
let fakeLlmUrl = '';
const llmCalls: string[] = [];

let srv: RunningServer;
let port = 0;
let home = '';
let root = '';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe: NetServer = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const p = typeof addr === 'object' && addr !== null ? addr.port : 0;
      probe.close(() => resolve(p));
    });
  });
}

/** Stands in for a local OpenAI-compatible server. A prompt containing SLOW gets a reply after 8 s. */
function startFakeLlm(): Promise<void> {
  return new Promise((resolve) => {
    fakeLlm = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
        return;
      }
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString('utf8');
      });
      req.on('end', () => {
        llmCalls.push(body);
        const slow = body.includes('SLOW');
        const timer = setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ model: 'fake-model', choices: [{ message: { role: 'assistant', content: 'hello from the fake local model' } }], usage: { prompt_tokens: 4, completion_tokens: 3 } }));
        }, slow ? 8000 : 0);
        // Stop the delay only when the client has gone. The request's own 'close' fires once the body is read.
        res.on('close', () => clearTimeout(timer));
      });
    });
    fakeLlm.listen(0, '127.0.0.1', () => {
      const addr = fakeLlm.address();
      const p = typeof addr === 'object' && addr !== null ? addr.port : 0;
      fakeLlmUrl = `http://127.0.0.1:${p}/v1`;
      resolve();
    });
  });
}

function baseConfig(): ChimeraConfig {
  const c = defaultConfig();
  c.setupCompleted = true;
  c.workspaceRoot = root;
  c.multiAi.enabled = false;
  c.multiAi.mainAgent = 'local';
  c.agents.local.enabled = true;
  c.agents.local.baseUrl = fakeLlmUrl;
  c.agents.local.apiKeyEnv = null;
  c.agents.local.model = 'fake-model';
  c.agents.local.timeoutSec = 5;
  return c;
}

function call(method: string, path: string, opts: { body?: unknown; raw?: string; token?: string | null; host?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    const headers: Record<string, string> = {};
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const token = opts.token === undefined ? srv.token : opts.token;
    if (token !== null) {
      headers['x-chimera-token'] = token;
    }
    if (opts.host !== undefined) {
      headers.host = opts.host;
    }
    // A fresh connection per call: a pooled one can be closed by the server's idle timeout just as it is reused (ECONNRESET).
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => {
        text += c.toString('utf8');
      });
      res.on('end', () => {
        let json: unknown = null;
        try {
          json = JSON.parse(text) as unknown;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, body: text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForRun(groupId: string, timeoutMs = 20000): Promise<{ status: string; output: { final: { status: string } } | null; error: string | null }> {
  const started = Date.now();
  for (;;) {
    const r = await call('GET', `/api/tasks/${groupId}`);
    const body = r.json as { status: string; output: { final: { status: string } } | null; error: string | null };
    if (body.status !== 'running') {
      return body;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`run ${groupId} did not finish in time`);
    }
    await sleep(100);
  }
}

/** A finished task in history, as the orchestrator and service would leave it. */
function seedTask(opts: { groupId: string; execution?: 'SUCCESS' | 'FAILED' | 'CANCELLED'; verificationRequired?: boolean; checks?: boolean }): void {
  const now = new Date().toISOString();
  const status = opts.execution === 'FAILED' ? 'failed' : opts.execution === 'CANCELLED' ? 'cancelled' : 'success';
  const result = {
    taskId: randomUUID(),
    agent: 'local',
    status,
    output: 'seeded answer',
    model: null,
    errorKind: null,
    errorMessage: opts.execution === 'FAILED' ? 'seeded failure' : null,
    errorSignature: null,
    usage: { inputTokens: null, outputTokens: null },
    costUsd: null,
    startedAt: now,
    durationMs: 1,
  } as RunRecord['result'];
  const evidence = initialEvidence({
    status,
    sandbox: 'read-only',
    verificationRequired: opts.verificationRequired ?? false,
    checks: opts.checks ? [{ name: 'tests', kind: 'command', result: 'UNVERIFIED', detail: 'not run' }] : [],
    changedFiles: [],
  });
  const base: RunRecord = { recordedAt: now, role: 'task', groupId: opts.groupId, mode: 'L0', kind: null, prompt: 'Seeded task', result };
  appendRecord(base, historyPath());
  appendRecord({ ...base, role: 'summary', evidence, notes: [] }, historyPath());
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'ornelyon-api-'));
  root = join(home, 'workspace');
  mkdirSync(root, { recursive: true });
  process.env.ORNELYON_HOME = home;
  delete process.env.CHIMERA_HOME;
  await startFakeLlm();
  saveConfig(baseConfig(), join(home, 'config.json'));
  port = await freePort();
  srv = await startServer(port);
});

after(async () => {
  await srv?.close();
  fakeLlm?.closeAllConnections();
  await new Promise<void>((resolve) => fakeLlm.close(() => resolve()));
});

// ---------- security boundary ----------

test('API: every /api route needs the session token; GET / (the page) does not', async () => {
  assert.equal((await call('GET', '/api/config', { token: null })).status, 401);
  assert.equal((await call('GET', '/api/config', { token: 'wrong-token-value' })).status, 401);
  assert.equal((await call('POST', '/api/tasks/decision', { token: null, body: { groupId: 'x', action: 'accept' } })).status, 401);
  const ok = await call('GET', '/api/config');
  assert.equal(ok.status, 200);
  const page = await call('GET', '/', { token: null });
  assert.equal(page.status, 200);
  assert.match(page.body, /ORNELYON Setup/);
  assert.ok(page.body.includes(srv.token), 'the page carries the token for its own API calls');
});

test('API: a request with a foreign Host header is refused before the token is checked', async () => {
  const r = await call('GET', '/api/config', { host: 'evil.example' });
  assert.equal(r.status, 403);
  assert.match(r.body, /Host header not allowed/);
});

test('API: unknown API routes return 404 with a short message and no stack trace', async () => {
  const r = await call('POST', '/api/handoff', { body: {} });
  assert.equal(r.status, 404);
  assert.doesNotMatch(r.body, /at |node:/);
});

// ---------- request validation ----------

test('API decision: malformed JSON, missing fields and unknown actions are rejected with 400', async () => {
  const bad = await call('POST', '/api/tasks/decision', { raw: '{"groupId": ' });
  assert.equal(bad.status, 400);
  assert.match(bad.body, /not valid JSON/);

  const noGroup = await call('POST', '/api/tasks/decision', { body: { action: 'accept', reason: 'x' } });
  assert.equal(noGroup.status, 400);
  assert.match(noGroup.body, /groupId is not valid/);

  const badAction = await call('POST', '/api/tasks/decision', { body: { groupId: 'g-1', action: 'approve', reason: 'x' } });
  assert.equal(badAction.status, 400);
  assert.match(badAction.body, /action must be accept or reject/);

  const notObject = await call('POST', '/api/tasks/decision', { raw: '[1,2]' });
  assert.equal(notObject.status, 400);
});

test('API decision: a task that does not exist is refused with 409 and nothing is written', async () => {
  const before = readRecords().records.length;
  const r = await call('POST', '/api/tasks/decision', { body: { groupId: 'does-not-exist', action: 'accept', reason: 'x' } });
  assert.equal(r.status, 409);
  assert.equal((r.json as { error: string }).error, 'No such task.');
  assert.equal(readRecords().records.length, before);
});

test('API passport: invalid ids are 400, unknown tasks are 404, and a path-like id never reaches the file system', async () => {
  const bad = await call('POST', '/api/passports', { body: { groupId: '../../etc' } });
  assert.equal(bad.status, 400);
  const unknown = await call('POST', '/api/passports', { body: { groupId: randomUUID() } });
  assert.equal(unknown.status, 404);
  assert.equal((unknown.json as { error: string }).error, 'No such task.');
  const traversal = await call('GET', '/api/passports/..%2F..%2Fetc%2Fpasswd');
  assert.equal(traversal.status, 400);
});

// ---------- decision rules over HTTP ----------

test('API decision: an unverified required check blocks accept; override is recorded and does not turn UNVERIFIED into PASS', async () => {
  const g = randomUUID();
  seedTask({ groupId: g, verificationRequired: true });

  const blocked = await call('POST', '/api/tasks/decision', { body: { groupId: g, action: 'accept', reason: 'looks right' } });
  assert.equal(blocked.status, 409);
  assert.match((blocked.json as { error: string }).error, /required verification was not completed/);

  const overridden = await call('POST', '/api/tasks/decision', { body: { groupId: g, action: 'accept', reason: 'checked by hand', override: true } });
  assert.equal(overridden.status, 200);
  const ev = (overridden.json as { evidence: { acceptance: string; verification: string; overrideUsed: boolean; execution: string } }).evidence;
  assert.equal(ev.acceptance, 'ACCEPTED');
  assert.equal(ev.overrideUsed, true);
  assert.equal(ev.verification, 'UNVERIFIED', 'an override never changes the verification result');
  assert.equal(ev.execution, 'SUCCESS');

  const decisions = readRecords().records.filter((r) => r.groupId === g && r.role === 'decision');
  assert.equal(decisions.length, 1);
  assert.ok(decisions[0].notes?.some((n) => /override/.test(n)), 'the override is written to history');
});

test('API decision: a task whose execution did not succeed cannot be accepted even with override', async () => {
  const failed = randomUUID();
  seedTask({ groupId: failed, execution: 'FAILED' });
  const r1 = await call('POST', '/api/tasks/decision', { body: { groupId: failed, action: 'accept', reason: 'x', override: true } });
  assert.equal(r1.status, 409);
  assert.match((r1.json as { error: string }).error, /execution is FAILED/);

  const cancelled = randomUUID();
  seedTask({ groupId: cancelled, execution: 'CANCELLED' });
  const r2 = await call('POST', '/api/tasks/decision', { body: { groupId: cancelled, action: 'accept', reason: 'x', override: true } });
  assert.equal(r2.status, 409);
  assert.match((r2.json as { error: string }).error, /execution is CANCELLED/);
});

test('API decision: reject needs a reason, is recorded, and the evidence read back shows it', async () => {
  const g = randomUUID();
  seedTask({ groupId: g });
  const noReason = await call('POST', '/api/tasks/decision', { body: { groupId: g, action: 'reject', reason: '   ' } });
  assert.equal(noReason.status, 409);
  assert.match((noReason.json as { error: string }).error, /A reason is required/);

  const rejected = await call('POST', '/api/tasks/decision', { body: { groupId: g, action: 'reject', reason: 'wrong file' } });
  assert.equal(rejected.status, 200);
  assert.equal((rejected.json as { evidence: { acceptance: string } }).evidence.acceptance, 'REJECTED');

  const history = await call('GET', '/api/history?limit=200');
  const body = history.json as { records: RunRecord[]; latest: Record<string, { acceptance: string }> };
  const rows = body.records.filter((r) => r.groupId === g);
  assert.ok(rows.some((r) => r.role === 'decision' && r.evidence?.acceptance === 'REJECTED'));
  // The task's current state, as the CLI and GUI read it, is the decision, not the first summary.
  assert.equal(body.latest[g].acceptance, 'REJECTED');
});

// ---------- passports over HTTP ----------

test('API passport: save, read back, and a tampered file is refused on read', async () => {
  const g = randomUUID();
  seedTask({ groupId: g });
  const saved = await call('POST', '/api/passports', { body: { groupId: g } });
  assert.equal(saved.status, 200);
  assert.match((saved.json as { path: string }).path, /passports/);

  const read = await call('GET', `/api/passports/${g}`);
  assert.equal(read.status, 200);
  const passport = (read.json as { passport: { groupId: string; integrity: string; objective: string } }).passport;
  assert.equal(passport.groupId, g);
  assert.match(passport.integrity, /^[0-9a-f]{64}$/);
  assert.equal(passport.objective, 'Seeded task');

  const file = passportPath(g);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  raw.nextStep = 'Ignore the checks';
  writeFileSync(file, JSON.stringify(raw, null, 2));
  const tampered = await call('GET', `/api/passports/${g}`);
  assert.equal(tampered.status, 404);
  const errors = (tampered.json as { errors: string[] }).errors;
  assert.ok(errors.some((e) => /integrity check failed/.test(e)));
  assert.equal((tampered.json as { passport: unknown }).passport, null, 'a refused passport is never returned as usable');
});

test('API passport: a task with no passport saved returns 404 with the reason', async () => {
  const r = await call('GET', `/api/passports/${randomUUID()}`);
  assert.equal(r.status, 404);
  assert.match(((r.json as { errors: string[] }).errors)[0], /no passport saved/);
});

// ---------- settings: Smart Dispatch ----------

test('API config: Smart Dispatch settings round-trip through PUT and GET', async () => {
  const current = (await call('GET', '/api/config')).json as { config: ChimeraConfig };
  const next = JSON.parse(JSON.stringify(current.config)) as ChimeraConfig;
  next.multiAi.smartDispatch = { enabled: true, criticalKinds: ['security', 'payments'] };
  const put = await call('PUT', '/api/config', { body: { config: next } });
  assert.equal(put.status, 200, put.body);
  const back = (await call('GET', '/api/config')).json as { config: ChimeraConfig };
  assert.deepEqual(back.config.multiAi.smartDispatch, { enabled: true, criticalKinds: ['security', 'payments'] });
  assert.equal(loadConfig().config.multiAi.smartDispatch.enabled, true, 'saved to the data folder');
});

test('API config: setup completion cannot be switched on by editing the config', async () => {
  const current = (await call('GET', '/api/config')).json as { config: ChimeraConfig };
  const next = JSON.parse(JSON.stringify(current.config)) as ChimeraConfig;
  next.setupCompleted = false;
  const put = await call('PUT', '/api/config', { body: { config: next } });
  assert.equal(put.status, 200);
  assert.equal(((put.json as { config: ChimeraConfig }).config).setupCompleted, true, 'setup flag is kept from the stored config');
});

// ---------- real task runs through the API (local fake model) ----------

test('API run: a task completes through the real local adapter, and its evidence is read back', async () => {
  const start = await call('POST', '/api/tasks', { body: { prompt: 'Say hello', agent: 'local' } });
  assert.equal(start.status, 202);
  const groupId = (start.json as { groupId: string }).groupId;
  const done = await waitForRun(groupId);
  assert.equal(done.status, 'done');
  assert.equal(done.output?.final.status, 'success');
  assert.ok(llmCalls.some((b) => b.includes('Say hello')), 'the fake model received the prompt');

  const history = (await call('GET', '/api/history?limit=200')).json as { records: RunRecord[] };
  const summary = history.records.find((r) => r.groupId === groupId && r.role === 'summary');
  assert.ok(summary, 'summary written to history');
  assert.equal(summary.evidence?.execution, 'SUCCESS');
  assert.equal(summary.evidence?.verification, 'NOT_RUN');
});

test('API run: cancelling a running task stops it and records CANCELLED, which cannot be accepted', async () => {
  const start = await call('POST', '/api/tasks', { body: { prompt: 'SLOW question', agent: 'local' } });
  const groupId = (start.json as { groupId: string }).groupId;
  await sleep(300);
  const cancel = await call('POST', `/api/tasks/${groupId}/cancel`, { body: {} });
  assert.equal(cancel.status, 202);
  const done = await waitForRun(groupId);
  assert.equal(done.status, 'cancelled');

  const history = (await call('GET', '/api/history?limit=200')).json as { records: RunRecord[] };
  const summary = history.records.find((r) => r.groupId === groupId && r.role === 'summary');
  assert.equal(summary?.evidence?.execution, 'CANCELLED');

  const accept = await call('POST', '/api/tasks/decision', { body: { groupId, action: 'accept', reason: 'x', override: true } });
  assert.equal(accept.status, 409);
  assert.match((accept.json as { error: string }).error, /execution is CANCELLED/);
});

test('API run: a task that exceeds its timeout is recorded as a timeout (FAILED), and cannot be accepted', async () => {
  const start = await call('POST', '/api/tasks', { body: { prompt: 'SLOW question that will time out', agent: 'local' } });
  const groupId = (start.json as { groupId: string }).groupId;
  const done = await waitForRun(groupId, 25000);
  assert.equal(done.output?.final.status, 'timeout');

  const history = (await call('GET', '/api/history?limit=200')).json as { records: RunRecord[] };
  const summary = history.records.find((r) => r.groupId === groupId && r.role === 'summary');
  assert.equal(summary?.evidence?.execution, 'FAILED');

  const accept = await call('POST', '/api/tasks/decision', { body: { groupId, action: 'accept', reason: 'x', override: true } });
  assert.equal(accept.status, 409);
  assert.match((accept.json as { error: string }).error, /execution is FAILED/);
});

test('API run: a task run with bad input is refused with 400 and never reaches an agent', async () => {
  const before = llmCalls.length;
  const empty = await call('POST', '/api/tasks', { body: { prompt: '   ', agent: 'local' } });
  assert.equal(empty.status, 400);
  const badAgent = await call('POST', '/api/tasks', { body: { prompt: 'x', agent: 'shell' } });
  assert.equal(badAgent.status, 400);
  const badSandbox = await call('POST', '/api/tasks', { body: { prompt: 'x', sandbox: 'danger-full-access' } });
  assert.equal(badSandbox.status, 400);
  const badTimeout = await call('POST', '/api/tasks', { body: { prompt: 'x', timeoutSec: 1 } });
  assert.equal(badTimeout.status, 400);
  assert.equal(llmCalls.length, before, 'no model call was made');
});

test('API run: an unknown run id is 404 and a cancel for it does nothing', async () => {
  const r = await call('POST', `/api/tasks/${randomUUID()}/cancel`, { body: {} });
  assert.equal(r.status, 404);
});

test('API: an oversized request body is refused', async () => {
  const big = JSON.stringify({ prompt: 'x'.repeat(1_100_000) });
  const r = await call('POST', '/api/tasks/decision', { raw: big }).catch((err: NodeJS.ErrnoException) => ({ status: 0, body: err.code ?? '', json: null }));
  assert.ok(r.status === 413 || r.status === 0, `expected 413 or a closed connection, got ${r.status}`);
});

// ---------- v0.3: handoff limits, manual handoff and Smart Dispatch preview over HTTP ----------

function withConfig(edit: (c: ChimeraConfig) => void): ChimeraConfig {
  const before = loadConfig().config;
  const next = structuredClone(before);
  edit(next);
  saveConfig(next, join(home, 'config.json'));
  return before;
}

test('API handoff: the passport view reports the chain, the limit and each target verdict', async () => {
  const g = randomUUID();
  seedTask({ groupId: g });
  assert.equal((await call('POST', '/api/passports', { body: { groupId: g } })).status, 200);
  const r = await call('GET', `/api/passports/${g}`);
  assert.equal(r.status, 200);
  const h = (r.json as { handoff: { chain: { count: number; verified: boolean }; maxHandoffs: number; targets: Record<string, { allowed: boolean; refusal: string | null }> } }).handoff;
  assert.equal(h.chain.count, 0);
  assert.equal(h.chain.verified, true);
  assert.equal(h.maxHandoffs, 2);
  assert.equal(h.targets.local.allowed, true);
  assert.equal(h.targets.claude.allowed, false, 'Claude Code is disabled in this test config');
  assert.match(h.targets.claude.refusal ?? '', /disabled/);
});

test('API handoff: needs a token, an explicit confirm, a valid id and a valid target; none of these starts an agent', async () => {
  const g = randomUUID();
  seedTask({ groupId: g });
  await call('POST', '/api/passports', { body: { groupId: g } });
  const calls = llmCalls.length;
  assert.equal((await call('POST', '/api/handoffs', { token: null, body: { fromGroupId: g, to: 'local', confirm: true } })).status, 401);
  assert.equal((await call('POST', '/api/handoffs', { body: { fromGroupId: g, to: 'local' } })).status, 400, 'no confirm');
  assert.equal((await call('POST', '/api/handoffs', { body: { fromGroupId: g, to: 'local', confirm: 'yes' } })).status, 400);
  assert.equal((await call('POST', '/api/handoffs', { body: { fromGroupId: '../x', to: 'local', confirm: true } })).status, 400);
  assert.equal((await call('POST', '/api/handoffs', { body: { fromGroupId: g, to: 'nobody', confirm: true } })).status, 400);
  assert.equal((await call('GET', `/api/passports/${g}`)).status, 200, 'viewing a passport never starts anything');
  assert.equal(llmCalls.length, calls, 'no model call was made');
});

test('API handoff: a confirmed handoff runs the chosen agent once, is recorded in history, and counts toward the limit', async () => {
  const g = randomUUID();
  seedTask({ groupId: g });
  await call('POST', '/api/passports', { body: { groupId: g } });
  const calls = llmCalls.length;
  const started = await call('POST', '/api/handoffs', { body: { fromGroupId: g, to: 'local', confirm: true } });
  assert.equal(started.status, 202, started.body);
  const child = (started.json as { groupId: string }).groupId;
  const done = await waitForRun(child);
  assert.equal(done.status, 'done');
  assert.equal(done.output?.final.status, 'success');
  assert.equal(llmCalls.length, calls + 1, 'exactly one model call');

  const records = readRecords().records.filter((r) => r.groupId === child && r.role === 'summary');
  assert.equal(records.length, 1);
  assert.ok((records[0].notes ?? []).includes(`handoff-from:${g}`));

  await call('POST', '/api/passports', { body: { groupId: child } });
  const view = (await call('GET', `/api/passports/${child}`)).json as { handoff: { chain: { count: number; ancestors: string[] } } };
  assert.equal(view.handoff.chain.count, 1);
  assert.deepEqual(view.handoff.chain.ancestors, [g]);

  const hist = (await call('GET', '/api/history?limit=50')).json as { latest: Record<string, unknown> };
  assert.ok(child in hist.latest, 'the history API shows the new task, so the GUI row and the CLI agree');
});

test('API handoff: the limit is enforced before any agent starts, and a regenerated passport does not reset it', async () => {
  const g0 = randomUUID();
  const g1 = randomUUID();
  seedTask({ groupId: g0 });
  seedTask({ groupId: g1 });
  // Link g1 as a handoff of g0 in history, the way a real handoff leaves it.
  const rec = readRecords().records.filter((r) => r.groupId === g1 && r.role === 'summary')[0];
  appendRecord({ ...rec, notes: [`handoff-from:${g0}`], recordedAt: new Date(Date.now() + 1000).toISOString() }, historyPath());
  const restore = withConfig((c) => {
    c.multiAi.maxHandoffs = 1;
  });
  try {
    for (let i = 0; i < 2; i++) {
      await call('POST', '/api/passports', { body: { groupId: g1 } });
      const calls = llmCalls.length;
      const r = await call('POST', '/api/handoffs', { body: { fromGroupId: g1, to: 'local', confirm: true } });
      assert.equal(r.status, 409);
      assert.match((r.json as { error: string }).error, /Handoff limit reached.*maxHandoffs=1/);
      assert.equal(llmCalls.length, calls);
    }
    const view = (await call('GET', `/api/passports/${g1}`)).json as { handoff: { targets: { local: { allowed: boolean } } } };
    assert.equal(view.handoff.targets.local.allowed, false, 'the preview agrees with the refusal');
  } finally {
    saveConfig(restore, join(home, 'config.json'));
  }
});

test('API handoff: a disabled target and an unknown passport are refused with the reason', async () => {
  const g = randomUUID();
  seedTask({ groupId: g });
  await call('POST', '/api/passports', { body: { groupId: g } });
  const r = await call('POST', '/api/handoffs', { body: { fromGroupId: g, to: 'claude', confirm: true } });
  assert.equal(r.status, 409);
  assert.match((r.json as { error: string }).error, /disabled/);
  const missing = await call('POST', '/api/handoffs', { body: { fromGroupId: randomUUID(), to: 'local', confirm: true } });
  assert.equal(missing.status, 409);
  assert.match((missing.json as { error: string }).error, /Passport refused/);
});

test('API dispatch: the preview starts nothing, and by default needs no extra agent call', async () => {
  const calls = llmCalls.length;
  // Earlier tests may have switched Smart Dispatch on. Start from the shipped defaults.
  const restore = withConfig((c) => {
    c.multiAi.enabled = false;
    c.multiAi.smartDispatch = { enabled: false, criticalKinds: [] };
  });
  try {
  const r = await call('POST', '/api/dispatch/plan', { body: {} });
  assert.equal(r.status, 200);
  const j = r.json as { started: boolean; extraCall: boolean; smartDispatchEnabled: boolean; decision: { action: string; reasons: string[] } };
  assert.equal(j.started, false);
  assert.equal(j.extraCall, false);
  assert.equal(j.smartDispatchEnabled, false);
  assert.equal(j.decision.action, 'NO_CALL');
  assert.ok(j.decision.reasons.length > 0);
  assert.equal((await call('POST', '/api/dispatch/plan', { body: { kind: 'Bad Kind!' } })).status, 400);
  assert.equal((await call('POST', '/api/dispatch/plan', { body: { agent: 'nobody' } })).status, 400);
  assert.equal((await call('POST', '/api/dispatch/plan', { token: null, body: {} })).status, 401);
  } finally {
    saveConfig(restore, join(home, 'config.json'));
  }
  assert.equal(llmCalls.length, calls);
});

test('API dispatch: settings saved through the config API change the preview, and the preview still starts nothing', async () => {
  const calls = llmCalls.length;
  const restore = withConfig((c) => {
    c.multiAi.enabled = true;
    c.multiAi.mode = 'review';
    c.multiAi.smartDispatch = { enabled: true, criticalKinds: ['security'] };
    c.agents.codex.enabled = true;
  });
  try {
    const cfg = (await call('GET', '/api/config')).json as { config: ChimeraConfig };
    assert.equal(cfg.config.multiAi.smartDispatch.enabled, true, 'GUI and Core read the same setting');
    const critical = (await call('POST', '/api/dispatch/plan', { body: { kind: 'security', agent: 'local' } })).json as { extraCall: boolean; decision: { action: string; reviewer: string | null } };
    assert.equal(critical.decision.action, 'REQUIRE_INDEPENDENT_REVIEW');
    assert.equal(critical.decision.reviewer, 'codex');
    assert.equal(critical.extraCall, true);
    const ordinary = (await call('POST', '/api/dispatch/plan', { body: { kind: 'docs', agent: 'local' } })).json as { extraCall: boolean; decision: { action: string } };
    assert.equal(ordinary.decision.action, 'NO_CALL');
    assert.equal(ordinary.extraCall, false);
  } finally {
    saveConfig(restore, join(home, 'config.json'));
  }
  assert.equal(llmCalls.length, calls);
});

test('API config: maxHandoffs round-trips and is independent of maxDepth', async () => {
  const cur = (await call('GET', '/api/config')).json as { config: ChimeraConfig };
  const next = structuredClone(cur.config);
  next.multiAi.maxHandoffs = 3;
  next.multiAi.maxDepth = 0;
  assert.equal((await call('PUT', '/api/config', { body: { config: next } })).status, 200);
  const back = (await call('GET', '/api/config')).json as { config: ChimeraConfig };
  assert.equal(back.config.multiAi.maxHandoffs, 3);
  assert.equal(back.config.multiAi.maxDepth, 0);
  assert.equal((await call('PUT', '/api/config', { body: { config: cur.config } })).status, 200);
});

// ---------- v0.3.1: handoff context over HTTP ----------

test('API handoff context: the preview, the real handoff and the in-process Core call all produce the same text', async () => {
  const g = randomUUID();
  seedTask({ groupId: g });
  await call('POST', '/api/passports', { body: { groupId: g } });
  const calls = llmCalls.length;
  const instruction = 'Check the seeded answer against the file and say if they agree.';
  const pv = await call('POST', '/api/handoffs/preview', { body: { fromGroupId: g, to: 'local', instruction } });
  assert.equal(pv.status, 200);
  const view = pv.json as { allowed: boolean; context: { text: string; sha256: string; chars: number; report: string; instructionSource: string } };
  assert.equal(view.allowed, true);
  assert.equal(llmCalls.length, calls, 'a preview starts nothing');
  assert.match(view.context.text, /seeded answer/);
  assert.match(view.context.text, /\(from the user\) Check the seeded answer/);
  assert.equal(view.context.instructionSource, 'user');

  // The CLI calls the same function in-process.
  const { prepareHandoff } = await import('../interface/service.js');
  const core = prepareHandoff(loadConfig().config, { fromGroupId: g, to: 'local', acceptCurrentState: false, timeoutSec: undefined, instruction }, { codex: false, claude: false, local: true });
  assert.ok(core.ok);
  if (core.ok) {
    assert.equal(core.context.sha256, view.context.sha256);
  }

  const started = await call('POST', '/api/handoffs', { body: { fromGroupId: g, to: 'local', confirm: true, instruction } });
  assert.equal(started.status, 202, started.body);
  const child = (started.json as { groupId: string; context: { sha256: string } }).groupId;
  assert.equal((started.json as { context: { sha256: string } }).context.sha256, view.context.sha256);
  await waitForRun(child);
  assert.equal(llmCalls.length, calls + 1);
  const sent = JSON.parse(llmCalls[llmCalls.length - 1]) as { messages: { content: string }[] };
  assert.ok(sent.messages.some((m) => m.content.includes(view.context.text)), 'the model received exactly the previewed text');
  const rec = readRecords().records.find((r) => r.groupId === child && r.role === 'summary');
  assert.equal(rec?.handoff?.contextSha256, view.context.sha256);
});

test('API handoff context: preview and handoff validate the instruction and need a token; refusals show the reason', async () => {
  const g = randomUUID();
  seedTask({ groupId: g });
  await call('POST', '/api/passports', { body: { groupId: g } });
  const calls = llmCalls.length;
  assert.equal((await call('POST', '/api/handoffs/preview', { token: null, body: { fromGroupId: g, to: 'local' } })).status, 401);
  assert.equal((await call('POST', '/api/handoffs/preview', { body: { fromGroupId: g, to: 'local', instruction: 'x'.repeat(1001) } })).status, 400);
  assert.equal((await call('POST', '/api/handoffs/preview', { body: { fromGroupId: g, to: 'local', instruction: 42 } })).status, 400);
  assert.equal((await call('POST', '/api/handoffs', { body: { fromGroupId: g, to: 'local', confirm: true, instruction: 'x'.repeat(1001) } })).status, 400);
  const refused = (await call('POST', '/api/handoffs/preview', { body: { fromGroupId: g, to: 'claude' } })).json as { allowed: boolean; refusal: string };
  assert.equal(refused.allowed, false);
  assert.match(refused.refusal, /disabled/);
  assert.equal(llmCalls.length, calls);
});
