import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalize, isAbsolute } from 'node:path';
import { runProcess } from './process.js';
import type { ChangedFile, VerificationCheck } from './evidence.js';
import { hashWorkspaceFile, outOfScope, resolveInsideWorkspace, type Snapshot } from './workspace.js';
import type { SandboxMode } from './types.js';

/** A command the user registered in config. Agents can never add to this list. */
export interface TrustedCommand {
  command: string;
  args: string[];
  timeoutSec: number;
}

export interface VerificationSpec {
  /** Files that must exist. A sha256 pins the exact content that was reviewed. */
  files: { path: string; sha256: string | null }[];
  /** Files that must parse as JSON. */
  jsonFiles: string[];
  /** Names of trusted commands to run. Each one must be registered in config. */
  commands: string[];
  /** Workspace-relative files or folders the run may change. `null` = no scope rule. */
  allowedFiles: string[] | null;
}

export interface VerificationContext {
  root: string;
  sandbox: SandboxMode;
  changed: ChangedFile[];
  /**
   * What the before/after snapshots could not inspect (see Snapshot.gaps). `null` means no snapshot was taken, so
   * nothing was measured. The scope check is PASS only when this is an empty list.
   */
  snapshotGaps: string[] | null;
  commandsEnabled: boolean;
  trusted: Record<string, TrustedCommand>;
}

export function isEmptySpec(spec: VerificationSpec): boolean {
  return spec.files.length === 0 && spec.jsonFiles.length === 0 && spec.commands.length === 0 && spec.allowedFiles === null;
}

/** Reject paths that leave the workspace before any file is touched. */
export function safeRelativePath(path: string): string | null {
  if (path.trim() === '' || isAbsolute(path) || path.includes('\0')) {
    return null;
  }
  const n = normalize(path).replace(/\\/g, '/');
  if (n === '..' || n.startsWith('../')) {
    return null;
  }
  return n;
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The context for the command checks. Changes are not known yet, so they are not here. */
export type CheckContext = Omit<VerificationContext, 'changed' | 'snapshotGaps'>;

/**
 * Run each registered command once and wait for it to finish. Commands can write files, so nothing else may be
 * checked against the workspace until this returns and the final snapshot is taken (see startTask).
 */
export async function runCommandChecks(spec: VerificationSpec, ctx: CheckContext): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];
  for (const name of spec.commands) {
    const trusted = ctx.trusted[name];
    if (!ctx.commandsEnabled) {
      checks.push({ name, kind: 'command', result: 'UNVERIFIED', detail: 'verification commands are disabled (allowVerificationCommands is off)' });
      continue;
    }
    if (!trusted) {
      checks.push({ name, kind: 'command', result: 'UNVERIFIED', detail: 'not registered in the trusted verification list' });
      continue;
    }
    // Only exit status is kept. Output is not stored, because it may contain secrets.
    const out = await runProcess({
      command: trusted.command,
      args: trusted.args,
      cwd: ctx.root,
      timeoutMs: trusted.timeoutSec * 1000,
    });
    if (out.spawnError !== null) {
      checks.push({ name, kind: 'command', result: 'UNVERIFIED', detail: 'the command could not be started' });
    } else if (out.timedOut) {
      checks.push({ name, kind: 'command', result: 'FAIL', detail: 'timed out' });
    } else if (out.code === 0) {
      checks.push({ name, kind: 'command', result: 'PASS', detail: 'exit code 0' });
    } else {
      checks.push({ name, kind: 'command', result: 'FAIL', detail: `exit code ${String(out.code)}` });
    }
  }
  return checks;
}

/**
 * File, hash and JSON checks against the workspace as it is now. Call this only after the final snapshot.
 *   - `snapshot` is that final snapshot. A file whose content no longer matches what the snapshot recorded changed
 *     while it was being checked, so its result is UNVERIFIED, never PASS.
 *   - `snapshotFailed` means the final snapshot could not be taken: nothing read here can be tied to it, so every
 *     result is UNVERIFIED. A file check that already FAILs keeps FAIL.
 */
