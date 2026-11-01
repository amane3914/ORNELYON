import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, loadConfig, saveConfig, type ChimeraConfig } from '../core/config.js';
import { appendRecord, readRecords, type RunRecord } from '../core/history.js';
import { initialEvidence, type VerificationCheck } from '../core/evidence.js';
import { historyPath } from '../core/paths.js';
import { diffSnapshots, hashWorkspaceFile, isInsideReal, resolveInsideWorkspace, snapshotGaps, snapshotWorkspace } from '../core/workspace.js';
import { runStateChecks, runVerification, sha256Text } from '../core/verify.js';
import { runResearch } from '../improvement/research.js';
import { LocalLlmAdapter } from '../agents/local-llm.js';
import { buildResult } from '../agents/base.js';
import { createMcpSession } from '../interface/mcp.js';
import { savePassportFor, startTask } from '../interface/service.js';
import { buildRows, cohortStats } from '../optimization/benchmark.js';
import type { AgentAdapter, TaskRequest, TaskResult } from '../core/types.js';
import { FakeAdapter } from './fake-adapter.js';
import { isolatedHome } from './helpers.js';

/*
 * Regression tests for the independent audit of v0.4.1 (F1 to F7). Everything runs in temporary folders against
 * fake adapters and a stubbed fetch: no real agent, no real credentials, no paid call.
 */

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ornelyon-audit-'));
}

/** A link to a folder: a junction on Windows (no privilege needed), a symbolic link elsewhere. Null when it cannot be made. */
function linkDir(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'junction');
    return true;
  } catch {
    return false;
  }
}

// ---------------- F1: workspace boundary ----------------

test('F1: a sibling folder that shares the root name as a prefix is outside', () => {
  const base = tmp();
  const root = join(base, 'ws');
  const sibling = join(base, 'ws-evil');
  mkdirSync(root);
  mkdirSync(sibling);
  writeFileSync(join(sibling, 'secret.txt'), 'secret');
  writeFileSync(join(root, 'ok.txt'), 'ok');
  assert.equal(isInsideReal(root, sibling), false, 'a string prefix is not containment');
  assert.equal(isInsideReal(root, join(root, 'ok.txt')), true);
  assert.equal(resolveInsideWorkspace(root, '../ws-evil/secret.txt'), null);
  assert.equal(hashWorkspaceFile(root, '../ws-evil/secret.txt'), null);
  assert.notEqual(hashWorkspaceFile(root, 'ok.txt'), null);
  rmSync(base, { recursive: true, force: true });
});

test('F1: a link or junction to a folder outside the workspace is refused by file, JSON and hash checks', async () => {
  const base = tmp();
  const root = join(base, 'ws');
  const outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.json'), '{"k":1}');
  if (!linkDir(outside, join(root, 'door'))) {
    rmSync(base, { recursive: true, force: true });
    return; // the platform would not create a link: nothing to test here
  }
  assert.equal(resolveInsideWorkspace(root, 'door/secret.json'), null);
  assert.equal(hashWorkspaceFile(root, 'door/secret.json'), null);
  const checks = await runVerification(
    { files: [{ path: 'door/secret.json', sha256: null }], jsonFiles: ['door/secret.json'], commands: [], allowedFiles: null },
    { root, sandbox: 'read-only', changed: [], snapshotGaps: [], commandsEnabled: false, trusted: {} },
  );
  assert.deepEqual(checks.map((c) => c.result), ['FAIL', 'FAIL'], 'the outside file must not be read, hashed or reported as present');
  rmSync(base, { recursive: true, force: true });
});

test('F1: a link that stays inside the workspace still works', () => {
  const root = tmp();
  mkdirSync(join(root, 'real'));
  writeFileSync(join(root, 'real', 'a.txt'), 'a');
  if (!linkDir(join(root, 'real'), join(root, 'alias'))) {
    rmSync(root, { recursive: true, force: true });
    return;
  }
  assert.equal(hashWorkspaceFile(root, 'alias/a.txt'), hashWorkspaceFile(root, 'real/a.txt'));
  assert.notEqual(hashWorkspaceFile(root, 'alias/a.txt'), null);
  rmSync(root, { recursive: true, force: true });
});

test('F1: snapshots do not follow links; a new link is a change; a link loop ends and a missing path is refused', () => {
  const base = tmp();
  const root = join(base, 'ws');
  const outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, 'big-secret.txt'), 'outside content');
  writeFileSync(join(root, 'a.txt'), 'a');
  const before = snapshotWorkspace(root);
  if (!linkDir(outside, join(root, 'door')) || !linkDir(root, join(root, 'self'))) {
    rmSync(base, { recursive: true, force: true });
    return;
  }
  const after = snapshotWorkspace(root); // 'self' points at the root: following it would never end
  assert.ok([...after.files.keys()].every((k) => !k.startsWith('door/') && !k.startsWith('self/')), 'nothing behind a link is walked');
  assert.ok(after.files.get('door')?.startsWith('link:'), 'the link itself is recorded');
  assert.deepEqual(diffSnapshots(before, after).map((d) => d.path), ['door', 'self']);
  assert.equal(resolveInsideWorkspace(root, 'does-not-exist.txt'), null, 'when the boundary cannot be established the answer is no');
  rmSync(base, { recursive: true, force: true });
});

