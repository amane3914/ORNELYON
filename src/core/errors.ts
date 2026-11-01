import type { ErrorKind } from './types.js';
import { redact } from './redact.js';

export interface ClassifiedError {
  kind: ErrorKind;
  message: string;
  /** Normalized form used to detect repeated failures. Digits, hex ids and paths are masked. */
  signature: string;
}

export interface ErrorInput {
  spawnError: string | null;
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
  cancelled: boolean;
}

const RULES: Array<{ kind: ErrorKind; pattern: RegExp }> = [
  { kind: 'not_authenticated', pattern: /not logged in|login required|please log ?in|unauthori[sz]ed|authentication|invalid api key|api key not set|\b401\b/i },
  { kind: 'rate_limited', pattern: /rate limit|too many requests|\b429\b|quota|usage limit/i },
  { kind: 'invalid_request', pattern: /invalid (?:request|argument|model)|unknown model|\b400\b/i },
];

/** Mask values that change between runs so that the same failure gets the same signature. */
export function normalizeSignature(text: string): string {
  return text
    .toLowerCase()
    .replace(/[a-z]:\\[^\s"']+|\/[^\s"']*\/[^\s"']*/g, '<path>')
    .replace(/\b[0-9a-f]{8,}\b/g, '<hex>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export function classifyFailure(input: ErrorInput, secrets: string[] = []): ClassifiedError {
  const combined = `${input.stderr}\n${input.stdout}`.trim();
  const safeText = redact(combined, secrets);
  const firstLine = (safeText.split('\n').find((l) => l.trim() !== '') ?? '').slice(0, 300);

  if (input.cancelled) {
    return { kind: 'cancelled', message: 'Run was cancelled.', signature: 'cancelled' };
  }
  if (input.timedOut) {
    return { kind: 'timeout', message: 'Run exceeded its time limit and was stopped.', signature: 'timeout' };
  }
  if (input.spawnError !== null) {
    const missing = /ENOENT/.test(input.spawnError);
    return {
      kind: missing ? 'not_installed' : 'unknown',
      message: missing ? 'The agent command was not found on PATH.' : `Could not start the agent process (${input.spawnError}).`,
      signature: normalizeSignature(input.spawnError),
    };
  }
  for (const rule of RULES) {
    if (rule.pattern.test(safeText)) {
      return { kind: rule.kind, message: firstLine || rule.kind, signature: normalizeSignature(firstLine || rule.kind) };
    }
  }
  if (input.exitCode !== 0) {
    const message = firstLine || `Agent exited with code ${String(input.exitCode)}.`;
    return { kind: 'agent_failed', message, signature: normalizeSignature(message) };
  }
  return { kind: 'unknown', message: firstLine || 'Unknown error.', signature: normalizeSignature(firstLine || 'unknown') };
}
