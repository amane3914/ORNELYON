import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packageRoot } from '../core/paths.js';
import type { CommandSpec } from '../agents/spec.js';

/** Give each test its own data folder so the user's real config and history are never touched. */
export function isolatedHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'chimera-test-'));
  process.env.CHIMERA_HOME = dir;
  return dir;
}

export function fakeAgentScript(): string {
  return resolve(packageRoot(), 'scripts', 'fake-agent.mjs');
}

/** Run the real adapter code against scripts/fake-agent.mjs instead of the installed CLI. */
export function fakeSpec(shape: 'codex' | 'claude', mode: string, argsFile?: string): CommandSpec {
  return {
    command: process.execPath,
    prefixArgs: [fakeAgentScript(), shape],
    extraEnv: {
      FAKE_MODE: mode,
      ...(argsFile ? { FAKE_ARGS_FILE: argsFile } : {}),
    },
  };
}
