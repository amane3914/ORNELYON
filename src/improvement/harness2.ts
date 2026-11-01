import { resolveExecutable, runProcess } from '../core/process.js';

/**
 * Optional Research backend: Google Harness² (google-research/harness2, Apache-2.0).
 *
 * ORNELYON does not bundle or import Harness². It only checks whether the documented
 * requirements exist on this machine, so a user can see whether the official framework could
 * run here. Nothing is installed, and nothing is required when this backend is not selected.
 */
export const HARNESS2_REPO = 'https://github.com/google-research/harness2';

export interface Harness2Availability {
  /** REFERENCED: design ideas only. CONNECTED is never claimed by this module. */
  state: 'BLOCKED' | 'AVAILABLE';
  platform: string;
  checks: { name: string; ok: boolean; detail: string }[];
  reason: string;
}

/**
 * Check the documented setup requirements: Linux, Python 3.12 and uv.
 * Only version output is read. The probe runs nothing from the Harness² repository.
 */
export async function harness2Availability(): Promise<Harness2Availability> {
  const cwd = process.cwd();
  const platformOk = process.platform === 'linux';
  const checks: Harness2Availability['checks'] = [{ name: 'linux', ok: platformOk, detail: process.platform }];

  const py = resolveExecutable('python3.12');
  let pyOk = false;
  if (py) {
    const out = await runProcess({ command: py, args: ['--version'], cwd, timeoutMs: 10_000, input: '' });
    pyOk = out.code === 0 && /Python 3\.12/.test(`${out.stdout}${out.stderr}`);
  }
  checks.push({ name: 'python3.12', ok: pyOk, detail: pyOk ? 'found' : 'not found' });

  const uv = resolveExecutable('uv');
  checks.push({ name: 'uv', ok: uv !== null, detail: uv !== null ? 'found' : 'not found' });

  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  const available = failed.length === 0;
  return {
    state: available ? 'AVAILABLE' : 'BLOCKED',
    platform: process.platform,
    checks,
    reason: available
      ? 'Requirements are present. The framework is not run by ORNELYON yet; each run needs an explicit user action.'
      : `Missing on this machine: ${failed.join(', ')}. Harness² documents Linux, Python 3.12 and uv.`,
  };
}
