import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../core/paths.js';
import { MCP_PROTOCOL_VERSIONS, MCP_TOOL_NAMES } from './mcp.js';

/**
 * Separate from mcp.ts on purpose: the server module imports nothing that can start a process (a test checks
 * this), while the self-test must start the server as a child.
 */

/** One hash over every file under a folder, so a self-test can show that it changed nothing. */
function snapshotDir(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        walk(p);
      } else {
        parts.push(`${p}:${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
      }
    }
  };
  if (existsSync(dir)) {
    walk(dir);
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/**
 * Offline check of the command a client would run: start the server as a child process, speak MCP to it over
 * stdio, and compare the data folder before and after. It calls only read-only tools and no model. It tests
 * this server, not any GUI: a client's own connection is separate and is reported as not tested.
 */
export async function selfTest(cliPath: string, extraArgs: string[]): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  const check = (pass: boolean, text: string): void => {
    ok = ok && pass;
    lines.push(`${pass ? 'PASS' : 'FAIL'}  ${text}`);
  };
  check(existsSync(process.execPath), `node executable exists: ${process.execPath}`);
  check(existsSync(cliPath), `server entry exists: ${cliPath}`);
  if (!ok) {
    return { ok, lines };
  }
  const folder = dataDir();
  const before = snapshotDir(folder);
  const child = spawn(process.execPath, [cliPath, 'mcp', ...extraArgs], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  const waiting = new Map<number, (m: { result?: Record<string, unknown>; error?: { message: string } }) => void>();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c: string) => {
    buffer += c;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      try {
        const msg = JSON.parse(buffer.slice(0, nl)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
        const done = typeof msg.id === 'number' ? waiting.get(msg.id) : undefined;
        done?.(msg);
      } catch {
        /* not a reply */
      }
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
    }
  });
  child.stderr.resume();
  let nextId = 1;
  const ask = (method: string, params: unknown, timeoutMs = 30000): Promise<{ result?: Record<string, unknown>; error?: { message: string }; ms: number }> =>
    new Promise((resolve) => {
      const id = nextId++;
      const t0 = Date.now();
      const timer = setTimeout(() => resolve({ error: { message: `no reply within ${timeoutMs} ms` }, ms: Date.now() - t0 }), timeoutMs);
      waiting.set(id, (m) => {
        clearTimeout(timer);
        resolve({ ...m, ms: Date.now() - t0 });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const callText = (r: { result?: Record<string, unknown> }): { isError: boolean; text: string } => {
    const c = (r.result?.content as { text: string }[] | undefined)?.[0];
    return { isError: r.result?.isError === true, text: c?.text ?? '' };
  };
  try {
    const init = await ask('initialize', { protocolVersion: MCP_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: 'ornelyon-self-test', version: '1' } });
    check(init.result !== undefined, `initialize answered in ${init.ms} ms (protocol ${String(init.result?.protocolVersion)})`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const list = await ask('tools/list', {});
    const tools = (list.result?.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[] | undefined) ?? [];
    check(tools.length > 0 && tools.every((t) => t.annotations?.readOnlyHint === true), `tools/list: ${tools.length} tool(s), all marked read-only`);
    if (!extraArgs.includes('--tools')) {
      check(tools.length === MCP_TOOL_NAMES.length && MCP_TOOL_NAMES.every((n) => tools.some((t) => t.name === n)), 'offered tools match the tool list of this build');
    }
    const recent = await ask('tools/call', { name: 'ornelyon_recent_tasks', arguments: {} });
    check(recent.result !== undefined && !callText(recent).isError, `ornelyon_recent_tasks answered in ${recent.ms} ms`);
    const plan = await ask('tools/call', { name: 'ornelyon_dispatch_preview', arguments: {} });
    const p = callText(plan);
    check(plan.result !== undefined && !p.isError && /"started": false/.test(p.text), `ornelyon_dispatch_preview answered in ${plan.ms} ms and started nothing`);
    // Detection runs `<agent> --version` and `<agent> auth status`. It is the slowest tool, so a client's tool timeout would hit it first.
    const status = await ask('tools/call', { name: 'ornelyon_status', arguments: {} }, 60000);
    check(status.result !== undefined && !callText(status).isError, `ornelyon_status answered in ${status.ms} ms (runs the agent CLIs' --version and auth status; no model call)`);
    const refused = await ask('tools/call', { name: 'ornelyon_run_task', arguments: { prompt: 'x' } });
    check(refused.error !== undefined, 'an action tool does not exist (ornelyon_run_task is refused)');
  } finally {
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill();
        resolve();
      }, 5000);
      child.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  check(snapshotDir(folder) === before, `data folder unchanged by the run: ${folder}`);
  return { ok, lines };
}
