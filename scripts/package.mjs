// Builds dist-package/ORNELYON-<version>.zip from a clean build.
// Only runtime files are included: compiled output, the web page, launchers and documents.
// The zip is written by this script on every platform, so entry names always use "/" (the ZIP specification).
// Windows PowerShell 5.1's Compress-Archive writes "\\" instead, which other tools may extract as file names.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = `ORNELYON-${pkg.version}`;
const stage = join(root, 'dist-package', name);
const zipPath = join(root, 'dist-package', `${name}.zip`);

function run(command, args, cwd = root) {
  const res = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
  if (res.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${String(res.status)}`);
  }
}

run(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.json')]);

rmSync(join(root, 'dist-package'), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

cpSync(join(root, 'dist'), join(stage, 'dist'), { recursive: true });
// Compiled tests are for developers; end users do not need them.
rmSync(join(stage, 'dist', 'test'), { recursive: true, force: true });
cpSync(join(root, 'web'), join(stage, 'web'), { recursive: true });
for (const file of [
  'package.json',
  'package-lock.json',
  'LICENSE',
  'README.md',
  'README_ja.md',
  'ARCHITECTURE.md',
  'THIRD_PARTY_NOTICES.md',
  'IMPLEMENTATION_REPORT.md',
  'start-ornelyon.bat',
  'start-ornelyon.sh',
  'start-chimera.bat',
  'start-chimera.sh',
  'UNINSTALL.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
]) {
  if (!existsSync(join(root, file))) {
    throw new Error(`Missing packaged file: ${file}`);
  }
  if (file.endsWith('.bat')) {
    // cmd.exe is most reliable with CRLF line endings.
    writeFileSync(join(stage, file), readFileSync(join(root, file), 'utf8').replace(/\r?\n/g, '\r\n'));
  } else {
    cpSync(join(root, file), join(stage, file));
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/** Entries as { path: 'a/b' relative to the package folder's parent, dir: boolean, file }, parents before children. */
function listEntries(dir, prefix) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, entry.name);
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push({ path: `${path}/`, dir: true, full }, ...listEntries(full, path));
    } else {
      out.push({ path, dir: false, full });
    }
  }
  return out;
}

function writeZip(file, entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.path, 'utf8');
    const data = e.dir ? Buffer.alloc(0) : readFileSync(e.full);
    const body = e.dir ? data : deflateRawSync(data);
    const { time, day } = dosTime(statSync(e.full).mtime);
    const method = e.dir ? 0 : 8;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE((3 << 8) | 20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(method, 10);
    head.writeUInt16LE(time, 12);
    head.writeUInt16LE(day, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(name.length, 28);
    // Unix permissions in the high bits: 0644 files and 0755 folders (no executable bit; the README says so).
    head.writeUInt32LE(((e.dir ? 0o040755 : 0o100644) * 0x10000 + (e.dir ? 0x10 : 0)) >>> 0, 38);
    head.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([head, name]));
    parts.push(local, name, body);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(file, Buffer.concat([...parts, dir, end]));
}

const zipEntries = [{ path: `${name}/`, dir: true, full: stage }, ...listEntries(stage, name)];
writeZip(zipPath, zipEntries);

console.log(`Package written: ${zipPath}`);
