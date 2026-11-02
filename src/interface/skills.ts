import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { packageRoot } from '../core/paths.js';

/**
 * Install helper for the bundled Agent Skills (integrations/skills). It copies plain text files into a folder the
 * user names. It never overwrites or deletes anything it cannot prove it wrote, never touches anything outside
 * `<target>/<skill>`, never edits a client's settings, and does nothing unless `apply` is true (default: dry run).
 *
 * Ownership. Every file ORNELYON writes is listed with its sha256 in the marker file `.ornelyon-skill.json`. A folder
 * counts as ORNELYON's only when it holds exactly the listed files plus the marker (no other file, no link, no extra
 * folder) and every hash matches. The marker alone proves nothing: it is checked against the files themselves. Older
 * markers (`{skill, sha256}` for SKILL.md alone, written by the first v0.7.0 build) are read as a one-file list.
 * Anything else is left alone, and removal deletes only the listed files and the folders that become empty; it never
 * removes a non-empty folder.
 */
const MARKER = '.ornelyon-skill.json';
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const REL_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export function bundledSkillsDir(): string {
  return join(packageRoot(), 'integrations', 'skills');
}

export interface BundledSkill {
  name: string;
  /** SKILL.md text (kept for callers that only need the main file). */
  skillMd: string;
  /** SKILL.md hash, for listings. */
  sha256: string;
  /** Every file to write, by relative path with `/` separators. */
  files: Record<string, string>;
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

function collect(root: string, rel: string, out: Record<string, string>): void {
  for (const e of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isSymbolicLink()) {
      throw new Error(`bundled skill contains a link: ${r}`);
    }
    if (e.isDirectory()) {
      collect(root, r, out);
    } else if (e.isFile()) {
      if (!REL_RE.test(r) || r === MARKER) {
        throw new Error(`bundled skill has an unsupported file name: ${r}`);
      }
      out[r] = readFileSync(join(root, r), 'utf8');
    }
  }
}

export function bundledSkills(dir = bundledSkillsDir()): BundledSkill[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((n) => NAME_RE.test(n) && existsSync(join(dir, n, 'SKILL.md')))
    .sort()
    .map((name) => {
      const files: Record<string, string> = {};
      collect(join(dir, name), '', files);
      return { name, skillMd: files['SKILL.md'], sha256: hash(files['SKILL.md']), files };
    });
}

/** The personal-skills folder each client documents: Claude Code `~/.claude/skills`, Codex `$HOME/.agents/skills`. */
export function defaultTarget(client: string): string | null {
  return client === 'claude' ? join(homedir(), '.claude', 'skills') : client === 'codex' ? join(homedir(), '.agents', 'skills') : null;
}

export type SkillAction = 'INSTALL' | 'UP_TO_DATE' | 'UPDATE' | 'SKIP_FOREIGN' | 'REMOVE' | 'KEEP_MODIFIED' | 'NOT_INSTALLED' | 'LEFTOVER';

export interface SkillPlanItem {
  name: string;
  action: SkillAction;
  detail: string;
}

type Manifest = Record<string, string>;

function readMarker(dir: string, name: string): Manifest | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, MARKER), 'utf8')) as { skill?: unknown; sha256?: unknown; files?: unknown };
    if (m.skill !== name) {
      return null;
    }
    if (typeof m.sha256 === 'string' && m.files === undefined) {
      return { 'SKILL.md': m.sha256 };
    }
    if (typeof m.files === 'object' && m.files !== null) {
      const out: Manifest = {};
      for (const [k, v] of Object.entries(m.files as Record<string, unknown>)) {
        if (!REL_RE.test(k) || k === MARKER || typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) {
          return null;
        }
        out[k] = v;
      }
      return Object.keys(out).includes('SKILL.md') ? out : null;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Every file under `dir` (relative, `/`), or null if anything but plain files and folders is found. */
function listTree(dir: string): string[] | null {
  const out: string[] = [];
  const walk = (rel: string): boolean => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isSymbolicLink()) {
        return false;
      }
      if (e.isDirectory()) {
        if (!walk(r)) {
          return false;
        }
      } else if (e.isFile()) {
        out.push(r);
      } else {
        return false;
      }
    }
    return true;
  };
  return walk('') ? out : null;
}

