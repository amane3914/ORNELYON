import type { ToolEntry, ToolState } from '../core/config.js';

/**
 * Tool dormancy. A tool is never deleted; its state only changes.
 *   ACTIVE       normal use
 *   DORMANT      temporarily sealed; can be restored
 *   QUARANTINED  isolated because of an error or risk
 *   DISABLED     explicitly turned off by the user
 * Only ACTIVE tools reach a model. Everything else is removed before sending.
 */

export const TOOL_STATES: ToolState[] = ['ACTIVE', 'DORMANT', 'QUARANTINED', 'DISABLED'];

export function activeTools(tools: ToolEntry[]): ToolEntry[] {
  return tools.filter((t) => t.state === 'ACTIVE');
}

/** Names that must not be used. Passed to Claude Code as `--disallowedTools`. */
export function dormantToolNames(tools: ToolEntry[]): string[] {
  return tools.filter((t) => t.state !== 'ACTIVE').map((t) => t.name);
}

/** Pure state change. Returns a new list; throws when the tool is unknown. */
export function setToolState(tools: ToolEntry[], name: string, state: ToolState): ToolEntry[] {
  if (!TOOL_STATES.includes(state)) {
    throw new Error(`Unknown tool state: ${state}`);
  }
  if (!tools.some((t) => t.name === name)) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return tools.map((t) => (t.name === name ? { ...t, state } : t));
}