// ---------------- F2: incomplete scope checks are not PASS ----------------

const SCOPE = { files: [], jsonFiles: [], commands: [], allowedFiles: ['src'] };
const scopeCtx = (root: string, over: Partial<Parameters<typeof runVerification>[1]>) => ({ root, sandbox: 'workspace-write' as const, changed: [], snapshotGaps: [] as string[] | null, commandsEnabled: false, trusted: {}, ...over });

test('F2: a change to a file larger than 2 MiB is seen, even when its size does not change', () => {
  const root = tmp();
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  writeFileSync(join(root, 'big.bin'), big);
  const before = snapshotWorkspace(root);
  big[big.length - 1] = 8;
  writeFileSync(join(root, 'big.bin'), big);
  const after = snapshotWorkspace(root);
  assert.deepEqual(diffSnapshots(before, after).map((d) => d.path), ['big.bin']);
  rmSync(root, { recursive: true, force: true });
});

test('F2: files too large to hash, the file limit and excluded folders are reported as gaps', () => {
  const root = tmp();
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'x.js'), 'x');
  writeFileSync(join(root, 'huge.bin'), Buffer.alloc(2048));
  for (let i = 0; i < 5; i += 1) {
    writeFileSync(join(root, `f${i}.txt`), String(i));
  }
  const s = snapshotWorkspace(root, root, { maxFiles: 3, maxFileBytes: 1024 });
  assert.equal(s.truncated, true);
  assert.ok(s.gaps.some((g) => /file limit reached/.test(g)));
  const t = snapshotWorkspace(root, root, { maxFileBytes: 1024 });
  assert.ok(t.gaps.some((g) => /too large to hash: huge\.bin/.test(g)));
  assert.ok(t.gaps.some((g) => /not inspected: node_modules\//.test(g)));
  assert.deepEqual(snapshotGaps(s, t), [...new Set([...s.gaps, ...t.gaps])].sort());
  rmSync(root, { recursive: true, force: true });
});

test('F2: the scope check is PASS only when nothing was left uninspected', async () => {
  const root = tmp();
  const inside = [{ path: 'src/a.ts', sha256: 'x' }];
  const pass = await runVerification(SCOPE, scopeCtx(root, { changed: inside }));
  assert.equal(pass[0].result, 'PASS');
  const gappy = await runVerification(SCOPE, scopeCtx(root, { changed: inside, snapshotGaps: ['too large to hash: big.bin'] }));
  assert.equal(gappy[0].result, 'UNVERIFIED');
  assert.match(gappy[0].detail, /incomplete/);
  assert.match(gappy[0].detail, /big\.bin/);
  const unmeasured = await runVerification(SCOPE, scopeCtx(root, { snapshotGaps: null }));
  assert.equal(unmeasured[0].result, 'UNVERIFIED');
  const readOnlyButChanged = await runVerification(SCOPE, scopeCtx(root, { sandbox: 'read-only', changed: [{ path: 'secrets/k.txt', sha256: 'y' }] }));
  assert.equal(readOnlyButChanged[0].result, 'FAIL', 'a read-only setting does not hide a change that was seen');
  const failWins = await runVerification(SCOPE, scopeCtx(root, { changed: [{ path: 'other/x', sha256: 'y' }], snapshotGaps: ['x'] }));
  assert.equal(failWins[0].result, 'FAIL');
  rmSync(root, { recursive: true, force: true });
});

class WritingAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Writer';
  readonly provenance = 'fake-adapter' as const;
  constructor(private readonly act: () => void) {}
  async detect() {
    return { installed: true, version: 'fake', executable: null, authenticated: true, authNote: 'fake' };
  }
  async run(request: TaskRequest): Promise<TaskResult> {
    this.act();
    return buildResult({ taskId: request.id, agent: 'codex', startedAtMs: Date.now(), status: 'success', output: 'done', model: 'fake', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: null, error: null });
  }
}

