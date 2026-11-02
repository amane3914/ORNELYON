// Developer tool, not packaged. Builds an isolated test bed for checking the ORNELYON Skills by hand in Codex and Claude Code:
// a throw-away Git repository, a throw-away ORNELYON data folder holding ONE synthetic task (and its passport), the three
// Skills installed into the repository (dry run printed first), and project-level MCP settings that expose only that task.
// It touches nothing outside <folder>: no user-level Skills, Hooks, MCP registrations or credentials, and it starts no client.
// Usage: node scripts/skills-testbed.mjs <new-empty-folder>      (run `npm run build` first)
// Clean up: delete <folder>. Nothing else was written.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const target = process.argv[2] ? resolve(process.argv[2]) : null;
if (!target) {
  console.error('Usage: node scripts/skills-testbed.mjs <new-empty-folder>');
  process.exit(2);
}
if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(`${target} is not empty; choose a new folder.`);
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const cli = join(dist, 'interface', 'cli.js');
if (!existsSync(cli)) {
  console.error('Run `npm run build` first.');
  process.exit(2);
}

const repo = join(target, 'repo');
const home = join(target, 'ornelyon-home');
const workspace = join(target, 'workspace');
for (const d of [repo, home, workspace]) {
  mkdirSync(d, { recursive: true });
}
process.env.ORNELYON_HOME = home;
delete process.env.CHIMERA_HOME;
const load = (p) => import(pathToFileURL(join(dist, p)).href);
const { defaultConfig, saveConfig } = await load('core/config.js');
const { appendRecord } = await load('core/history.js');
const { initialEvidence } = await load('core/evidence.js');
const { savePassportFor } = await load('interface/service.js');

// One synthetic task. Verification stays UNVERIFIED on purpose, so a correct Evidence Check must say "not verified".
const config = defaultConfig();
config.setupCompleted = true;
config.workspaceRoot = workspace;
saveConfig(config);
const id = randomUUID();
const now = new Date().toISOString();
const base = {
  recordedAt: now,
  role: 'task',
  groupId: id,
  mode: 'L1',
  kind: 'code',
  prompt: 'SYNTHETIC TESTBED TASK (no real work)',
  result: { taskId: randomUUID(), agent: 'codex', status: 'success', output: 'synthetic report', model: null, errorKind: null, errorMessage: null, errorSignature: null, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0, startedAt: now, durationMs: 1 },
};
appendRecord(base);
appendRecord({ ...base, role: 'summary', evidence: initialEvidence({ status: 'success', sandbox: 'read-only', verificationRequired: true, checks: [], changedFiles: [] }), notes: [] });
const saved = await savePassportFor(config, id);
if (!saved.ok) {
  console.error(`passport: ${saved.error}`);
  process.exit(1);
}

// A throw-away Git repository (Codex scans .agents/skills up to the repository root).
execFileSync('git', ['init', '-q', repo]);
writeFileSync(join(repo, 'README.md'), 'Throw-away test bed for the ORNELYON Skills. Safe to delete.\n');

// Skills: dry run first, then install into the repository only.
for (const [dirName, label] of [['.agents/skills', 'Codex'], ['.claude/skills', 'Claude Code']]) {
  const skillsDir = join(repo, dirName);
  console.log(`\n--- ${label}: dry run for ${skillsDir}`);
  console.log(execFileSync(process.execPath, [cli, 'skills', 'install', '--target', skillsDir], { env: process.env, encoding: 'utf8' }).trimEnd());
  console.log(`--- ${label}: apply (inside the test repository only)`);
  console.log(execFileSync(process.execPath, [cli, 'skills', 'install', '--target', skillsDir, '--apply'], { env: process.env, encoding: 'utf8' }).split('\n')[0]);
}

// Project-level MCP settings that expose exactly the one synthetic task. No --all-tasks, no --expose-content.
const server = { command: process.execPath, args: [cli, 'mcp', '--allow-task', id], env: { ORNELYON_HOME: home } };
writeFileSync(join(repo, '.mcp.json'), `${JSON.stringify({ mcpServers: { 'ornelyon-testbed': server } }, null, 2)}\n`);
mkdirSync(join(repo, '.codex'), { recursive: true });
const q = (s) => JSON.stringify(s);
writeFileSync(
  join(repo, '.codex', 'config.toml'),
  `[mcp_servers.ornelyon-testbed]\ncommand = ${q(server.command)}\nargs = [${server.args.map(q).join(', ')}]\n\n[mcp_servers.ornelyon-testbed.env]\nORNELYON_HOME = ${q(home)}\n`,
);

console.log(`
Test bed ready.
  Folder to delete afterwards : ${target}
  Test repository             : ${repo}
  Synthetic task id           : ${id}   (Execution SUCCESS, Verification UNVERIFIED, Acceptance PENDING)
  Written                     : repo/.agents/skills/ornelyon-*, repo/.claude/skills/ornelyon-*, repo/.mcp.json, repo/.codex/config.toml, ornelyon-home/*, workspace/
  Not touched                 : ~/.claude*, ~/.codex*, ~/.agents*, any user-level Skill, Hook or MCP registration.
Manual steps: docs/NATIVE_SKILLS_MANUAL_VERIFICATION.md
`);
