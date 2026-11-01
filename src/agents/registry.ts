import type { AgentKey, ChimeraConfig } from '../core/config.js';
import type { AgentAdapter } from '../core/types.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { LocalLlmAdapter } from './local-llm.js';

/**
 * Build adapters for the agents that are needed.
 * With multi-AI off, only the main agent and an explicitly requested agent are constructed, so
 * other integrations are never loaded. A requested agent that is disabled is still refused per call.
 */
export function buildAdapters(config: ChimeraConfig, requested?: AgentKey): Map<string, AgentAdapter> {
  const wanted = (Object.keys(config.agents) as AgentKey[]).filter((id) => {
    if (id === config.multiAi.mainAgent || id === requested) {
      return true;
    }
    return config.multiAi.enabled && config.agents[id].enabled;
  });
  const adapters = new Map<string, AgentAdapter>();
  for (const id of wanted) {
    adapters.set(id, createAdapter(config, id));
  }
  return adapters;
}

export function createAdapter(config: ChimeraConfig, id: AgentKey): AgentAdapter {
  switch (id) {
    case 'codex':
      return new CodexAdapter({
        model: config.agents.codex.model,
        allowSubagents: config.allowSubagents,
        executable: config.agents.codex.executable,
      });
    case 'claude':
      return new ClaudeAdapter({
        model: config.agents.claude.model,
        budgetUsd: config.agents.claude.budgetUsd,
        tools: config.optimization.tools,
        allowSubagents: config.allowSubagents,
        executable: config.agents.claude.executable,
      });
    case 'local':
      return new LocalLlmAdapter({
        baseUrl: config.agents.local.baseUrl,
        model: config.agents.local.model,
        apiKeyEnv: config.agents.local.apiKeyEnv,
        tools: config.optimization.tools,
      });
  }
}