function runScoped(setup: (root: string) => void, act: (root: string) => void, over: { sandbox: 'read-only' | 'workspace-write'; cwd?: string; allowed: string[] | null }) {
  const home = isolatedHome();
  const root = join(home, 'workspace');
  mkdirSync(join(root, 'sub'), { recursive: true });
  mkdirSync(join(root, 'other'), { recursive: true });
  setup(root);
  const c = defaultConfig();
  c.workspaceRoot = root;
  c.setupCompleted = true;
  c.multiAi.enabled = false;
  c.agents.codex.enabled = true;
  c.agents.claude.enabled = false;
  c.agents.local.enabled = false;
  const adapters = new Map<string, AgentAdapter>([['codex', new WritingAdapter(() => act(root))]]);
  const handle = startTask(
    c,
    { prompt: 'x', kind: 'code', cwd: over.cwd, agent: 'codex', sandbox: over.sandbox, timeoutSec: 30, allowedFiles: over.allowed },
    randomUUID(),
    new AbortController().signal,
    () => {},
    { codex: true, claude: true, local: true },
    adapters,
  );
  return handle.done;
}

const scopeOf = (out: Awaited<ReturnType<typeof runScoped>>) => out.evidence.checks.find((k) => k.kind === 'scope');

test('F2: a run started from a sub-folder is checked against the whole workspace', async () => {
  const out = await runScoped(() => {}, (root) => writeFileSync(join(root, 'other', 'escape.txt'), 'x'), { sandbox: 'workspace-write', cwd: 'sub', allowed: ['sub'] });
  assert.equal(scopeOf(out)?.result, 'FAIL');
  assert.match(scopeOf(out)?.detail ?? '', /other\/escape\.txt/);
});

test('F2: a read-only run that changed a file outside the allowed files is not PASS', async () => {
  const out = await runScoped(() => {}, (root) => writeFileSync(join(root, 'other', 'sneaky.txt'), 'x'), { sandbox: 'read-only', allowed: ['sub'] });
  assert.equal(scopeOf(out)?.result, 'FAIL');
});

test('F2: a clean, fully inspected run passes; an excluded folder makes the result UNVERIFIED; no rule means no scope check', async () => {
  const clean = await runScoped(() => {}, (root) => writeFileSync(join(root, 'sub', 'ok.txt'), 'x'), { sandbox: 'workspace-write', allowed: ['sub'] });
  assert.equal(scopeOf(clean)?.result, 'PASS');
  const excluded = await runScoped((root) => mkdirSync(join(root, 'node_modules')), (root) => writeFileSync(join(root, 'sub', 'ok.txt'), 'x'), { sandbox: 'workspace-write', allowed: ['sub'] });
  assert.equal(scopeOf(excluded)?.result, 'UNVERIFIED');
  assert.match(scopeOf(excluded)?.detail ?? '', /node_modules/);
  const none = await runScoped(() => {}, () => {}, { sandbox: 'read-only', allowed: null });
  assert.equal(scopeOf(none), undefined);
});

// ---------------- F3: Research limits ----------------

function researchConfig(): ChimeraConfig {
  const c = defaultConfig();
  c.preset = 'research';
  c.agents.codex.enabled = true;
  return c;
}

function researchInput(c: ChimeraConfig, adapter: AgentAdapter, records: RunRecord[], samples = 1) {
  return { config: c, agent: 'codex' as const, adapter, task: 'say ok', expect: 'ok', samples, cwd: process.cwd(), timeoutMs: 20000, signal: new AbortController().signal, log: () => {}, records: () => records, record: (r: RunRecord) => records.push(r) };
}

test('F3: Research never starts a disabled agent', async () => {
  isolatedHome();
  const c = researchConfig();
  c.agents.codex.enabled = false;
  const adapter = new FakeAdapter('codex', [{ status: 'success', output: 'ok' }]);
  await assert.rejects(runResearch(researchInput(c, adapter, [])), /disabled/);
  assert.equal(adapter.calls.length, 0);
});

test('F3: maxCalls caps a Research run before anything starts, and the same plan is allowed when the limit is raised', async () => {
  isolatedHome();
  const c = researchConfig();
  const adapter = new FakeAdapter('codex', [{ status: 'success', output: 'ok' }]);
  c.multiAi.maxCalls = 2; // the three default variants need three calls
  await assert.rejects(runResearch(researchInput(c, adapter, [])), /needs 3 agent calls .* maxCalls is 2/);
  c.multiAi.maxCalls = 3;
  await assert.rejects(runResearch(researchInput(c, adapter, [], 2)), /needs 6 agent calls/, 'samples multiply the calls');
  assert.equal(adapter.calls.length, 0, 'a refused plan makes no call');
  const records: RunRecord[] = [];
  await runResearch(researchInput(c, adapter, records, 1));
  assert.equal(adapter.calls.length, 3);
  assert.ok(adapter.calls.length <= c.multiAi.maxCalls);
});