export function runStateChecks(spec: VerificationSpec, ctx: { root: string; snapshot: Snapshot | null; snapshotFailed?: boolean }): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  const unobserved = 'the final workspace snapshot could not be taken, so this result is not tied to the final state';
  const moved = 'the file changed while it was being checked';
  // A recorded hash that differs from what was just read means the file changed after the snapshot.
  const changedSinceSnapshot = (rel: string, actual: string): boolean => {
    const recorded = ctx.snapshot?.files.get(rel);
    return recorded !== undefined && recorded !== actual;
  };

  for (const f of spec.files) {
    const rel = safeRelativePath(f.path);
    if (rel === null) {
      checks.push({ name: f.path, kind: 'file', result: 'FAIL', detail: 'path is outside the workspace' });
      continue;
    }
    const actual = hashWorkspaceFile(ctx.root, rel);
    if (actual === null) {
      checks.push({ name: rel, kind: 'file', result: 'FAIL', detail: 'file is missing' });
    } else if (f.sha256 !== null && f.sha256 !== actual) {
      checks.push({ name: rel, kind: 'file', result: 'FAIL', detail: 'content does not match the expected sha256' });
    } else if (ctx.snapshotFailed === true) {
      checks.push({ name: rel, kind: 'file', result: 'UNVERIFIED', detail: unobserved });
    } else if (changedSinceSnapshot(rel, actual)) {
      checks.push({ name: rel, kind: 'file', result: 'UNVERIFIED', detail: moved });
    } else {
      checks.push({ name: rel, kind: 'file', result: 'PASS', detail: f.sha256 === null ? 'exists' : 'exists and matches sha256' });
    }
  }

  for (const path of spec.jsonFiles) {
    const rel = safeRelativePath(path);
    if (rel === null) {
      checks.push({ name: path, kind: 'json', result: 'FAIL', detail: 'path is outside the workspace' });
      continue;
    }
    // Same boundary as every other workspace path: links that leave the workspace are refused.
    const real = resolveInsideWorkspace(ctx.root, rel);
    if (real === null) {
      checks.push({ name: rel, kind: 'json', result: 'FAIL', detail: 'file is missing or outside the workspace' });
      continue;
    }
    let raw: Buffer;
    try {
      raw = readFileSync(real);
    } catch {
      checks.push({ name: rel, kind: 'json', result: 'FAIL', detail: 'file could not be read' });
      continue;
    }
    try {
      JSON.parse(raw.toString('utf8'));
    } catch (err) {
      const reason = err instanceof SyntaxError ? 'is not valid JSON' : 'could not be read';
      checks.push({ name: rel, kind: 'json', result: 'FAIL', detail: `file ${reason}` });
      continue;
    }
    if (ctx.snapshotFailed === true) {
      checks.push({ name: rel, kind: 'json', result: 'UNVERIFIED', detail: unobserved });
    } else if (changedSinceSnapshot(rel, createHash('sha256').update(raw).digest('hex'))) {
      checks.push({ name: rel, kind: 'json', result: 'UNVERIFIED', detail: moved });
    } else {
      checks.push({ name: rel, kind: 'json', result: 'PASS', detail: 'parses as JSON' });
    }
  }

  return checks;
}

/** The scope rule. `changed` and `snapshotGaps` must come from a snapshot taken after every command has finished. */
export function scopeCheck(spec: VerificationSpec, ctx: Pick<VerificationContext, 'changed' | 'snapshotGaps'>): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  if (spec.allowedFiles !== null) {
    // A read-only sandbox setting is not evidence: what counts is what the snapshots saw, and whether they saw everything.
    const bad = outOfScope(ctx.changed, spec.allowedFiles);
    if (bad.length > 0) {
      checks.push({ name: 'scope', kind: 'scope', result: 'FAIL', detail: `changed outside the allowed files: ${bad.slice(0, 10).join(', ')}` });
    } else if (ctx.snapshotGaps === null) {
      checks.push({ name: 'scope', kind: 'scope', result: 'UNVERIFIED', detail: 'file changes were not measured for this run' });
    } else if (ctx.snapshotGaps.length > 0) {
      checks.push({ name: 'scope', kind: 'scope', result: 'UNVERIFIED', detail: `no change outside the allowed files was seen, but the check was incomplete (${ctx.snapshotGaps.length}): ${ctx.snapshotGaps.slice(0, 5).join('; ')}` });
    } else {
      checks.push({ name: 'scope', kind: 'scope', result: 'PASS', detail: `${ctx.changed.length} changed file(s), all inside the allowed files; the whole workspace was inspected` });
    }
  }
  return checks;
}

/**
 * Every check in one call, for callers that take no snapshot of their own. Commands run first and once, then the
 * file, hash and JSON checks read the state they left, then the scope rule uses `ctx.changed` as given. The caller
 * must have taken that snapshot after the commands; startTask does, and a caller that did not should not rely on the
 * scope result. Without a snapshot here, the state checks are not compared with one.
 */
export async function runVerification(spec: VerificationSpec, ctx: VerificationContext): Promise<VerificationCheck[]> {
  const commands = await runCommandChecks(spec, ctx);
  return [...runStateChecks(spec, { root: ctx.root, snapshot: null }), ...commands, ...scopeCheck(spec, ctx)];
}