type Ownership = { kind: 'FOREIGN' } | { kind: 'MODIFIED' } | { kind: 'OWNED'; manifest: Manifest };

/** Decide, from the folder itself, whether it is exactly what ORNELYON wrote. Reads only; follows no link. */
function ownership(dir: string, name: string): Ownership {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return { kind: 'FOREIGN' };
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return { kind: 'FOREIGN' };
  }
  const manifest = readMarker(dir, name);
  if (manifest === null) {
    return { kind: 'FOREIGN' };
  }
  try {
    const tree = listTree(dir);
    const expected = [...Object.keys(manifest), MARKER].sort();
    if (tree === null || tree.slice().sort().join('\n') !== expected.join('\n')) {
      return { kind: 'MODIFIED' };
    }
    for (const [rel, sha] of Object.entries(manifest)) {
      if (hash(readFileSync(join(dir, rel), 'utf8')) !== sha) {
        return { kind: 'MODIFIED' };
      }
    }
    return { kind: 'OWNED', manifest };
  } catch {
    return { kind: 'MODIFIED' };
  }
}

const manifestOf = (s: BundledSkill): Manifest => Object.fromEntries(Object.entries(s.files).map(([k, v]) => [k, hash(v)]));
const sameManifest = (a: Manifest, b: Manifest): boolean => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

function leftovers(target: string, skills: BundledSkill[]): SkillPlanItem[] {
  if (!existsSync(target)) {
    return [];
  }
  const out: SkillPlanItem[] = [];
  for (const n of readdirSync(target).sort()) {
    const owner = skills.find((s) => n.startsWith(`.${s.name}.tmp-`));
    if (owner) {
      out.push({ name: owner.name, action: 'LEFTOVER', detail: `${n} was left by an interrupted install or update; it is safe to delete by hand (ORNELYON never deletes it)` });
    }
  }
  return out;
}

export function planInstall(target: string, skills = bundledSkills()): SkillPlanItem[] {
  const plan = skills.map((s): SkillPlanItem => {
    const dest = join(target, s.name);
    if (!existsSync(dest) && !isLink(dest)) {
      return { name: s.name, action: 'INSTALL', detail: `create ${dest}` };
    }
    const own = ownership(dest, s.name);
    if (own.kind === 'FOREIGN') {
      return { name: s.name, action: 'SKIP_FOREIGN', detail: 'a folder (or link) with this name exists and was not installed by ORNELYON; left untouched' };
    }
    if (own.kind === 'MODIFIED') {
      return { name: s.name, action: 'KEEP_MODIFIED', detail: 'installed earlier but edited, extended or incomplete; left untouched' };
    }
    return sameManifest(own.manifest, manifestOf(s)) ? { name: s.name, action: 'UP_TO_DATE', detail: 'already installed' } : { name: s.name, action: 'UPDATE', detail: 'installed earlier, unchanged since; replace with the bundled version' };
  });
  return [...plan, ...leftovers(target, skills)];
}

