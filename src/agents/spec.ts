/**
 * How to launch an agent executable. Production adapters resolve the official CLI on PATH.
 * Tests replace it with `node fake-agent.mjs` to exercise the real spawn, timeout and parsing code.
 */
export interface CommandSpec {
  command: string;
  prefixArgs: string[];
  extraEnv: Record<string, string>;
}
