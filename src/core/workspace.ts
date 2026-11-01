import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ChangedFile } from './evidence.js';

/** Folders never hashed. They are large, generated, or hold ORNELYON's own data. Each one is reported as a gap. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.serena', 'data', 'dist', 'dist-package']);
const MAX_FILES = 20000;
/** A file larger than this is not hashed. It is reported as a gap, never skipped silently. */
const MAX_FILE_BYTES = 256 * 1024 * 1024;

export interface Snapshot {
  /** Relative path (forward slashes, relative to the workspace root) to sha256. A link is recorded as `link:<sha256 of its target>`. */
  files: Map<string, string>;
  truncated: boolean;
  /**
   * Everything this snapshot could not look at: skipped folders, unreadable entries, files too large to hash,
   * the file limit. Empty means the whole workspace was inspected. A change in a gap is invisible to a diff.
   */
  gaps: string[];
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/** True when `target` is `root` or lies beneath it, by path relation (not by string prefix). Both must be real, absolute paths. */
export function isInsideReal(realRoot: string, target: string): boolean {
  const rel = relative(realRoot, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The real path of `rel` when it lies inside the workspace, else null. Symbolic links and junctions are
 * resolved first, so a link that points outside the workspace is refused. A missing path, a link loop or
 * any error also gives null: when the boundary cannot be established, the answer is no.
 * Every path a user or agent names (file checks, JSON checks, hashes) goes through here.
 */
export function resolveInsideWorkspace(root: string, rel: string): string | null {
  try {
    if (rel.includes('\0')) {
      return null;
    }
    const realRoot = realpathSync.native(root);
    const full = resolve(realRoot, rel);
    if (!isInsideReal(realRoot, full)) {
      return null;
    }
    const real = realpathSync.native(full);
    return isInsideReal(realRoot, real) ? real : null;
  } catch {
    return null;
  }
}

function hashFileSync(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) {
        break;
      }
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Hash the files under `dir`. Paths are reported relative to `root`, so allowed-file rules written in
 * workspace terms match. Links are never followed; a link is recorded by its target text, so creating or
 * changing one shows up as a change. Whatever could not be inspected is listed in `gaps`.
 */
export function snapshotWorkspace(root: string, dir: string = root, limits: { maxFiles?: number; maxFileBytes?: number } = {}): Snapshot {
  const maxFiles = limits.maxFiles ?? MAX_FILES;
  const maxFileBytes = limits.maxFileBytes ?? MAX_FILE_BYTES;
  const files = new Map<string, string>();
  const gaps = new Set<string>();
  let truncated = false;
  const walk = (current: string): void => {
    if (truncated) {
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(current).sort();
    } catch {
      gaps.add(`unreadable folder: ${toPosix(relative(root, current)) || '.'}`);
      return;
    }
    for (const name of entries) {
      const full = join(current, name);
      const rel = toPosix(relative(root, full));
      let info;
      try {
        info = lstatSync(full);
      } catch {
        gaps.add(`unreadable: ${rel}`);
        continue;
      }
      if (info.isDirectory()) {
        if (SKIP_DIRS.has(name)) {
          gaps.add(`not inspected: ${name}/ (excluded folder)`);
        } else {
          walk(full);
        }
        continue;
      }
      if (!info.isFile() && !info.isSymbolicLink()) {
        gaps.add(`not inspected: ${rel} (not a regular file)`);
        continue;
      }
      if (files.size >= maxFiles) {
        truncated = true;
        gaps.add(`file limit reached (${maxFiles}); the rest of the workspace was not inspected`);
        return;
      }
      try {
        if (info.isSymbolicLink()) {
          files.set(rel, `link:${createHash('sha256').update(readlinkSync(full)).digest('hex')}`);
        } else if (info.size > maxFileBytes) {
          gaps.add(`too large to hash: ${rel}`);
        } else {
          files.set(rel, hashFileSync(full));
        }
      } catch {
        gaps.add(`unreadable: ${rel}`);
      }
    }
  };
  walk(dir);
  return { files, truncated, gaps: [...gaps].sort() };
}

/** Everything that either snapshot could not inspect. */
export function snapshotGaps(before: Snapshot, after: Snapshot): string[] {
  return [...new Set([...before.gaps, ...after.gaps])].sort();
}

/** Files that were added, changed or removed between two snapshots. */
export function diffSnapshots(before: Snapshot, after: Snapshot): ChangedFile[] {
  const changed: ChangedFile[] = [];
  for (const [path, hash] of after.files) {
    if (before.files.get(path) !== hash) {
      changed.push({ path, sha256: hash });
    }
  }
  for (const path of before.files.keys()) {
    if (!after.files.has(path)) {
      changed.push({ path, sha256: null });
    }
  }
  return changed.sort((a, b) => a.path.localeCompare(b.path));
}

/** A changed file is in scope when it equals an allowed path or sits inside an allowed folder. */
export function outOfScope(changed: ChangedFile[], allowed: string[]): string[] {
  const normalized = allowed.map((a) => a.replace(/\\/g, '/').replace(/\/$/, ''));
  return changed
    .map((c) => c.path)
    .filter((p) => !normalized.some((a) => p === a || p.startsWith(`${a}/`)));
}

/** Hash one file inside the workspace. Returns null when it is missing, not a file, or outside the workspace (links included). */
export function hashWorkspaceFile(root: string, rel: string): string | null {
  const real = resolveInsideWorkspace(root, rel);
  if (real === null) {
    return null;
  }
  try {
    if (!lstatSync(real).isFile()) {
      return null;
    }
    return hashFileSync(real);
  } catch {
    return null;
  }
}
