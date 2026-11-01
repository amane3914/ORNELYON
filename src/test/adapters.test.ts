import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAdapter } from '../agents/codex.js';
import { ClaudeAdapter, parseClaudeJson } from '../agents/claude.js';
import { LocalLlmAdapter, parseChatCompletion } from '../agents/local-llm.js';
import { isolatedHome, fakeSpec } from './helpers.js';
import type { TaskRequest, RunContext } from '../core/types.js';

function request(over: Partial<TaskRequest> = {}): TaskRequest {
  return { id: 'task-1', prompt: 'hello there', cwd: process.cwd(), timeoutMs: 20_000, sandbox: 'read-only', ...over };
}

function ctx(signal: AbortSignal = new AbortController().signal): RunContext {
  return { signal, log: () => {} };
}

function argsRecord(file: string): { args: string[]; stdin: string } {
  return JSON.parse(readFileSync(file, 'utf8')) as { args: string[]; stdin: string };
}

test('codex: detect reads version and sign-in state from the official CLI', async () => {
  isolatedHome();
  const det = await new CodexAdapter({ model: null, allowSubagents: false, spec:fakeSpec('codex', 'ok') }).detect();
  assert.equal(det.installed, true);
  assert.equal(det.version, 'codex-cli 0.0.0-fake');
  assert.equal(det.authenticated, true);
});

test('codex: detect reports not signed in with the official fix', async () => {
  isolatedHome();
  const det = await new CodexAdapter({ model: null, allowSubagents: false, spec:fakeSpec('codex', 'auth') }).detect();
  assert.equal(det.authenticated, false);
  assert.match(det.authNote, /codex login/);
});

test('codex: a successful run returns the final message, sends the prompt on stdin and uses read-only sandbox', async () => {
  const home = isolatedHome();
  const argsFile = join(home, 'args.json');
  const adapter = new CodexAdapter({ model: null, allowSubagents: false, spec:fakeSpec('codex', 'ok', argsFile) });
  const result = await adapter.run(request(), ctx());
  assert.equal(result.status, 'success');
  assert.match(result.output, /hello from fake codex/);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 4 });
  assert.equal(result.costUsd, null, 'Codex does not report USD here, so cost stays unknown');
  const rec = argsRecord(argsFile);
  assert.equal(rec.stdin, 'hello there', 'prompt must travel over stdin, not argv');
  assert.ok(rec.args.includes('read-only'));
  assert.ok(!rec.args.some((a) => a.includes('danger-full-access') || a.includes('approve-for-me')));
});

test('codex: auth failure is classified and reported as unavailable', async () => {
  isolatedHome();
  const result = await new CodexAdapter({ model: null, allowSubagents: false, spec:fakeSpec('codex', 'auth') }).run(request(), ctx());
  assert.equal(result.errorKind, 'not_authenticated');
  assert.equal(result.status, 'unavailable');
});

test('codex: a run that exceeds its timeout is killed and reported as timeout', async () => {
  isolatedHome();
  const started = Date.now();
  const result = await new CodexAdapter({ model: null, allowSubagents: false, spec:fakeSpec('codex', 'hang') }).run(request({ timeoutMs: 800 }), ctx());
  assert.equal(result.status, 'timeout');
  assert.ok(Date.now() - started < 15_000, 'the hung process must not block the harness');
});

test('codex: cancellation stops a running agent', async () => {
  isolatedHome();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const result = await new CodexAdapter({ model: null, allowSubagents: false, spec:fakeSpec('codex', 'hang') }).run(request(), ctx(controller.signal));
  assert.equal(result.status, 'cancelled');
});

test('claude: a successful run reports tokens and the cost the CLI itself reported', async () => {
  const home = isolatedHome();
  const argsFile = join(home, 'claude-args.json');
  const adapter = new ClaudeAdapter({ model: null, budgetUsd: null, tools: [], allowSubagents: false, spec: fakeSpec('claude', 'ok', argsFile) });
  const result = await adapter.run(request(), ctx());
  assert.equal(result.status, 'success');
  assert.equal(result.costUsd, 0.0012);
  assert.equal(result.model, 'fake-model');
  const rec = argsRecord(argsFile);
  assert.ok(rec.args.includes('plan'), 'read-only tasks run in plan mode');
  assert.ok(!rec.args.some((a) => a.includes('dangerously') || a.includes('bypass')));
});

