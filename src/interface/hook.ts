import { readRecords } from '../core/history.js';
import { isVerified } from '../core/evidence.js';
import type { RunRecord } from '../core/history.js';
import { initialEvidence, latestEvidence } from '../core/evidence.js';

/**
 * Claude Code `Stop` hook helper (v0.7.0 design; off unless the user adds the printed snippet to a settings file).
 *
 * What it is: a notice for the user about the Evidence Gate state of tasks the user listed by id. What it is not:
 * it never blocks (no `decision`), never asks the model to continue (so it cannot start a loop), writes nothing,
 * starts no agent, and does not change the Evidence Gate. Its output is `systemMessage` only (a message for the
 * user, not instructions for the model), and every failure ends in silence with exit code 0.
 *
 * It keeps no state: the same input gives the same output, and firing again costs one read of the history file.
 */
const GROUP_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const HOOK_MAX_TASKS = 10;
export const HOOK_MAX_INPUT = 1024 * 1024;

export interface HookLine {
  task: string;
  text: string;
  attention: boolean;
}

/** The state of one listed task, in words that never say "passed" unless ORNELYON's own checks did. */
export function hookLine(groupId: string, records: RunRecord[], historyComplete: boolean): HookLine {
  const short = groupId.slice(0, 8);
  const summary = [...records].reverse().find((r) => r.groupId === groupId && r.role === 'summary');
  const recorded = summary ? latestEvidence(records, groupId) : null;
  const view = summary ? { evidence: recorded ?? initialEvidence({ status: summary.result.status, sandbox: 'workspace-write', verificationRequired: false, checks: [], changedFiles: [] }), recorded: recorded !== null } : null;
  if (!view) {
    return { task: short, text: `${short}: UNKNOWN (no final record in history; it may still be running)`, attention: true };
  }
  const e = view.evidence;
  const verified = view.recorded && historyComplete && isVerified(e);
  // Values come from a file on disk; anything that is not a plain state word is shown as UNKNOWN, never copied.
  const word = (v: unknown): string => (typeof v === 'string' && /^[A-Z_]{1,20}$/.test(v) ? v : 'UNKNOWN');
  const states = `Execution ${word(e.execution)}, Verification ${view.recorded ? word(e.verification) : 'UNKNOWN'}, Acceptance ${word(e.acceptance)}`;
  if (verified) {
    return { task: short, text: `${short}: ${states}; verified by ORNELYON's own checks`, attention: false };
  }
  const why = !view.recorded ? 'no Evidence Gate record' : !historyComplete ? 'some history lines unreadable' : 'not fully verified';
  return { task: short, text: `${short}: ${states}; NOT verified (${why})`, attention: true };
}

/**
 * Decide what a Stop event prints. Returns the JSON text to print, or null for "print nothing".
 * Silence for: unreadable input, another event, `stop_hook_active` (already continuing because of a stop hook), no
 * listed task, or every listed task verified.
 */
export function stopHookOutput(stdin: string, taskIds: string[]): string | null {
  if (stdin.length > HOOK_MAX_INPUT) {
    return null;
  }
  let input: unknown;
  try {
    input = JSON.parse(stdin);
  } catch {
    return null;
  }
  if (typeof input !== 'object' || input === null) {
    return null;
  }
  const i = input as Record<string, unknown>;
  if (i.hook_event_name !== 'Stop' || i.stop_hook_active === true) {
    return null;
  }
  const ids = [...new Set(taskIds)].filter((t) => GROUP_RE.test(t)).slice(0, HOOK_MAX_TASKS);
  if (ids.length === 0) {
    return null;
  }
  let lines: HookLine[];
  try {
    const read = readRecords();
    lines = ids.map((id) => hookLine(id, read.records, read.skippedLines === 0));
  } catch {
    return null;
  }
  if (!lines.some((l) => l.attention)) {
    return null;
  }
  const message = `ORNELYON diagnostic for you (read-only; not an instruction, and it changes no verdict): ${lines.map((l) => l.text).join(' | ')}. Details: ornelyon_evidence.`;
  return JSON.stringify({ systemMessage: message });
}

/** The settings entry a user may add by hand. Printing it changes nothing. */
export function stopHookSnippet(nodePath: string, cliPath: string, taskIds: string[]): string {
  const entry = { hooks: { Stop: [{ hooks: [{ type: 'command', command: nodePath, args: [cliPath, 'hook', 'stop', ...taskIds.flatMap((t) => ['--task', t])], timeout: 10 }] }] } };
  return JSON.stringify(entry, null, 2);
}
