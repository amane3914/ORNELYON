import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Status of Microsoft TokenEconomizer, an optional plugin for Claude Code and Codex.
 *
 * ORNELYON never installs, enables or configures this plugin. It only reads the user's agent
 * configuration (names and presence, never values) and reports what it finds. The plugin
 * runs inside each agent's own session, so its effect is outside ORNELYON's control.
 */
export const TOKEN_ECONOMIZER_REPO = 'https://github.com/microsoft/TokenEconomizer';

/**
 * Version ranges the upstream wiki lists as supported. Taken from a secondary search summary,
 * not from the repository itself. Check the wiki before relying on them.
 */
export const SUPPORTED_VERSIONS: Record<'claude' | 'codex', { min: string; max: string }> = {
  claude: { min: '2.1.300', max: '2.1.310' },
  codex: { min: '0.153.1', max: '0.164.0' },
};

export type VersionStatus = 'within_supported' | 'outside_supported' | 'unknown';

export interface TokenEconomizerStatus {
  agent: 'claude' | 'codex';
  /** True when the agent's configuration names TokenEconomizer (for example, an enabled plugin entry). */
  pluginFound: boolean;
  /** Where the name was found. Never the value. */
  pluginSource: string | null;
  agentVersion: string | null;
  versionStatus: VersionStatus;
  supportedRange: string;
  note: string;
}

/** Compare dotted numeric versions. Returns negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/** Pull the first x.y.z out of a `--version` line such as "codex-cli 0.162.1". */
export function extractVersion(text: string | null): string | null {
  const match = text?.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

export function versionStatusFor(agent: 'claude' | 'codex', version: string | null): VersionStatus {
  if (version === null) {
    return 'unknown';
  }
  const range = SUPPORTED_VERSIONS[agent];
  const inside = compareVersions(version, range.min) >= 0 && compareVersions(version, range.max) <= 0;
  return inside ? 'within_supported' : 'outside_supported';
}

/** Read a file if it exists. Returns '' on any error. Only used for name checks. */
function readIfExists(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

/**
 * Look for TokenEconomizer in the agent's own settings. Only the presence of the name is
 * checked, so no configuration value is ever returned or stored.
 */
export function findPluginName(agent: 'claude' | 'codex', home: string = homedir()): { found: boolean; source: string | null } {
  if (agent === 'claude') {
    const text = readIfExists(join(home, '.claude', 'settings.json'));
    try {
      const plugins = (JSON.parse(text) as { enabledPlugins?: Record<string, unknown> }).enabledPlugins ?? {};
      const hit = Object.keys(plugins).find((k) => k.toLowerCase().includes('tokeneconomizer'));
      return hit ? { found: true, source: 'settings.json enabledPlugins' } : { found: false, source: null };
    } catch {
      return { found: false, source: null };
    }
  }
  const text = readIfExists(join(home, '.codex', 'config.toml'));
  return /tokeneconomizer/i.test(text) ? { found: true, source: 'config.toml' } : { found: false, source: null };
}

export function tokenEconomizerStatus(
  agent: 'claude' | 'codex',
  agentVersionLine: string | null,
  home: string = homedir(),
): TokenEconomizerStatus {
  const { found, source } = findPluginName(agent, home);
  const version = extractVersion(agentVersionLine);
  const versionStatus = versionStatusFor(agent, version);
  const range = SUPPORTED_VERSIONS[agent];
  const supportedRange = `${range.min} to ${range.max}`;
  let note: string;
  if (!found) {
    note = `Not found in ${agent} settings. ORNELYON does not install it. See ${TOKEN_ECONOMIZER_REPO}.`;
  } else if (versionStatus === 'outside_supported') {
    note = `Plugin found, but the installed ${agent} ${version} is outside the listed range (${supportedRange}). Its effect is not verified.`;
  } else if (versionStatus === 'unknown') {
    note = 'Plugin found. The agent version could not be read, so compatibility is unknown.';
  } else {
    note = 'Plugin found and the agent version is inside the listed range. Its effect inside agent sessions is not measured by ORNELYON.';
  }
  return { agent, pluginFound: found, pluginSource: source, agentVersion: version, versionStatus, supportedRange, note };
}
