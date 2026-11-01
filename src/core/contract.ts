import type { SandboxMode } from './types.js';

/**
 * Delegation Contract v1. One record per agent invocation. It states what the call may do.
 *
 * Enforced by ORNELYON (hard): depth, call count, timeout, budget, sandbox mode, the process kill.
 * Checked after the run (detected, not prevented): allowed files, through the workspace snapshot.
 * Depends on the agent (cooperative): anything written in `objective` or `expectedOutput`.
 * A natural-language instruction is never treated as a permission limit by itself.
 */
export const CONTRACT_VERSION = 1;

export interface DelegationContract {
  version: 1;
  invocationId: string;
  parentInvocationId: string | null;
  taskId: string;
  groupId: string;
  agent: string;
  model: string | null;
  role: 'task' | 'review' | 'handoff';
  objective: string;
  /** Workspace-relative files or folders. `null` = no file rule. */
  allowedFiles: string[] | null;
  permissions: { sandbox: SandboxMode };
  timeoutSec: number;
  budgetUsd: number | null;
  invocationDepth: number;
  maxDepth: number;
  expectedOutput: string;
  verificationRequirements: string[];
}

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const ROLES = ['task', 'review', 'handoff'];
const SANDBOXES = ['read-only', 'workspace-write'];
const AGENTS = ['codex', 'claude', 'local'];

/** Returns every problem found. An empty list means the contract is valid. */
export function validateContract(c: unknown): string[] {
  const errors: string[] = [];
  if (typeof c !== 'object' || c === null || Array.isArray(c)) {
    return ['contract must be an object'];
  }
  const x = c as Record<string, unknown>;
  if (x.version !== CONTRACT_VERSION) {
    errors.push(`unsupported version ${String(x.version)}`);
  }
  for (const key of ['invocationId', 'taskId', 'groupId'] as const) {
    if (typeof x[key] !== 'string' || !ID_RE.test(x[key] as string)) {
      errors.push(`${key} must be an id of 1 to 64 letters, digits or dashes`);
    }
  }
  if (x.parentInvocationId !== null && (typeof x.parentInvocationId !== 'string' || !ID_RE.test(x.parentInvocationId))) {
    errors.push('parentInvocationId must be null or an id');
  }
  if (typeof x.agent !== 'string' || !AGENTS.includes(x.agent)) {
    errors.push('agent must be codex, claude or local');
  }
  if (typeof x.role !== 'string' || !ROLES.includes(x.role)) {
    errors.push('role must be task, review or handoff');
  }
  if (typeof x.objective !== 'string' || x.objective.trim() === '' || x.objective.length > 2000) {
    errors.push('objective must be 1 to 2000 characters');
  }
  if (x.allowedFiles !== null) {
    if (!Array.isArray(x.allowedFiles) || x.allowedFiles.length > 200) {
      errors.push('allowedFiles must be null or a list of up to 200 paths');
    } else {
      for (const p of x.allowedFiles) {
        if (typeof p !== 'string' || p.trim() === '' || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes('..')) {
          errors.push(`allowedFiles entry is not a safe relative path: ${String(p)}`);
        }
      }
    }
  }
  const perms = x.permissions as Record<string, unknown> | undefined;
  if (typeof perms !== 'object' || perms === null || typeof perms.sandbox !== 'string' || !SANDBOXES.includes(perms.sandbox)) {
    errors.push('permissions.sandbox must be read-only or workspace-write');
  }
  if (typeof x.timeoutSec !== 'number' || x.timeoutSec < 1 || x.timeoutSec > 3600) {
    errors.push('timeoutSec must be between 1 and 3600');
  }
  if (x.budgetUsd !== null && (typeof x.budgetUsd !== 'number' || x.budgetUsd < 0)) {
    errors.push('budgetUsd must be null or zero or more');
  }
  if (typeof x.maxDepth !== 'number' || x.maxDepth < 0 || x.maxDepth > 3) {
    errors.push('maxDepth must be between 0 and 3');
  }
  if (typeof x.invocationDepth !== 'number' || x.invocationDepth < 0 || typeof x.maxDepth === 'number' && x.invocationDepth > x.maxDepth) {
    errors.push('invocationDepth must be between 0 and maxDepth (recursion limit)');
  }
  if (typeof x.expectedOutput !== 'string' || x.expectedOutput.length > 500) {
    errors.push('expectedOutput must be a string of up to 500 characters');
  }
  if (!Array.isArray(x.verificationRequirements) || x.verificationRequirements.some((v) => typeof v !== 'string')) {
    errors.push('verificationRequirements must be a list of strings');
  }
  return errors;
}

export function buildContract(input: Omit<DelegationContract, 'version'>): DelegationContract {
  return { version: CONTRACT_VERSION, ...input };
}
