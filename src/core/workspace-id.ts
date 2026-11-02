import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from './paths.js';

/**
 * A stable label for "the folder a task was run in" (v0.6.0). It is a search and association aid only.
 *
 * What it is NOT: it is not a permission. Two tasks with the same label ran in the same folder; nothing more
 * follows. No server may expose a task because its label matches (see docs/WORKSPACE_IDENTITY.md).
 *
 * How it is made: the folder is resolved to its real path (symbolic links followed, the file system's own
 * letter case, `/` as separator, no trailing slash) and run through HMAC-SHA256 with a random key that lives in
 * the ORNELYON data folder. Without the key a label cannot be tested against guessed paths such as
 * `C:/Users/<name>/project`, so a label copied into a bug report or a shared history does not reveal the path.
 * The label is cut to 16 hex characters: enough to tell folders apart, not enough to be a fingerprint of the key.
 *
 * Old history has no label. That is UNKNOWN and stays UNKNOWN: it is never worked out afterwards.
 */
export const WORKSPACE_ID_PREFIX = 'ws1:';
const KEY_FILE = 'workspace-id.key';

export function workspaceKeyPath(): string {
  return join(dataDir(), KEY_FILE);
}

/** The real, normalised path text that is hashed. Null when the folder cannot be resolved. */
export function canonicalWorkspacePath(root: string): string | null {
  try {
    const real = realpathSync.native(root).replace(/\\/g, '/').replace(/\/+$/, '');
    // A Windows drive letter is written in capitals by the OS in one place and in lower case in another.
    return /^[a-z]:/.test(real) ? `${real[0].toUpperCase()}${real.slice(1)}` : real;
  } catch {
    return null;
  }
}

function readKey(create: boolean): Buffer | null {
  const file = workspaceKeyPath();
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(text) ? Buffer.from(text, 'hex') : null;
  }
  if (!create) {
    return null;
  }
  mkdirSync(dirname(file), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, `${key.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return key;
}

/**
 * The label of a folder. `create` is true only where ORNELYON writes a task record anyway; a read-only caller
 * (the MCP server, the doctor) passes false and gets null, meaning UNKNOWN, when no key exists yet.
 */
export function workspaceIdFor(root: string, create: boolean): string | null {
  const canonical = canonicalWorkspacePath(root);
  if (canonical === null) {
    return null;
  }
  let key: Buffer | null;
  try {
    key = readKey(create);
  } catch {
    return null;
  }
  return key === null ? null : `${WORKSPACE_ID_PREFIX}${createHmac('sha256', key).update(canonical).digest('hex').slice(0, 16)}`;
}

export type WorkspaceRelation = 'SAME' | 'OTHER' | 'UNKNOWN';

/** Compare a stored label with the folder now. Any missing or malformed side is UNKNOWN, never OTHER. */
export function workspaceRelation(stored: unknown, current: string | null): WorkspaceRelation {
  if (typeof stored !== 'string' || !new RegExp(`^${WORKSPACE_ID_PREFIX}[0-9a-f]{16}$`).test(stored) || current === null) {
    return 'UNKNOWN';
  }
  return stored === current ? 'SAME' : 'OTHER';
}