test('F3: every Research call is recorded with the adapter origin', async () => {
  isolatedHome();
  const c = researchConfig();
  const records: RunRecord[] = [];
  await runResearch(researchInput(c, new FakeAdapter('codex', [{ status: 'success', output: 'ok' }]), records));
  assert.equal(records.length, 3);
  assert.ok(records.every((r) => r.origin === 'fake-adapter' && r.kind === 'research'));
  const rows = buildRows(records).rows;
  assert.equal(cohortStats(rows).origins.nonReal, rows.length, 'a fake Research run is never counted as real use');
});

// ---------------- F4 / F7: MCP ----------------

type Reply = { result?: { content: { text: string }[]; isError?: boolean } };

async function mcpSession(tasks: string[] | 'all') {
  const s = createMcpSession({ tasks, exposeContent: false, version: 'test' });
  await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  return async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const r = (await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })) as unknown as Reply;
    const text = r.result?.content[0].text ?? '{}';
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { toolError: text };
    }
  };
}

async function seedTask(config: ChimeraConfig): Promise<string> {
  const groupId = randomUUID();
  const now = new Date().toISOString();
  const base: RunRecord = {
    recordedAt: now,
    role: 'task',
    groupId,
    mode: 'L0',
    kind: 'code',
    prompt: 'p',
    result: { taskId: randomUUID(), agent: 'codex', status: 'success', output: 'out', model: null, errorKind: null, errorMessage: null, errorSignature: null, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: null, startedAt: now, durationMs: 1 },
  };
  appendRecord(base);
  appendRecord({ ...base, role: 'summary', evidence: initialEvidence({ status: 'success', sandbox: 'read-only', verificationRequired: false, checks: [], changedFiles: [] }), notes: [] });
  assert.ok((await savePassportFor(config, groupId)).ok);
  return groupId;
}

function mcpHome(): { home: string; config: ChimeraConfig } {
  const home = tmp();
  process.env.ORNELYON_HOME = home;
  delete process.env.CHIMERA_HOME;
  const config = defaultConfig();
  config.setupCompleted = true;
  config.workspaceRoot = join(home, 'workspace');
  mkdirSync(config.workspaceRoot, { recursive: true });
  config.multiAi.enabled = true;
  config.multiAi.mode = 'manual';
  config.multiAi.mainAgent = 'codex';
  for (const k of ['codex', 'claude'] as const) {
    config.agents[k].enabled = true;
    config.agents[k].capabilities = ['code', 'text'];
  }
  config.agents.local.enabled = false;
  config.agents.local.baseUrl = 'http://127.0.0.1:1/v1';
  saveConfig(config);
  return { home, config };
}

test('F4: a damaged history line makes the MCP answer say it is incomplete', async () => {
  const { config } = mcpHome();
  const id = await seedTask(config);
  const call = await mcpSession([id]);
  const clean = await call('ornelyon_recent_tasks');
  assert.equal(clean.historyComplete, undefined, 'an intact history has no warning');
  appendFileSync(historyPath(), '{"this line is cut off\n');
  assert.equal(readRecords().skippedLines, 1);
  for (const [name, args] of [['ornelyon_recent_tasks', {}], ['ornelyon_evidence', { taskId: id }], ['ornelyon_passport', { taskId: id }], ['ornelyon_handoff_preview', { taskId: id, to: 'claude' }]] as const) {
    const r = await call(name, { ...args });
    assert.equal(r.toolError, undefined, `${name} should answer, got: ${String(r.toolError)}`);
    assert.equal(r.historyComplete, false, name);
    assert.equal(r.skippedHistoryLines, 1, name);
    assert.match(String(r.historyWarning), /not a complete result/, name);
  }
  const evidence = await call('ornelyon_evidence', { taskId: id });
  assert.equal(evidence.historyComplete, false);
  assert.equal(evidence.taskId, id, 'the data that could be read is still returned');
  assert.equal((await call('ornelyon_dispatch_preview')).historyComplete, undefined, 'tools that do not read history are untouched');
});

