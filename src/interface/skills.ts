import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { packageRoot } from '../core/paths.js';

/**
 * Install helper for the bundled Agent Skills (integrations/skills). It copies plain text files into a folder the
 * user names. It never overwrites a skill it did not install, never touches anything outside `<target>/<skill>`,
 * never edits a client's settings, and does nothing unless `apply` is true (the default is a dry run).
 */
const MARKER = '.ornelyon-skill.json';

export function bundledSkillsDir(): string {
  return join(packageRoot(), 'integrations', 'skills');
}

export interface BundledSkill {
  name: string;
  skillMd: string;
  sha256: string;
}

export function bundledSkills(dir = bundledSkillsDir()): BundledSkill[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((n) => existsSync(join(dir, n, 'SKILL.md')))
    .sort()
    .map((name) => {
      const skillMd = readFileSync(join(dir, name, 'SKILL.md'), 'utf8');
      return { name, skillMd, sha256: createHash('sha256').update(skillMd).digest('hex') };
    });
}

/** The personal-skills folder each client documents: Claude Code `~/.claude/skills`, Codex `$HOME/.agents/skills`. */
export function defaultTarget(client: string): string | null {
  return client === 'claude' ? join(homedir(), '.claude', 'skills') : client === 'codex' ? join(homedir(), '.agents', 'skills') : null;
}

export type SkillAction = 'INSTALL' | 'UP_TO_DATE' | 'UPDATE' | 'SKIP_FOREIGN' | 'REMOVE' | 'KEEP_MODIFIED' | 'NOT_INSTALLED';

export interface SkillPlanItem {
  name: string;
  action: SkillAction;
  detail: string;
}

interface Marker {
  skill: string;
  sha256: string;
}

function readMarker(dir: string): Marker | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, MARKER), 'utf8')) as Marker;
    return typeof m.skill === 'string' && typeof m.sha256 === 'string' ? m : null;
  } catch {
    return null;
  }
}

/**
 * Is the installed folder exactly what ORNELYON wrote? Null: not ours (no readable marker, or a marker for another name).
 * False: ours once, but changed (SKILL.md edited, or any file added). Only a folder holding exactly SKILL.md and the
 * marker, with SKILL.md matching the marker, may be replaced or deleted, so user files next to it are never lost.
 */
function ownedAndUnchanged(dir: string, name: string): boolean | null {
  const marker = readMarker(dir);
  if (!marker || marker.skill !== name) {
    return null;
  }
  try {
    const entries = readdirSync(dir).sort();
    if (entries.length !== 2 || entries[0] !== MARKER || entries[1] !== 'SKILL.md') {
      return false;
    }
    return createHash('sha256').update(readFileSync(join(dir, 'SKILL.md'), 'utf8')).digest('hex') === marker.sha256;
  } catch {
    return false;
  }
}

export function planInstall(target: string, skills = bundledSkills()): SkillPlanItem[] {
  return skills.map((s) => {
    const dest = join(target, s.name);
    if (!existsSync(dest)) {
      return { name: s.name, action: 'INSTALL', detail: `create ${dest}` };
    }
    const own = ownedAndUnchanged(dest, s.name);
    if (own === null) {
      return { name: s.name, action: 'SKIP_FOREIGN', detail: 'a folder with this name exists and was not installed by ORNELYON; left untouched' };
    }
    if (!own) {
      return { name: s.name, action: 'KEEP_MODIFIED', detail: 'installed earlier but edited or extended since; left untouched' };
    }
    const marker = readMarker(dest);
    return marker?.sha256 === s.sha256 ? { name: s.name, action: 'UP_TO_DATE', detail: 'already installed' } : { name: s.name, action: 'UPDATE', detail: 'installed earlier, unchanged since; replace with the bundled version' };
  });
}

export function planRemove(target: string, skills = bundledSkills()): SkillPlanItem[] {
  return skills.map((s) => {
    const dest = join(target, s.name);
    if (!existsSync(dest)) {
      return { name: s.name, action: 'NOT_INSTALLED', detail: 'nothing to remove' };
    }
    const own = ownedAndUnchanged(dest, s.name);
    if (own === null) {
      return { name: s.name, action: 'SKIP_FOREIGN', detail: 'not installed by ORNELYON; left untouched' };
    }
    return own ? { name: s.name, action: 'REMOVE', detail: `delete ${dest}` } : { name: s.name, action: 'KEEP_MODIFIED', detail: 'edited or extended since install; left untouched (remove it yourself if you want it gone)' };
  });
}

/** Write one skill atomically: a temporary sibling folder first, then a rename. A failure leaves nothing half written. */
function writeSkill(target: string, s: BundledSkill, replace: boolean): void {
  const dest = join(target, s.name);
  mkdirSync(target, { recursive: true });
  // A fresh, uniquely named folder: nothing planted beforehand can be written through.
  const tmp = mkdtempSync(join(target, `.${s.name}.tmp-`));
  const backup = `${tmp}.old`;
  let moved = false;
  try {
    writeFileSync(join(tmp, 'SKILL.md'), s.skillMd, 'utf8');
    writeFileSync(join(tmp, MARKER), `${JSON.stringify({ skill: s.name, sha256: s.sha256 }, null, 2)}\n`, 'utf8');
    if (replace) {
      // Keep the old copy until the new one is in place, so a failure restores it.
      renameSync(dest, backup);
      moved = true;
    }
    renameSync(tmp, dest);
    rmSync(backup, { recursive: true, force: true });
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    if (moved && !existsSync(dest)) {
      renameSync(backup, dest);
    }
    throw e;
  }
}

export function applyInstall(target: string, skills = bundledSkills()): SkillPlanItem[] {
  const plan = planInstall(target, skills);
  mkdirSync(target, { recursive: true });
  for (const item of plan) {
    if (item.action === 'INSTALL' || item.action === 'UPDATE') {
      writeSkill(target, skills.find((s) => s.name === item.name) as BundledSkill, item.action === 'UPDATE');
    }
  }
  return plan;
}

export function applyRemove(target: string, skills = bundledSkills()): SkillPlanItem[] {
  const plan = planRemove(target, skills);
  for (const item of plan) {
    if (item.action === 'REMOVE') {
      rmSync(join(target, item.name), { recursive: true, force: true });
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
