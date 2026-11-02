import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../core/config.js';
import { readRecords } from '../core/history.js';
import { appendRecord, type RunRecord } from '../core/history.js';
import { initialEvidence } from '../core/evidence.js';
import { canonicalWorkspacePath, workspaceIdFor, workspaceKeyPath, workspaceRelation } from '../core/workspace-id.js';
import { startTask } from '../interface/service.js';
import { createMcpSession } from '../interface/mcp.js';
import { FakeAdapter } from './fake-adapter.js';
import type { AgentAdapter } from '../core/types.js';

/*
 * v0.6.0 workspace labels. A label ties tasks to a folder for search; it is never a permission.
 * All folders are synthetic temporary ones.
 */

function freshHome(): string {
  const h = mkdtempSync(join(tmpdir(), 'ornelyon-wsid-'));
  process.env.ORNELYON_HOME = h;
  delete process.env.CHIMERA_HOME;
  return h;
}

test('a read-only caller never creates the key, and an unknown label stays unknown', () => {
  const h = freshHome();
  const dir = join(h, 'proj');
  mkdirSync(dir);
  assert.equal(workspaceIdFor(dir, false), null);
  assert.equal(existsSync(workspaceKeyPath()), false, 'asking did not write anything');
  const id = workspaceIdFor(dir, true);
  assert.match(id ?? '', /^ws1:[0-9a-f]{16}$/);
  assert.match(readFileSync(workspaceKeyPath(), 'utf8').trim(), /^[0-9a-f]{64}$/);
  assert.equal(workspaceIdFor(dir, false), id, 'now the read-only caller can compute it');
  assert.equal(workspaceIdFor(join(h, 'does-not-exist'), true), null, 'a folder that cannot be resolved has no label');
});

test('the same folder gives the same label however it is written; another folder, or another key, gives another', () => {
  const h = freshHome();
  const a = join(h, 'a');
  const b = join(h, 'b');
  mkdirSync(a);
  mkdirSync(b);
  const idA = workspaceIdFor(a, true);
  assert.equal(workspaceIdFor(`${a}/`, true), idA);
  assert.equal(workspaceIdFor(join(a, '..', 'a'), true), idA);
  assert.equal(workspaceIdFor(a.replace(/\\/g, '/'), true), idA);
  assert.notEqual(workspaceIdFor(b, true), idA);
  // A symbolic link to the folder is the same folder. (Creating links can need rights on Windows: skip then.)
  const link = join(h, 'link');
  try {
    symlinkSync(a, link, 'junction');
    assert.equal(workspaceIdFor(link, true), idA);
  } catch {
    /* no right to create links here */
  }
  if (process.platform === 'win32') {
    assert.equal(workspaceIdFor(a.toUpperCase(), true), idA, 'letter case does not matter on Windows');
  }
  // The label carries no part of the path, and the same folder under a different key does not match, so a copied
  // label cannot be checked against guessed paths.
  assert.ok(!idA?.includes('proj') && !(idA ?? '').toLowerCase().includes(h.slice(-6).toLowerCase()));
  const other = freshHome();
  const copy = join(other, 'a');
  mkdirSync(copy);
  assert.notEqual(workspaceIdFor(copy, true), idA);
  assert.ok(canonicalWorkspacePath(a)?.includes('/'));
});

test('relation: anything missing or malformed is UNKNOWN, never OTHER', () => {
  assert.equal(workspaceRelation('ws1:0123456789abcdef', 'ws1:0123456789abcdef'), 'SAME');
  assert.equal(workspaceRelation('ws1:0123456789abcdef', 'ws1:ffffffffffffffff'), 'OTHER');
  for (const bad of [undefined, null, 5, '', 'ws1:xyz', 'ws9:0123456789abcdef', '../../etc']) {
    assert.equal(workspaceRelation(bad, 'ws1:0123456789abcdef'), 'UNKNOWN', String(bad));
  }
  assert.equal(workspaceRelation('ws1:0123456789abcdef', null), 'UNKNOWN');
});

test('a new task records the label on its summary; old history without it is shown as UNKNOWN and is not changed', async () => {
  const h = freshHome();
  const root = join(h, 'workspace');
  mkdirSync(root);
  writeFileSync(join(root, 'f.txt'), 'x');
  const c = defaultConfig();
  c.workspaceRoot = root;
  c.setupCompleted = true;
  c.multiAi.enabled = false;
  c.agents.codex.enabled = true;
  c.agents.claude.enabled = false;
  c.agents.local.enabled = false;
  // An old-style task first: written before any key exists, exactly as v0.6.0-era code reads v0.5 history.
  const oldId = randomUUID();
  const now = new Date().toISOString();
  const base: RunRecord = { recordedAt: now, role: 'task', groupId: oldId, mode: 'L1', kind: 'code', prompt: 'OLD', result: { taskId: randomUUID(), agent: 'codex', status: 'success', output: 'o', model: null, errorKind: null, errorMessage: null, errorSignature: null, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0, startedAt: now, durationMs: 1 } };
  appendRecord(base);
  appendRecord({ ...base, role: 'summary', evidence: initialEvidence({ status: 'success', sandbox: 'read-only', verificationRequired: false, checks: [], changedFiles: [] }), notes: [] });

  const adapters = new Map<string, AgentAdapter>([['codex', new FakeAdapter('codex', [{ status: 'success', output: 'done' }])]]);
  const handle = startTask(c, { prompt: 'x', kind: 'code', cwd: undefined, agent: 'codex', sandbox: 'read-only', timeoutSec: 30, allowedFiles: null }, randomUUID(), new AbortController().signal, () => {}, { codex: true, claude: true, local: true }, adapters);
  const out = await handle.done;
  const summaries = readRecords().records.filter((r) => r.role === 'summary');
  const newest = summaries.find((r) => r.groupId === out.groupId);
  const old = summaries.find((r) => r.groupId === oldId);
  assert.match(newest?.workspace ?? '', /^ws1:[0-9a-f]{16}$/);
  assert.equal(old?.workspace, undefined, 'old history is never filled in');

  // Through MCP: SAME for the new task, UNKNOWN for the old one. The label itself is not shown.
  const s = createMcpSession({ tasks: [out.groupId, oldId], exposeContent: false, version: 't' });
  await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  const r = (await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ornelyon_recent_tasks', arguments: {} } })) as unknown as { result: { content: { text: string }[] } };
  const text = r.result.content[0].text;
  const rows = (JSON.parse(text) as { tasks: { groupId: string; workspace: string }[] }).tasks;
  assert.equal(rows.find((t) => t.groupId === out.groupId)?.workspace, 'SAME');
  assert.equal(rows.find((t) => t.groupId === oldId)?.workspace, 'UNKNOWN');
  assert.ok(!text.includes('ws1:'), 'the label is not sent to the client');
});
