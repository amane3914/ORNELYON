import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChimeraConfig } from '../core/config.js';
import { readRecords } from '../core/history.js';
import { loadPassport, passportDir } from '../core/passport.js';
import { resolveExecutable, runProcess } from '../core/process.js';
import { selfTest } from './mcp-selftest.js';

/**
 * Diagnosis of the ORNELYON MCP / native-GUI setup. It only looks: it never registers, removes or edits a client
 * setting, and it starts nothing but this build's own self-test and the clients' read-only `get` / `list --json`
 * commands. Every item carries the exact command that would repair it; running that command is up to the user.
 */
export type DoctorStatus = 'PASS' | 'FAIL' | 'WARN' | 'UNKNOWN' | 'NOT_TESTED';

export interface DoctorItem {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  /** What to do about it. A command or a sentence, never run by the doctor. */
  fix: string | null;
}

/** One client's registration of a server, reduced to what the doctor needs. Environment values are never kept. */
export interface Registration {
  client: 'codex' | 'claude';
  name: string;
  command: string;
  args: string[];
  /** What the client itself reports about a connection. Null when the client does not connect on a read. */
  connected: boolean | null;
}

/** Home folder shown as `~`, so a report can be pasted without the account name. */
export function shortPath(p: string, home: string = homedir()): string {
  const norm = (s: string): string => s.replace(/\\/g, '/');
  const a = norm(p);
  const h = norm(home).replace(/\/+$/, '');
  return h !== '' && a.toLowerCase().startsWith(`${h.toLowerCase()}/`) ? `~${a.slice(h.length)}` : p;
}