test('F7: reading through MCP never writes: a damaged config is not copied or backed up by any of the six tools', async () => {
  const savedPath = process.env.PATH;
  const { home, config } = mcpHome();
  const id = await seedTask(config);
  writeFileSync(join(home, 'config.json'), '{ this is not json');
  const listing = (): string => readdirSync(home).sort().join('|');
  const before = listing();
  process.env.PATH = home; // no agent CLI can be found or started while status is probed
  try {
    const call = await mcpSession([id]);
    for (const [name, args] of [
      ['ornelyon_status', {}],
      ['ornelyon_recent_tasks', {}],
      ['ornelyon_dispatch_preview', {}],
      ['ornelyon_evidence', { taskId: id }],
      ['ornelyon_passport', { taskId: id }],
      ['ornelyon_handoff_preview', { taskId: id, to: 'claude' }],
    ] as const) {
      const r = await call(name, { ...args });
      // With the damaged config the defaults apply, where the claude target is off: a refusal is fine, a write is not.
      assert.ok(name === 'ornelyon_handoff_preview' || r.toolError === undefined, `${name} should answer, got: ${String(r.toolError)}`);
      assert.equal(listing(), before, `${name} changed the data folder`);
    }
  } finally {
    process.env.PATH = savedPath;
  }
  assert.equal(existsSync(join(home, 'config.json.corrupt')), false);
  assert.equal(existsSync(join(home, 'config.json.bak')), false);
  // The normal loader still keeps its evidence copy, and the read-only mode is explicit.
  const warn = loadConfig(join(home, 'config.json'), { readOnly: true });
  assert.equal(warn.source, 'defaults');
  assert.equal(existsSync(join(home, 'config.json.corrupt')), false);
  loadConfig(join(home, 'config.json'));
  assert.equal(existsSync(join(home, 'config.json.corrupt')), true);
});

// ---------------- F5: local LLM body failure ----------------

test('F5: a failure while the response body is read becomes a failed result with unknown usage', async () => {
  const body = new ReadableStream({
    pull() {
      throw new Error('socket hang up while reading');
    },
  });
  const adapter = new LocalLlmAdapter({ baseUrl: 'http://127.0.0.1:1/v1', model: 'm', apiKeyEnv: null, tools: [], fetchImpl: (async () => new Response(body, { status: 200 })) as typeof fetch });
  const result = await adapter.run({ id: randomUUID(), prompt: 'x', cwd: process.cwd(), agent: 'local', timeoutMs: 5000, sandbox: 'read-only' }, { signal: new AbortController().signal, log: () => {} });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorKind, 'unknown');
  assert.equal(result.errorSignature, 'local-network-error');
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null });
  assert.equal(result.costUsd, null, 'an unknown cost is not recorded as 0');
});

test('F5: cancellation while the body is read is reported as cancelled', async () => {
  const controller = new AbortController();
  const body = new ReadableStream({
    pull() {
      controller.abort();
      throw new Error('aborted');
    },
  });
  const adapter = new LocalLlmAdapter({ baseUrl: 'http://127.0.0.1:1/v1', model: 'm', apiKeyEnv: null, tools: [], fetchImpl: (async () => new Response(body, { status: 200 })) as typeof fetch });
  const result = await adapter.run({ id: randomUUID(), prompt: 'x', cwd: process.cwd(), agent: 'local', timeoutMs: 5000, sandbox: 'read-only' }, { signal: controller.signal, log: () => {} });
  assert.equal(result.status, 'cancelled');
});

// ---------------- F6: benchmark token unknowns ----------------

function tokenRecords(calls: Array<{ in: number | null; out: number | null }>): RunRecord[] {
  const groupId = randomUUID();
  const out: RunRecord[] = [];
  calls.forEach((c, i) => {
    out.push({
      recordedAt: new Date(Date.now() + i).toISOString(),
      role: i === 0 ? 'task' : 'review',
      groupId,
      mode: 'L0',
      kind: 'code',
      prompt: 'p',
      result: { taskId: `${groupId}-${i}`, agent: 'codex', status: 'success', output: 'o', model: 'm', errorKind: null, errorMessage: null, errorSignature: null, usage: { inputTokens: c.in, outputTokens: c.out }, costUsd: 0.01, startedAt: new Date().toISOString(), durationMs: 1 },
      origin: 'cli',
    });
  });
  return out;
}

test('F6: input and output tokens are known independently and an unknown side is never counted as 0', () => {
  const half = buildRows(tokenRecords([{ in: 100, out: null }])).rows[0];
  assert.equal(half.inputTokens, 100);
  assert.equal(half.outputTokens, null);
  const mixed = buildRows(tokenRecords([{ in: 100, out: 40 }, { in: null, out: 60 }])).rows[0];
  assert.equal(mixed.inputTokens, null, 'one call did not report input tokens, so the task total is unknown');
  assert.equal(mixed.outputTokens, 100);
  const full = buildRows(tokenRecords([{ in: 10, out: 5 }, { in: 20, out: 7 }])).rows[0];
  assert.equal(full.inputTokens, 30);
  assert.equal(full.outputTokens, 12);
  const stats = cohortStats([half, mixed, full]);
  assert.equal(stats.inputTokens.n, 2);
  assert.equal(stats.inputTokens.unknown, 1);
  assert.equal(stats.outputTokens.n, 2);
  assert.equal(stats.outputTokens.unknown, 1);
  assert.equal(stats.inputTokens.sum, 130);
  assert.equal(stats.outputTokens.sum, 112);
});

// ---------------- F2 follow-up: verification commands are measured after they run ----------------

