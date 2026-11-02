// Developer check, not packaged. Asks a Codex binary's app-server (the engine the Codex app uses) which MCP servers a
// config.toml defines and what each offers. It starts the servers and lists their tools; it sends no prompt and makes no model call.
// Usage: node scripts/codex-mcp-probe.mjs <path-to-codex> <codex-home-with-config.toml>
// Use a scratch codex home that holds only the servers you want to test, so no other server is started.
import { spawn } from 'node:child_process';

const [bin, home] = process.argv.slice(2);
if (!bin || !home) {
  console.error('Usage: node scripts/codex-mcp-probe.mjs <path-to-codex> <codex-home>');
  process.exit(2);
}
const child = spawn(bin, ['app-server'], { env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'] });
const pending = new Map();
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let nl = buffer.indexOf('\n');
  while (nl !== -1) {
    try {
      const msg = JSON.parse(buffer.slice(0, nl));
      pending.get(msg.id)?.(msg);
    } catch {
      /* not a reply */
    }
    buffer = buffer.slice(nl + 1);
    nl = buffer.indexOf('\n');
  }
});
let nextId = 1;
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => resolve({ timeout: true }), 20000);
    pending.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

const init = await ask('initialize', { clientInfo: { name: 'ornelyon-probe', version: '1' } });
if (!init.result) {
  console.error('app-server did not answer initialize');
  child.kill();
  process.exit(1);
}
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
let data = [];
for (let attempt = 0; attempt < 6; attempt++) {
  data = (await ask('mcpServerStatus/list', {})).result?.data ?? [];
  if (data.length > 0 && data.every((d) => Object.keys(d.tools ?? {}).length > 0 || d.toolsError)) {
    break;
  }
  await new Promise((r) => setTimeout(r, 1500));
}
for (const d of data) {
  const tools = Object.values(d.tools ?? {});
  const readOnly = tools.length > 0 && tools.every((t) => t.annotations?.readOnlyHint === true);
  console.log(`${d.name}: ${d.toolsError ? `FAILED ${d.toolsError}` : `OK ${tools.length} tool(s), all read-only: ${readOnly}`}`);
  for (const t of tools) {
    console.log(`  ${t.name}`);
  }
}
child.kill();
process.exit(data.some((d) => d.toolsError) ? 1 : 0);
