import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, saveConfig } from '../core/config.js';
import { historyPath, packageRoot } from '../core/paths.js';
import { appendRecord, type RunRecord } from '../core/history.js';
import { initialEvidence } from '../core/evidence.js';
import { savePassportFor } from '../interface/service.js';
import { assessRegistration, diagnoseMcp, findRegistrations, ornelyonEntryOf, parseClaudeGet, parseCodexList, shortPath, type Registration } from '../interface/doctor.js';

/*
 * v0.6.0 Phase 1 doctor tests. The clients are replaced by a fake runner, so no real Codex or Claude Code is started
 * and nothing is read from their settings. All data is synthetic.
 */

const OWN = join(packageRoot(), 'dist', 'interface', 'cli.js');

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'ornelyon-doctor-'));
  process.env.ORNELYON_HOME = h;
  delete process.env.CHIMERA_HOME;
  const config = defaultConfig();
  config.setupCompleted = true;
  config.workspaceRoot = mkdtempSync(join(tmpdir(), 'ornelyon-doctor-ws-'));
  saveConfig(config);
  return h;
}

function snapshot(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      statSync(p).isDirectory() ? walk(p) : parts.push(`${p}:${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  };
  walk(dir);
  return parts.join('\n');
}

const reg = (over: Partial<Registration> = {}): Registration => ({ client: 'claude', name: 'ornelyon', command: process.execPath, args: [OWN, 'mcp', '--allow-task', randomUUID()], connected: true, ...over });
const status = (items: { id: string; status: string }[], suffix: string): string | undefined => items.find((i) => i.id.endsWith(suffix))?.status;

test('doctor: a healthy registration passes, and every item that cannot be checked says so', () => {
  const items = assessRegistration(reg(), OWN);
  assert.deepEqual(items.map((i) => i.status), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
  const codex = assessRegistration(reg({ client: 'codex', connected: null }), OWN);
  assert.equal(status(codex, ':connection'), 'NOT_TESTED', 'a client that does not connect is never reported as connected');
});

test('doctor: moved or deleted files, another copy and wide exposure are found with a repair command', () => {
  const gone = assessRegistration(reg({ args: [join(tmpdir(), 'nowhere', 'dist', 'interface', 'cli.js'), 'mcp'] }), OWN);
  assert.equal(status(gone, ':entry'), 'FAIL');
  assert.match(gone.find((i) => i.id.endsWith(':entry'))?.fix ?? '', /npm run build|--print-config/);
  assert.equal(gone.find((i) => i.id.endsWith(':copy')), undefined, 'no copy check for a file that is not there');

  const noNode = assessRegistration(reg({ command: join(tmpdir(), 'no-such-node.exe') }), OWN);
  assert.equal(status(noNode, ':command'), 'FAIL');

  const other = assessRegistration(reg({ args: [OWN, 'mcp'] }), OWN, () => true);
  assert.equal(status(other, ':copy'), 'PASS');
  const elsewhere = assessRegistration(reg({ args: [join('/opt', 'other', 'dist', 'interface', 'cli.js'), 'mcp'] }), OWN, () => true);
  assert.equal(status(elsewhere, ':copy'), 'WARN');

  const wide = assessRegistration(reg({ args: [OWN, 'mcp', '--all-tasks'] }), OWN);
  assert.equal(status(wide, ':scope'), 'WARN');
  const content = assessRegistration(reg({ args: [OWN, 'mcp', '--allow-task', randomUUID(), '--expose-content'] }), OWN);
  assert.equal(status(content, ':scope'), 'WARN');
  assert.equal(status(assessRegistration(reg({ connected: false }), OWN), ':connection'), 'FAIL');
  assert.equal(status(assessRegistration(reg({ command: 'node' }), OWN), ':command'), 'WARN', 'a bare command depends on the client PATH');
  // Something that is not ORNELYON is not judged.
  assert.equal(assessRegistration(reg({ args: ['server.js'] }), OWN)[0].status, 'UNKNOWN');
});

test('doctor: client output is parsed, other servers are dropped, and no environment value is kept', () => {
  const codexJson = JSON.stringify([
    { name: 'blender', transport: { type: 'stdio', command: 'x.exe', args: ['--k'], env: { SECRET_TOKEN: 'sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } } },
    { name: 'ornelyon-a', transport: { type: 'stdio', command: 'node.exe', args: ['C:/x/dist/interface/cli.js', 'mcp', '--recent', '5'], env: { ORNELYON_HOME: 'C:/private/home' } } },
    { name: 'remote', transport: { type: 'streamable_http', url: 'https://example.invalid' } },
  ]);
  const regs = parseCodexList(codexJson);
  assert.deepEqual(regs.map((r) => r.name), ['ornelyon-a']);
  assert.ok(!JSON.stringify(regs).includes('sk-') && !JSON.stringify(regs).includes('private'));
  assert.deepEqual(parseCodexList('not json'), []);
  assert.deepEqual(parseCodexList('{}'), []);

  const text = 'ornelyon:\n  Scope: User config\n  Status: ✘ Failed to connect\n  Type: stdio\n  Command: C:\\Program Files\\nodejs\\node.exe\n  Args: C:/x/dist/interface/cli.js mcp --recent 5\n  Environment:\n    ORNELYON_HOME=C:/private\n';
  const c = parseClaudeGet('ornelyon', text);
  assert.equal(c?.connected, false);
  assert.equal(c?.command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(ornelyonEntryOf(c?.args ?? []), 'C:/x/dist/interface/cli.js');
  assert.ok(!JSON.stringify(c).includes('private'));
  assert.equal(parseClaudeGet('n', 'No MCP server named "n"'), null);
});

test('doctor: clients that are missing or fail give NOT_TESTED / UNKNOWN, never a pass', async () => {
  const none = await findRegistrations(['ornelyon'], async () => ({ code: null, stdout: '' }));
  assert.equal(none.regs.length, 0);
  assert.deepEqual(none.notes.map((n) => n.status), ['NOT_TESTED', 'NOT_TESTED']);
  const broken = await findRegistrations(['ornelyon'], async (cmd) => (cmd === 'codex' ? { code: 1, stdout: '' } : { code: null, stdout: '' }));
  assert.equal(broken.notes[0].status, 'UNKNOWN');
});

test('doctor: the whole diagnosis runs offline, changes nothing, and reports history and passport damage', async () => {
  const h = home();
  const config = defaultConfig();
  config.workspaceRoot = mkdtempSync(join(tmpdir(), 'ornelyon-doctor-ws-'));
  // One synthetic task with a passport.
  const id = randomUUID();
  const now = new Date().toISOString();
  const base: RunRecord = { recordedAt: now, role: 'task', groupId: id, mode: 'L1', kind: 'code', prompt: 'SYNTHETIC', result: { taskId: randomUUID(), agent: 'codex', status: 'success', output: 'o', model: null, errorKind: null, errorMessage: null, errorSignature: null, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0, startedAt: now, durationMs: 1 } };
  appendRecord(base);
  appendRecord({ ...base, role: 'summary', evidence: initialEvidence({ status: 'success', sandbox: 'read-only', verificationRequired: false, checks: [], changedFiles: [] }), notes: [] });
  assert.ok((await savePassportFor(config, id)).ok);

  const fake = async (cmd: string, args: string[]) => {
    if (cmd === 'codex') {
      return { code: 0, stdout: JSON.stringify([{ name: 'ornelyon', transport: { type: 'stdio', command: process.execPath, args: [OWN, 'mcp'] } }]) };
    }
    return args[0] === '--version' ? { code: 0, stdout: '1.0' } : { code: 1, stdout: 'No MCP server named' };
  };
  const before = snapshot(h);
  const ok = await diagnoseMcp(OWN, config, ['ornelyon'], fake);
  assert.equal(snapshot(h), before, 'the diagnosis wrote nothing');
  assert.equal(status(ok, 'mcp-selftest'), 'PASS');
  assert.equal(status(ok, 'passports'), 'PASS');
  assert.equal(status(ok, 'history'), 'PASS');
  assert.equal(status(ok, 'gui'), 'NOT_TESTED', 'a GUI window is never claimed');
  assert.ok(ok.every((i) => i.status !== 'FAIL'));
  assert.ok(!JSON.stringify(ok).includes(h) && !JSON.stringify(ok).includes(JSON.stringify(h).slice(1, -1)), 'the data folder path is not printed');

  // Damage: an unreadable history line and an edited passport.
  appendFileSync(historyPath(), 'garbage\n');
  const file = join(h, 'passports', `${id}.json`);
  writeFileSync(file, readFileSync(file, 'utf8').replace('"SUCCESS"', '"FAILED"'));
  const bad = await diagnoseMcp(OWN, config, ['ornelyon'], fake);
  assert.equal(status(bad, 'history'), 'WARN');
  assert.equal(status(bad, 'passports'), 'FAIL');
  assert.match(bad.find((i) => i.id === 'passports')?.fix ?? '', /passport save/);

  // No registration anywhere is UNKNOWN, not a failure: MCP is optional.
  const empty = await diagnoseMcp(OWN, config, ['ornelyon'], async (cmd) => (cmd === 'codex' ? { code: 0, stdout: '[]' } : { code: null, stdout: '' }));
  assert.equal(status(empty, 'registration'), 'UNKNOWN');
});

test('doctor: paths under the home folder are shortened', () => {
  assert.equal(shortPath('C:\\Users\\someone\\proj\\a.js', 'C:\\Users\\someone'), '~/proj/a.js');
  assert.equal(shortPath('/home/someone/proj', '/home/someone'), '~/proj');
  assert.equal(shortPath('/opt/x', '/home/someone'), '/opt/x');
  assert.equal(shortPath('/home/someone2/x', '/home/someone'), '/home/someone2/x', 'a longer name is not a match');
});

test('doctor: only entries named ornelyon* are asked about (claude mcp get launches the server), and control characters are dropped', async () => {
  const asked: string[] = [];
  const run = async (cmd: string, args: string[]) => {
    asked.push(`${cmd} ${args.join(' ')}`);
    if (cmd === 'codex') {
      return { code: 0, stdout: JSON.stringify([{ name: 'ornelyon', transport: { type: 'stdio', command: 'node\u001b[31m.exe', args: ['/x/dist/interface/cli.js', 'mcp'] } }]) };
    }
    return { code: 0, stdout: args[0] === '--version' ? '1.0' : 'No MCP server named' };
  };
  const found = await findRegistrations(['ornelyon', 'blender'], run);
  assert.ok(asked.some((a) => a === 'claude mcp get ornelyon'));
  assert.ok(!asked.some((a) => a.includes('blender')), 'a foreign entry is never asked about');
  assert.ok(found.notes.some((n) => n.status === 'NOT_TESTED' && n.id.includes('blender')));
  assert.equal(found.regs[0].command, 'node[31m.exe');
});