const same = (a: string, b: string): boolean => {
  const n = (s: string): string => resolve(s).replace(/\\/g, '/');
  return process.platform === 'win32' || process.platform === 'darwin' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/** The cli.js a registration starts, when it starts `ornelyon mcp`. */
export function ornelyonEntryOf(args: string[]): string | null {
  const i = args.findIndex((a) => /(^|[\\/])interface[\\/]cli\.js$/.test(a));
  return i !== -1 && args[i + 1] === 'mcp' ? args[i] : null;
}

/** Codex `mcp list --json`: keep only ORNELYON servers. Other servers' commands and environments are dropped here. */
export function parseCodexList(json: string): Registration[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const out: Registration[] = [];
  for (const s of Array.isArray(data) ? (data as Record<string, unknown>[]) : []) {
    const t = s.transport as { type?: string; command?: unknown; args?: unknown } | undefined;
    if (typeof s.name === 'string' && t?.type === 'stdio' && typeof t.command === 'string' && Array.isArray(t.args) && ornelyonEntryOf(t.args.map(String)) !== null) {
      out.push({ client: 'codex', name: s.name, command: t.command, args: t.args.map(String), connected: null });
    }
  }
  return out;
}

/** Claude Code `mcp get <name>`: the command line, the args line and the status line. The environment block is ignored. */
export function parseClaudeGet(name: string, text: string): Registration | null {
  const line = (key: string): string | null => text.match(new RegExp(`^\\s*${key}:\\s*(.*)$`, 'm'))?.[1].trim() ?? null;
  const command = line('Command');
  const args = line('Args');
  if (command === null || args === null) {
    return null;
  }
  // `claude mcp get` prints the args joined by spaces. A path with a space would be split; the entry check below still works on the pieces.
  const parts = args.split(' ').filter((s) => s !== '');
  const status = line('Status');
  return { client: 'claude', name, command, args: parts, connected: status === null ? null : /✔|Connected/.test(status) ? true : /✘|Failed/.test(status) ? false : null };
}

/** Judge one registration against this build. Pure: the file checks are passed in. */
export function assessRegistration(reg: Registration, ownCli: string, exists: (p: string) => boolean = existsSync): DoctorItem[] {
  const id = `${reg.client}:${reg.name}`;
  const items: DoctorItem[] = [];
  const entry = ornelyonEntryOf(reg.args);
  const reprint = 'Run `node <this build>/dist/interface/cli.js mcp --print-config`, then remove the old entry and add the printed one.';
  if (entry === null) {
    return [{ id, label: `${reg.client} "${reg.name}" starts ORNELYON`, status: 'UNKNOWN', detail: 'The registered command is not `<ornelyon>/interface/cli.js mcp`.', fix: null }];
  }
  const absolute = /^([a-zA-Z]:[\\/]|\/)/.test(reg.command);
  items.push({
    id: `${id}:command`,
    label: `${reg.client} "${reg.name}": program exists`,
    status: absolute ? (exists(reg.command) ? 'PASS' : 'FAIL') : 'WARN',
    detail: absolute ? shortPath(reg.command) : `${reg.command} is found through the client's PATH, which this check cannot see.`,
    fix: absolute && !exists(reg.command) ? `Node.js moved or was removed. ${reprint}` : absolute ? null : 'Register the absolute path printed by `mcp --print-config`.',
  });
  const entryExists = exists(entry);
  items.push({
    id: `${id}:entry`,
    label: `${reg.client} "${reg.name}": server file exists`,
    status: entryExists ? 'PASS' : 'FAIL',
    detail: shortPath(entry),
    fix: entryExists ? null : `The folder was moved or deleted, or the build is missing. Run \`npm run build\` in the ORNELYON folder, or ${reprint}`,
  });
  if (entryExists) {
    const mine = same(entry, ownCli);
    items.push({
      id: `${id}:copy`,
      label: `${reg.client} "${reg.name}": same copy as this build`,
      status: mine ? 'PASS' : 'WARN',
      detail: mine ? 'yes' : `The registration starts another copy: ${shortPath(entry)}`,
      fix: mine ? null : `If that is not intended: ${reprint}`,
    });
  }
  const wide = reg.args.filter((a) => a === '--all-tasks' || a === '--expose-content');
  items.push({
    id: `${id}:scope`,
    label: `${reg.client} "${reg.name}": exposure`,
    status: wide.length > 0 ? 'WARN' : 'PASS',
    detail:
      wide.length > 0
        ? `Started with ${wide.join(' and ')}.`
        : reg.args.includes('--allow-task') || reg.args.includes('--recent')
          ? 'Limited to the tasks chosen when the server starts; no content.'
          : 'No task is visible (the default).',
    fix: wide.length > 0 ? 'Use `--allow-task <id>` and keep content off unless you need it.' : null,
  });
  items.push({
    id: `${id}:connection`,
    label: `${reg.client} "${reg.name}": connection reported by the client`,
    status: reg.connected === true ? 'PASS' : reg.connected === false ? 'FAIL' : 'NOT_TESTED',
    detail: reg.connected === null ? 'This client does not connect when it lists servers. The self-test above covers the server itself.' : reg.connected ? 'connected' : 'failed to connect',
    fix: reg.connected === false ? `Check the two lines above, then run the self-test. If the path is wrong: ${reprint}` : null,
  });
  return items;
}

type Run = (command: string, args: string[]) => Promise<{ code: number | null; stdout: string }>;

const defaultRun: Run = async (command, args) => {
  const exe = resolveExecutable(command);
  if (exe === null) {
    return { code: null, stdout: '' };
  }
  const r = await runProcess({ command: exe, args, cwd: process.cwd(), timeoutMs: 20000 });
  return { code: r.code, stdout: r.stdout };
};

/** Registrations of ORNELYON in the installed clients. `names` are the entries to look for in Claude Code. */
export async function findRegistrations(names: string[], run: Run = defaultRun): Promise<{ regs: Registration[]; notes: DoctorItem[] }> {
  const regs: Registration[] = [];
  const notes: DoctorItem[] = [];
  const codex = await run('codex', ['mcp', 'list', '--json']);
  if (codex.code === null) {
    notes.push({ id: 'codex:cli', label: 'Codex CLI found', status: 'NOT_TESTED', detail: 'codex is not on PATH, so its registration was not looked at.', fix: null });
  } else if (codex.code !== 0) {
    notes.push({ id: 'codex:cli', label: 'Codex registration', status: 'UNKNOWN', detail: 'codex mcp list --json did not succeed.', fix: null });
  } else {
    regs.push(...parseCodexList(codex.stdout));
  }
  const claude = await run('claude', ['--version']);
  if (claude.code === null) {
    notes.push({ id: 'claude:cli', label: 'Claude Code found', status: 'NOT_TESTED', detail: 'claude is not on PATH, so its registration was not looked at.', fix: null });
  } else {
    for (const name of [...new Set(names)]) {
      const got = await run('claude', ['mcp', 'get', name]);
      const reg = got.code === 0 ? parseClaudeGet(name, got.stdout) : null;
      if (reg) {
        regs.push(reg);
      }
    }
  }
  return { regs, notes };
}

/** History and passport health, read only. */
export function historyItems(): DoctorItem[] {
  const items: DoctorItem[] = [];
  const read = readRecords();
  items.push({
    id: 'history',
    label: 'Task history readable',
    status: read.skippedLines > 0 ? 'WARN' : 'PASS',
    detail: `${read.records.length} record(s)${read.skippedLines > 0 ? `, ${read.skippedLines} unreadable line(s) skipped` : ''}`,
    fix: read.skippedLines > 0 ? 'Evidence and continuation answers are marked incomplete while lines are unreadable. Keep a copy of history.jsonl before editing it.' : null,
  });
  let bad = 0;
  let total = 0;
  const dir = passportDir();
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((n) => /^[0-9a-f-]{36}\.json$/.test(n)).slice(0, 200)) {
      total += 1;
      if (!loadPassport(f.slice(0, -5)).passport) {
        bad += 1;
      }
    }
  }
  items.push({
    id: 'passports',
    label: 'Saved passports pass their integrity check',
    status: bad > 0 ? 'FAIL' : 'PASS',
    detail: `${total - bad} of ${total} checked${total === 200 ? ' (first 200)' : ''}`,
    fix: bad > 0 ? 'A refused passport is never used. Save it again with `ornelyon passport save <task-id>` if the task is still in history.' : null,
  });
  return items;
}