test('claude: dormant and quarantined tools are passed as disallowed, active ones are not', async () => {
  const home = isolatedHome();
  const argsFile = join(home, 'claude-args.json');
  const tools = [
    { name: 'WebFetch', description: '', state: 'DORMANT' as const },
    { name: 'Bash', description: '', state: 'ACTIVE' as const },
    { name: 'Edit', description: '', state: 'QUARANTINED' as const },
  ];
  await new ClaudeAdapter({ model: null, budgetUsd: 2, tools, allowSubagents: false, spec: fakeSpec('claude', 'ok', argsFile) }).run(
    request({ sandbox: 'workspace-write' }),
    ctx(),
  );
  const { args } = argsRecord(argsFile);
  const idx = args.indexOf('--disallowedTools');
  assert.notEqual(idx, -1);
  // Dormant/quarantined tools first, then the sub-agent tools (allowSubagents is off here).
  assert.deepEqual(args.slice(idx + 1), ['WebFetch', 'Edit', 'Task', 'Agent']);
  assert.ok(args.includes('acceptEdits'), 'write-capable tasks use acceptEdits, not a bypass mode');
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '2');
});

test('claude: auth failure from the CLI is classified', async () => {
  isolatedHome();
  const result = await new ClaudeAdapter({ model: null, budgetUsd: null, tools: [], allowSubagents: false, spec: fakeSpec('claude', 'auth') }).run(request(), ctx());
  assert.equal(result.errorKind, 'not_authenticated');
});

test('claude: detect reads loggedIn from auth status and never copies the account email', async () => {
  isolatedHome();
  const det = await new ClaudeAdapter({ model: null, budgetUsd: null, tools: [], allowSubagents: false, spec: fakeSpec('claude', 'ok') }).detect();
  assert.equal(det.authenticated, true);
  assert.ok(!det.authNote.includes('@'));
});

test('claude: unknown output shapes give no guessed numbers', () => {
  const parsed = parseClaudeJson('{"type":"result","is_error":false,"result":"x"}');
  assert.equal(parsed.costUsd, null);
  assert.equal(parsed.usage, null);
  assert.equal(parseClaudeJson('not json').result, null);
});

test('local: sends only ACTIVE tools and parses an OpenAI-style response', async () => {
  isolatedHome();
  let sentBody = '';
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    sentBody = String(init?.body ?? '');
    return new Response(
      JSON.stringify({ model: 'local-model', choices: [{ message: { content: 'local answer' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
      { status: 200 },
    );
  }) as typeof fetch;
  const adapter = new LocalLlmAdapter({
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'm',
    apiKeyEnv: null,
    fetchImpl,
    tools: [
      { name: 'Search', description: 'web search', state: 'ACTIVE' },
      { name: 'Shell', description: 'run commands', state: 'DORMANT' },
    ],
  });
  const result = await adapter.run(request(), ctx());
  assert.equal(result.status, 'success');
  assert.equal(result.output, 'local answer');
  assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3 });
  assert.match(sentBody, /Search/);
  assert.ok(!sentBody.includes('Shell'), 'dormant tools must not be sent to the model');
});

test('local: API key comes from the named environment variable and is never echoed in errors', async () => {
  isolatedHome();
  process.env.CHIMERA_TEST_KEY = 'key-value-123456';
  let sentAuth = '';
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    sentAuth = String((init?.headers as Record<string, string>).authorization);
    return new Response('{"error":"bad key key-value-123456"}', { status: 401 });
  }) as typeof fetch;
  const adapter = new LocalLlmAdapter({ baseUrl: 'http://127.0.0.1:9/v1', model: null, apiKeyEnv: 'CHIMERA_TEST_KEY', tools: [], fetchImpl });
  const result = await adapter.run(request(), ctx());
  assert.equal(sentAuth, 'Bearer key-value-123456');
  assert.equal(result.errorKind, 'not_authenticated');
  assert.ok(!String(result.errorMessage).includes('key-value-123456'));
  delete process.env.CHIMERA_TEST_KEY;
});

test('local: an unreachable server is reported clearly as not installed', async () => {
  isolatedHome();
  const fetchImpl = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  const adapter = new LocalLlmAdapter({ baseUrl: 'http://127.0.0.1:9/v1', model: null, apiKeyEnv: null, tools: [], fetchImpl });
  const result = await adapter.run(request(), ctx());
  assert.equal(result.errorKind, 'not_installed');
  assert.match(String(result.errorMessage), /not reachable/);
});

test('local: malformed responses are not turned into a success', () => {
  assert.equal(parseChatCompletion('<html>'), null);
  assert.equal(parseChatCompletion('{"choices":[]}'), null);
});