export function planRemove(target: string, skills = bundledSkills()): SkillPlanItem[] {
  return [
    ...skills.map((s): SkillPlanItem => {
      const dest = join(target, s.name);
      if (!existsSync(dest) && !isLink(dest)) {
        return { name: s.name, action: 'NOT_INSTALLED', detail: 'nothing to remove' };
      }
      const own = ownership(dest, s.name);
      if (own.kind === 'FOREIGN') {
        return { name: s.name, action: 'SKIP_FOREIGN', detail: 'not installed by ORNELYON; left untouched' };
      }
      return own.kind === 'OWNED' ? { name: s.name, action: 'REMOVE', detail: `delete the files ORNELYON wrote in ${dest}` } : { name: s.name, action: 'KEEP_MODIFIED', detail: 'edited, extended or incomplete since install; left untouched (remove it yourself if you want it gone)' };
    }),
    ...leftovers(target, skills),
  ];
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Delete exactly the listed files, then the folders that became empty. A folder that is not empty is left in place. */
function removeListed(dir: string, manifest: Manifest): void {
  const dirs = new Set<string>();
  for (const rel of [...Object.keys(manifest), MARKER]) {
    unlinkSync(join(dir, rel));
    for (let d = dirname(rel); d !== '.' && d !== ''; d = dirname(d)) {
      dirs.add(d);
    }
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    rmdirSync(join(dir, d));
  }
  rmdirSync(dir);
}

/**
 * Write one skill. The new copy is built in a fresh temporary folder next to the target. An existing copy is first moved
 * aside with one rename, and only the moved copy is inspected and kept as the backup, so what is checked is what is
 * replaced even if the folder changed after the plan was made. A failure moves it back.
 */
function writeSkill(target: string, s: BundledSkill, replace: boolean): 'WRITTEN' | 'CHANGED_MEANWHILE' {
  mkdirSync(target, { recursive: true });
  const dest = join(target, s.name);
  const tmp = mkdtempSync(join(target, `.${s.name}.tmp-`));
  const backup = `${tmp}.old`;
  let moved = false;
  try {
    for (const [rel, text] of Object.entries(s.files)) {
      mkdirSync(dirname(join(tmp, rel)), { recursive: true });
      writeFileSync(join(tmp, rel), text, 'utf8');
    }
    writeFileSync(join(tmp, MARKER), `${JSON.stringify({ version: 2, skill: s.name, files: manifestOf(s) }, null, 2)}\n`, 'utf8');
    if (replace) {
      renameSync(dest, backup);
      moved = true;
      if (ownership(backup, s.name).kind !== 'OWNED') {
        renameSync(backup, dest);
        moved = false;
        removeTree(tmp, s);
        return 'CHANGED_MEANWHILE';
      }
    }
    renameSync(tmp, dest);
    if (moved) {
      const old = ownership(backup, s.name);
      if (old.kind === 'OWNED') {
        removeListed(backup, old.manifest);
      }
    }
    return 'WRITTEN';
  } catch (e) {
    if (moved && !existsSync(dest) && existsSync(backup)) {
      renameSync(backup, dest);
    }
    removeTree(tmp, s);
    throw e;
  }
}

/** Remove a temporary folder this call created: only the files it wrote itself. */
function removeTree(tmp: string, s: BundledSkill): void {
  try {
    removeListed(tmp, manifestOf(s));
  } catch {
    /* a partial temporary folder may stay; it is reported as LEFTOVER and never deleted automatically */
  }
}

export function applyInstall(target: string, skills = bundledSkills()): SkillPlanItem[] {
  const plan = planInstall(target, skills);
  for (const item of plan) {
    if (item.action === 'INSTALL' || item.action === 'UPDATE') {
      const result = writeSkill(target, skills.find((s) => s.name === item.name) as BundledSkill, item.action === 'UPDATE');
      if (result === 'CHANGED_MEANWHILE') {
        item.action = 'KEEP_MODIFIED';
        item.detail = 'changed while the install ran; left as it was';
      }
    }
  }
  return plan;
}

export function applyRemove(target: string, skills = bundledSkills()): SkillPlanItem[] {
  const plan = planRemove(target, skills);
  for (const item of plan) {
    if (item.action !== 'REMOVE') {
      continue;
    }
    const dest = join(target, item.name);
    const aside = `${dest}.removing-${process.pid}`;
    // Move the folder away first so that exactly what is inspected is what is deleted.
    renameSync(dest, aside);
    const own = ownership(aside, item.name);
    if (own.kind === 'OWNED') {
      removeListed(aside, own.manifest);
    } else {
      renameSync(aside, dest);
      item.action = 'KEEP_MODIFIED';
      item.detail = 'changed while the removal ran; left as it was';
    }
  }
  return plan;
}

/** A target must be an existing directory or a path that can be created; relative paths are resolved from the current folder. */
export function resolveTarget(arg: string): string {
  const t = resolve(arg);
  if (existsSync(t) && !statSync(t).isDirectory()) {
    throw new Error(`${t} is not a folder`);
  }
  return t;
}
