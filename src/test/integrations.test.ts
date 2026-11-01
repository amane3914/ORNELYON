import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareVersions, extractVersion, tokenEconomizerStatus, versionStatusFor } from '../integrations/token-economizer.js';

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'chimera-home-'));
}

test('version compare orders numeric parts, not strings', () => {
  assert.ok(compareVersions('2.1.311', '2.1.310') > 0);
  assert.ok(compareVersions('0.153.1', '0.164.0') < 0);
  assert.equal(compareVersions('1.0.0', '1.0'), 0);
});

test('version extraction reads the first dotted number from a version line', () => {
  assert.equal(extractVersion('codex-cli 0.162.1'), '0.162.1');
  assert.equal(extractVersion('2.1.311 (Claude Code)'), '2.1.311');
  assert.equal(extractVersion(null), null);
});

test('version status: inside and outside the listed range, and unknown', () => {
  assert.equal(versionStatusFor('codex', '0.162.1'), 'within_supported');
  assert.equal(versionStatusFor('claude', '2.1.311'), 'outside_supported');
  assert.equal(versionStatusFor('claude', null), 'unknown');
});

test('plugin is reported only when its name appears in the agent settings', () => {
  const home = freshHome();
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'tokeneconomizer@local': true } }));
  mkdirSync(join(home, '.codex'));
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "x"\n');
  const claude = tokenEconomizerStatus('claude', 'Claude Code 2.1.311', home);
  assert.equal(claude.pluginFound, true);
  assert.equal(claude.versionStatus, 'outside_supported');
  const codex = tokenEconomizerStatus('codex', 'codex-cli 0.162.1', home);
  assert.equal(codex.pluginFound, false);
  assert.match(codex.note, /does not install it/);
});

test('a missing or unreadable settings file is treated as not configured', () => {
  const home = freshHome();
  const status = tokenEconomizerStatus('claude', null, home);
  assert.equal(status.pluginFound, false);
  assert.equal(status.versionStatus, 'unknown');
});

test('harness2: on a non-Linux machine the backend is BLOCKED and says why', { skip: process.platform === 'linux' }, async () => {
  const { harness2Availability } = await import('../improvement/harness2.js');
  const result = await harness2Availability();
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.checks.find((c) => c.name === 'linux')?.ok, false);
  assert.match(result.reason, /Linux/);
});