const SCRIPT_OK = "process.stdout.write('ok');\n";
// Writes a file outside the allowed folder, then passes. Reads its own location from argv, so it works in any temp folder.
const SCRIPT_WRITE_OUTSIDE_PASS =
  "const fs = require('fs'); const path = require('path');\nfs.writeFileSync(path.join(path.dirname(process.argv[1]), '..', 'other', 'created-by-check.txt'), 'x');\n";
const SCRIPT_OVERWRITE_OUTSIDE = "const fs = require('fs'); const path = require('path');\nfs.writeFileSync(path.join(path.dirname(process.argv[1]), '..', 'other', 'existing.txt'), 'changed by check');\n";
const SCRIPT_WRITE_OUTSIDE_FAIL = `${SCRIPT_WRITE_OUTSIDE_PASS}process.exit(1);\n`;

/**
 * A task with one registered verification command, `check`, which runs `sub/check.js`. `setup` is that script before
 * the agent runs; `agent` is what the agent does (it may rewrite the script, as in the Codex reproduction).
 */
function runWithCheck(
  setup: string,
  agent: (root: string) => void,
  over: { allowed: string[] | null; sandbox?: 'read-only' | 'workspace-write'; withGap?: boolean },
) {
  const home = isolatedHome();
  const root = join(home, 'workspace');
  mkdirSync(join(root, 'sub'), { recursive: true });
  mkdirSync(join(root, 'other'), { recursive: true });
  if (over.withGap) {
    mkdirSync(join(root, 'node_modules'));
  }
  writeFileSync(join(root, 'other', 'existing.txt'), 'original');
  writeFileSync(join(root, 'sub', 'check.js'), setup);
  const c = defaultConfig();
  c.workspaceRoot = root;
  c.setupCompleted = true;
  c.multiAi.enabled = false;
  c.agents.codex.enabled = true;
  c.agents.claude.enabled = false;
  c.agents.local.enabled = false;
  c.verification.allowCommands = true;
  c.verification.commands = { check: { command: process.execPath, args: [join(root, 'sub', 'check.js')], timeoutSec: 30 } };
  const adapters = new Map<string, AgentAdapter>([['codex', new WritingAdapter(() => agent(root))]]);
  return startTask(
    c,
    { prompt: 'x', kind: 'code', cwd: undefined, agent: 'codex', sandbox: over.sandbox ?? 'workspace-write', timeoutSec: 30, allowedFiles: over.allowed, verify: { files: [], jsonFiles: [], commands: ['check'] } },
    randomUUID(),
    new AbortController().signal,
    () => {},
    { codex: true, claude: true, local: true },
    adapters,
  ).done;
}

const checkOf = (ev: { checks: VerificationCheck[] }, kind: string) => ev.checks.find((k) => k.kind === kind);

test('F2 reproduction: the agent rewrites the in-scope check script; it writes outside the scope; the scope check FAILs and the overall verification is FAIL', async () => {
  const out = await runWithCheck(
    SCRIPT_OK,
    (root) => writeFileSync(join(root, 'sub', 'check.js'), SCRIPT_WRITE_OUTSIDE_PASS),
    { allowed: ['sub'] },
  );
  // The command itself exited 0, so it is PASS. The side effect is found by the scope rule, and it decides the result.
  assert.equal(checkOf(out.evidence, 'command')?.result, 'PASS');
  assert.equal(checkOf(out.evidence, 'scope')?.result, 'FAIL');
  assert.match(checkOf(out.evidence, 'scope')?.detail ?? '', /other\/created-by-check\.txt/);
  assert.ok(out.evidence.changedFiles.some((f) => f.path === 'other/created-by-check.txt' && f.sha256 !== null), 'the file the check created is in the change list');
  assert.equal(out.evidence.verification, 'FAIL', 'a scope violation overrides a passing command');
});

test('F2: a verification script that overwrites an existing out-of-scope file is reflected in the change list', async () => {
  const out = await runWithCheck(SCRIPT_OVERWRITE_OUTSIDE, () => {}, { allowed: ['sub'] });
  assert.equal(checkOf(out.evidence, 'scope')?.result, 'FAIL');
  assert.ok(out.evidence.changedFiles.some((f) => f.path === 'other/existing.txt'), 'the overwritten file is listed as changed');
  assert.equal(out.evidence.verification, 'FAIL');
});

test('F2: a verification command that fails still has its side effects measured', async () => {
  const out = await runWithCheck(SCRIPT_WRITE_OUTSIDE_FAIL, () => {}, { allowed: ['sub'] });
  assert.equal(checkOf(out.evidence, 'command')?.result, 'FAIL');
  assert.equal(checkOf(out.evidence, 'scope')?.result, 'FAIL');
  assert.ok(out.evidence.changedFiles.some((f) => f.path === 'other/created-by-check.txt'), 'the failing command left a file; it is not missed');
  assert.equal(out.evidence.verification, 'FAIL');
});

