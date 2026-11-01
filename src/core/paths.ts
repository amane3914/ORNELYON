import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Install root: the folder that contains package.json (two levels above dist/core). */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * Data folder. `ORNELYON_HOME` or the legacy `CHIMERA_HOME` overrides it (tests and portable installs).
 * The legacy variable stays supported, so existing setups keep their data.
 */
export function dataDir(): string {
  const override = process.env.ORNELYON_HOME || process.env.CHIMERA_HOME;
  return override ? resolve(override) : join(packageRoot(), 'data');
}

export function configPath(): string {
  return join(dataDir(), 'config.json');
}

export function historyPath(): string {
  return join(dataDir(), 'history.jsonl');
}

/** True when `target` is `root` or lies beneath it. Both paths must already be absolute. */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolve a requested working directory and make sure it stays inside the
 * workspace root. Symlinks are resolved first so a link cannot point outside.
 * Throws when the path escapes the root or does not exist.
 */
export function resolveWorkspacePath(root: string, requested: string | undefined): string {
  const realRoot = realpathSync(resolve(root));
  const candidate = resolve(realRoot, requested && requested.trim() !== '' ? requested : '.');
  if (!existsSync(candidate)) {
    throw new Error(`Working directory does not exist: ${candidate}`);
  }
  const realCandidate = realpathSync(candidate);
  if (!isInside(realRoot, realCandidate)) {
    throw new Error(`Working directory ${realCandidate} is outside the workspace root ${realRoot}`);
  }
  return realCandidate;
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}

export { sep };