/** Workspace state without creating or changing anything. */
export function workspaceItem(config: ChimeraConfig): DoctorItem {
  const p = config.workspaceRoot;
  let status: DoctorStatus = 'PASS';
  let detail = 'folder exists';
  if (!existsSync(p)) {
    status = 'FAIL';
    detail = 'folder does not exist';
  } else if (!statSync(p).isDirectory()) {
    status = 'FAIL';
    detail = 'not a folder';
  } else if (existsSync(join(p, '.git'))) {
    detail = 'folder exists (git repository)';
  } else {
    detail = 'folder exists (not a git repository: the commit is not recorded in passports)';
  }
  return { id: 'workspace-state', label: `Workspace ${shortPath(p)}`, status, detail, fix: status === 'FAIL' ? 'Choose an existing folder with `ornelyon gui` (Settings).' : null };
}

/** The whole MCP / GUI diagnosis. `cliPath` is this build's dist/interface/cli.js. */
export async function diagnoseMcp(cliPath: string, config: ChimeraConfig, names: string[], run: Run = defaultRun): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  items.push({ id: 'node', label: 'Node.js 20 or newer (the one running this check)', status: major >= 20 ? 'PASS' : 'FAIL', detail: process.version, fix: major >= 20 ? null : 'Install Node.js 20 LTS.' });
  items.push(workspaceItem(config));
  items.push(...historyItems());
  const st = await selfTest(cliPath, []);
  const failed = st.lines.filter((l) => l.startsWith('FAIL'));
  items.push({
    id: 'mcp-selftest',
    label: 'ORNELYON MCP server answers (read-only self-test, no model call)',
    status: st.ok ? 'PASS' : 'FAIL',
    detail: st.ok ? `${st.lines.length} step(s) passed` : failed.map((l) => l.replace(/^FAIL\s+/, '')).join('; ').replace(homedir(), '~'),
    fix: st.ok ? null : 'Run `npm run build`, then `node dist/interface/cli.js mcp --self-test` for the full list.',
  });
  const { regs, notes } = await findRegistrations(names, run);
  items.push(...notes);
  if (regs.length === 0) {
    items.push({
      id: 'registration',
      label: 'ORNELYON registered in Codex or Claude Code',
      status: 'UNKNOWN',
      detail: `No ORNELYON entry was found (looked for: ${[...new Set(names)].join(', ')} in Claude Code, any in Codex). MCP is optional; this is only a problem if you expected a GUI to show ORNELYON.`,
      fix: 'Run `node dist/interface/cli.js mcp --print-config` and use the commands it prints.',
    });
  }
  for (const reg of regs) {
    items.push(...assessRegistration(reg, cliPath));
  }
  items.push({ id: 'gui', label: 'Codex app / Claude desktop Code tab show the server', status: 'NOT_TESTED', detail: 'A GUI window cannot be inspected from here. Open the MCP list in the app (see docs/PHASE1_GUI_VERIFICATION.md).', fix: null });
  return items;
}
