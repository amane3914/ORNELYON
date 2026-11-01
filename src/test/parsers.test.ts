import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEvents } from '../agents/codex.js';
import { parseClaudeJson } from '../agents/claude.js';

test('codex events: a failed turn after an earlier message is flagged as failed', () => {
  const stdout = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'partial' } }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'stream broke' } }),
  ].join('\n');
  const parsed = parseEvents(stdout);
  assert.equal(parsed.turnFailed, true);
  assert.equal(parsed.errorText, 'stream broke');
});

test('codex events: a clean turn is not flagged', () => {
  const stdout = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 1 } }),
  ].join('\n');
  const parsed = parseEvents(stdout);
  assert.equal(parsed.turnFailed, false);
  assert.equal(parsed.lastMessage, 'done');
  assert.deepEqual(parsed.usage, { inputTokens: 3, outputTokens: 1 });
});

// Fixtures are synthetic: they keep Codex's on-disk key names but contain no real content.
const fixture = (name: string): string => readFileSync(join(process.cwd(), 'src', 'test', 'fixtures', name), 'utf8');

test('codex rollout fixture: task_complete supplies the final message and token totals', () => {
  const parsed = parseEvents(fixture('codex-events-synthetic.jsonl'));
  assert.equal(parsed.lastMessage, 'synthetic answer');
  assert.equal(parsed.turnFailed, false);
  assert.deepEqual(parsed.usage, { inputTokens: 120, outputTokens: 7 });
});

test('codex rollout fixture: turn_aborted is a failed turn with its reason', () => {
  const parsed = parseEvents(fixture('codex-aborted-synthetic.jsonl'));
  assert.equal(parsed.turnFailed, true);
  assert.equal(parsed.errorText, 'synthetic abort reason');
});

test('claude json: a result with an error subtype is not treated as a finished task', () => {
  const stdout = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: false, result: 'partial text' });
  const parsed = parseClaudeJson(stdout);
  assert.equal(parsed.subtype, 'error_max_turns');
  assert.equal(parsed.result, 'partial text');
});

test('claude json: a result without a subtype keeps the old behaviour (not a failure by itself)', () => {
  const parsed = parseClaudeJson(JSON.stringify({ type: 'result', result: 'ok' }));
  assert.equal(parsed.subtype, null);
  assert.equal(parsed.isError, false);
});
