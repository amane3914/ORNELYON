// Developer check, not packaged. Asks a Codex binary's app-server (the engine the Codex app uses) which skills it finds,
// with a scratch HOME and a scratch CODEX_HOME so no real setting or credential is read. It sends no prompt and makes no
// model call. It cannot show how the app or the TUI behave when a skill is invoked: that needs a model turn.
// Usage: node scripts/codex-skills-probe.mjs <path-to-codex> <scratch-home> <scratch-codex-home> [<project-folder>]
// Install the skills into <scratch-home>/.agents/skills first, for example:
//   node dist/interface/cli.js skills install --target <scratch-home>/.agents/skills --apply
import { spawn } from 'node:child_process';

const [bin, home, codexHome, cwd] = process.argv.slice(2);
if (!bin || !home || !codexHome) {
  console.error('Usage: node scripts/codex-skills-probe.mjs <path-to-codex> <scratch-home> <scratch-codex-home> [<project-folder>]');
  process.exit(2);
}
const child = spawn(bin, ['app-server'], { env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'ignore'], cwd: cwd ?? home });
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
const reply = await ask('skills/list', { cwds: cwd ? [cwd] : [], forceReload: true });
if (reply.error || reply.timeout) {
  console.error(`skills/list failed: ${JSON.stringify(reply.error ?? 'timeout')}`);
  child.kill();
  process.exit(1);
}
if (process.env.PROBE_RAW) {
  console.log(JSON.stringify(reply).slice(0, 1500));
}
let found = 0;
for (const entry of reply.result?.data ?? []) {
  for (const s of entry.skills ?? []) {
    if (typeof s.name === 'string' && s.name.startsWith('ornelyon-')) {
      found += 1;
      if (process.env.PROBE_KEYS) {
        const { description, path, ...rest } = s;
        console.log(JSON.stringify(rest));
      }
      console.log(JSON.stringify({ name: s.name, enabled: s.enabled, scope: s.scope, displayName: s.interface?.displayName ?? s.interface?.display_name ?? null, shortDescription: s.shortDescription ?? null }));
    }
  }
  for (const e of entry.errors ?? []) {
    console.log(`error: ${JSON.stringify(e).slice(0, 300)}`);
  }
}
console.log(`ornelyon skills listed: ${found}`);
child.kill();
process.exit(found > 0 ? 0 : 1);
