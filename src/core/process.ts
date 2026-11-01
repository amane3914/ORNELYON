import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';
import { isWindows } from './paths.js';

export interface ProcessOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  /** Set when the executable could not be started at all (for example ENOENT). */
  spawnError: string | null;
}

export interface RunProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Written to stdin, then stdin is closed. Prompts go here, never into argv. */
  input?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
}

/**
 * Find an executable on PATH. On Windows, `.exe` is preferred over npm `.cmd`
 * shims because `.cmd` files cannot be spawned safely without a shell.
 */
export function resolveExecutable(name: string): string | null {
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter((d) => d !== '');
  const exts = isWindows() ? ['.exe', '.cmd', '.bat', ''] : [''];
  const candidates: string[] = [];
  for (const dir of pathDirs) {
    for (const ext of exts) {
      const file = join(dir, `${name}${ext}`);
      if (existsSync(file)) {
        candidates.push(file);
      }
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  const exe = candidates.find((c) => extname(c).toLowerCase() === '.exe');
  return exe ?? candidates[0];
}

/**
 * Characters that cmd.exe would interpret if an argument reached it. `.cmd` and `.bat` shims
 * have to go through cmd.exe, so arguments containing these are refused instead of quoted.
 */
const CMD_UNSAFE = /["%&|<>^!()\r\n]/;

/** Launch a command for the current platform. `.cmd` and `.bat` files go through cmd.exe. */
function launchSpec(executable: string, args: string[]): { command: string; args: string[] } {
  if (isWindows() && /\.(cmd|bat)$/i.test(executable)) {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', executable, ...args] };
  }
  return { command: executable, args };
}

/** Kill a process and its children. On Windows `child.kill()` does not reach grandchildren. */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  if (isWindows()) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group is already gone.
    }
  }
}

export function runProcess(options: RunProcessOptions): Promise<ProcessOutcome> {
  const maxBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
  return new Promise((resolve) => {
    const isCmdShim = isWindows() && /\.(cmd|bat)$/i.test(options.command);
    if (isCmdShim && options.args.some((a) => CMD_UNSAFE.test(a))) {
      // Refused before anything runs. Pointing the agent setting at the .exe avoids cmd.exe entirely.
      resolve({
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        cancelled: false,
        spawnError: 'unsafe-cmd-arguments: a path or option contains characters cmd.exe would interpret. Set the agent executable to the .exe file.',
      });
      return;
    }
    const launch = launchSpec(options.command, options.args);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: !isWindows(),
        shell: false,
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, cancelled: false, spawnError: String(err) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const finish = (outcome: Omit<ProcessOutcome, 'stdout' | 'stderr'>): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ ...outcome, stdout, stderr });
    };

    const stop = (): void => {
      killTree(child.pid);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);

    const onAbort = (): void => {
      cancelled = true;
      stop();
    };
    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < maxBytes) {
        stdout += chunk;
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < maxBytes) {
        stderr += chunk;
      }
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({ code: null, timedOut, cancelled, spawnError: err.code ?? String(err) });
    });
    child.on('close', (code: number | null) => {
      finish({ code, timedOut, cancelled, spawnError: null });
    });

    if (child.stdin) {
      child.stdin.on('error', () => {
        // The process may exit before reading stdin. The exit code reports the real failure.
      });
      child.stdin.end(options.input ?? '');
    }
  });
}