test('F2: a verification command in a read-only run is still held to the scope rule', async () => {
  const out = await runWithCheck(SCRIPT_WRITE_OUTSIDE_PASS, () => {}, { allowed: ['sub'], sandbox: 'read-only' });
  assert.equal(checkOf(out.evidence, 'scope')?.result, 'FAIL');
  assert.equal(out.evidence.verification, 'FAIL');
});

test('F2: a gap never produces an overall PASS, even when the command passes and nothing was written outside', async () => {
  const out = await runWithCheck(SCRIPT_OK, (root) => writeFileSync(join(root, 'sub', 'ok.txt'), 'x'), { allowed: ['sub'], withGap: true });
  assert.equal(checkOf(out.evidence, 'scope')?.result, 'UNVERIFIED');
  assert.notEqual(out.evidence.verification, 'PASS');
});

test('F2: normal work is unchanged: an in-scope change with a passing command gives PASS for scope and overall', async () => {
  const out = await runWithCheck(SCRIPT_OK, (root) => writeFileSync(join(root, 'sub', 'ok.txt'), 'x'), { allowed: ['sub'] });
  assert.equal(checkOf(out.evidence, 'command')?.result, 'PASS');
  assert.equal(checkOf(out.evidence, 'scope')?.result, 'PASS');
  assert.equal(out.evidence.verification, 'PASS');
  assert.deepEqual(out.evidence.changedFiles.map((f) => f.path).filter((p) => p === 'sub/ok.txt'), ['sub/ok.txt']);
});

// ---------------- F8: a verification command that changes a checked file ----------------

// Writes `text` into a file in sub/ (the check script's folder). The script reads its own location from argv[1].
const WRITE_IN_SUB = (name: string, text: string, exit: number): string =>
  `const fs = require('fs'); const path = require('path');\nfs.writeFileSync(path.join(path.dirname(process.argv[1]), '${name}'), ${JSON.stringify(text)});\nprocess.exit(${exit});\n`;

/**
 * One task with a registered command `check` (sub/check.js, which is `command`) and verification of `verify`.
 * `files` are written into sub/ before the agent runs. The agent does nothing unless `agent` is given.
 */
/** The workspace of the most recent runF8 call. */
let lastRoot = '';

function runF8(
  command: string,
  verify: { files?: { path: string; sha256: string | null }[]; jsonFiles?: string[] },
  over: { files?: Record<string, string>; allowed?: string[] | null; withGap?: boolean; agent?: (root: string) => void } = {},
) {
  const home = isolatedHome();
  const root = join(home, 'workspace');
  lastRoot = root;
  mkdirSync(join(root, 'sub'), { recursive: true });
  mkdirSync(join(root, 'other'), { recursive: true });
  if (over.withGap) {
    mkdirSync(join(root, 'node_modules'));
  }
  for (const [name, text] of Object.entries(over.files ?? {})) {
    writeFileSync(join(root, 'sub', name), text);
  }
  const scriptPath = join(root, 'sub', 'check.js');
  writeFileSync(scriptPath, command);
  const c = defaultConfig();
  c.workspaceRoot = root;
  c.setupCompleted = true;
  c.multiAi.enabled = false;
  c.agents.codex.enabled = true;
  c.agents.claude.enabled = false;
  c.agents.local.enabled = false;
  c.verification.allowCommands = true;
  c.verification.commands = { check: { command: process.execPath, args: [scriptPath], timeoutSec: 30 } };
  const adapters = new Map<string, AgentAdapter>([['codex', new WritingAdapter(() => over.agent?.(root))]]);
  return startTask(
    c,
    { prompt: 'x', kind: 'code', cwd: undefined, agent: 'codex', sandbox: 'workspace-write', timeoutSec: 30, allowedFiles: over.allowed === undefined ? ['sub'] : over.allowed, verify: { files: verify.files ?? [], jsonFiles: verify.jsonFiles ?? [], commands: ['check'] } },
    randomUUID(),
    new AbortController().signal,
    () => {},
    { codex: true, claude: true, local: true },
    adapters,
  ).done;
}

const GOOD_JSON = '{"ok": true}';

test('F8 1: JSON correct before the command; the command writes invalid JSON and exits 0 → JSON FAIL and overall FAIL', async () => {
  const out = await runF8(WRITE_IN_SUB('data.json', '{ broken', 0), { jsonFiles: ['sub/data.json'] }, { files: { 'data.json': GOOD_JSON } });
  assert.equal(checkOf(out.evidence, 'json')?.result, 'FAIL', 'the final file is checked, not the one read before the command');
  assert.equal(out.evidence.verification, 'FAIL');
});

