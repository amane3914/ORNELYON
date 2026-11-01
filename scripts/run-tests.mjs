// Runs every compiled *.test.js under dist/test with the built-in node:test runner.
// Written in plain Node so it works the same on Windows, macOS and Linux.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'dist', 'test');
const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => join(testDir, f));

if (files.length === 0) {
  console.error('No compiled test files found. Run `npm run build` first.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root });
process.exit(result.status ?? 1);