test('F8 2: hash correct before the command; the command changes the content and exits 0 → file FAIL and overall FAIL', async () => {
  const out = await runF8(WRITE_IN_SUB('data.txt', 'bad', 0), { files: [{ path: 'sub/data.txt', sha256: sha256Text('good') }] }, { files: { 'data.txt': 'good' } });
  assert.equal(checkOf(out.evidence, 'file')?.result, 'FAIL');
  assert.equal(out.evidence.verification, 'FAIL');
});

test('F8 3: the command changes nothing and succeeds → file, JSON, scope and overall are PASS as before', async () => {
  const out = await runF8('process.exit(0);\n', { files: [{ path: 'sub/data.txt', sha256: sha256Text('good') }], jsonFiles: ['sub/data.json'] }, { files: { 'data.txt': 'good', 'data.json': GOOD_JSON } });
  assert.equal(checkOf(out.evidence, 'file')?.result, 'PASS');
  assert.equal(checkOf(out.evidence, 'json')?.result, 'PASS');
  assert.equal(checkOf(out.evidence, 'command')?.result, 'PASS');
  assert.equal(checkOf(out.evidence, 'scope')?.result, 'PASS');
  assert.equal(out.evidence.verification, 'PASS');
});

test('F8 4: the command fails and also changes the JSON → command FAIL, JSON FAIL, overall FAIL', async () => {
  const out = await runF8(WRITE_IN_SUB('data.json', '{ broken', 1), { jsonFiles: ['sub/data.json'] }, { files: { 'data.json': GOOD_JSON } });
  assert.equal(checkOf(out.evidence, 'command')?.result, 'FAIL');
  assert.equal(checkOf(out.evidence, 'json')?.result, 'FAIL');
  assert.equal(out.evidence.verification, 'FAIL');
});

test('F8 5: the command writes outside the allowed files → scope FAIL, overall FAIL, even when the JSON is correct', async () => {
  const script = "const fs = require('fs'); const path = require('path');\nfs.writeFileSync(path.join(path.dirname(process.argv[1]), '..', 'other', 'x.txt'), 'x');\n";
  const out = await runF8(script, { jsonFiles: ['sub/data.json'] }, { files: { 'data.json': GOOD_JSON } });
  assert.equal(checkOf(out.evidence, 'scope')?.result, 'FAIL');
  assert.ok(out.evidence.changedFiles.some((f) => f.path === 'other/x.txt'));
  assert.equal(out.evidence.verification, 'FAIL');
});

test('F8 6: a snapshot gap means the scope is not PASS, and the overall result is not PASS', async () => {
  const out = await runF8('process.exit(0);\n', { jsonFiles: ['sub/data.json'] }, { files: { 'data.json': GOOD_JSON }, withGap: true });
  assert.equal(checkOf(out.evidence, 'scope')?.result, 'UNVERIFIED');
  assert.notEqual(out.evidence.verification, 'PASS');
});

test('F8: the verification command runs exactly once', async () => {
  const script = "const fs = require('fs'); const path = require('path');\nfs.appendFileSync(path.join(path.dirname(process.argv[1]), 'runs.txt'), 'x');\n";
  await runF8(script, {}, {});
  const runs = readFileSync(join(lastRoot, 'sub', 'runs.txt'), 'utf8');
  assert.equal(runs, 'x', 'one run, one line');
});

test('F8 unit: a file that moved after the snapshot is UNVERIFIED; a failed snapshot makes every read UNVERIFIED; a FAIL stays FAIL', () => {
  const root = tmp();
  writeFileSync(join(root, 'a.txt'), 'one');
  writeFileSync(join(root, 'b.json'), '{}');
  const snap = snapshotWorkspace(root);
  writeFileSync(join(root, 'a.txt'), 'two');
  const spec = { files: [{ path: 'a.txt', sha256: null }], jsonFiles: ['b.json'], commands: [], allowedFiles: null };
  // The snapshot recorded "one"; the file now reads "two". The state moved between the snapshot and the check.
  assert.equal(runStateChecks(spec, { root, snapshot: snap }).find((c) => c.name === 'a.txt')?.result, 'UNVERIFIED');
  assert.equal(runStateChecks(spec, { root, snapshot: snapshotWorkspace(root) }).find((c) => c.name === 'a.txt')?.result, 'PASS');
  assert.equal(runStateChecks(spec, { root, snapshot: null, snapshotFailed: true }).every((c) => c.result === 'UNVERIFIED'), true);
  const expectedOld = runStateChecks({ ...spec, files: [{ path: 'a.txt', sha256: sha256Text('one') }] }, { root, snapshot: null, snapshotFailed: true });
  assert.equal(expectedOld[0].result, 'FAIL', 'a FAIL against the expected hash is kept, even when the snapshot failed');
  rmSync(root, { recursive: true, force: true });
});
