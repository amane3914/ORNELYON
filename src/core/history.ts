import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { historyPath } from './paths.js';
import { redact } from './redact.js';
import type { Evidence } from './evidence.js';
import type { DelegationContract } from './contract.js';
import type { Provenance, TaskResult } from './types.js';

/**
 * What ORNELYON itself recorded when it started a handoff task (v0.3.1). It lets a later passport, the CLI,
 * the API and the GUI show the same facts: where the task came from, which instruction it was given, and
 * the size and hash of the context that was actually sent. Absent on tasks that are not handoffs.
 */
export interface HandoffMeta {
  fromGroupId: string;
  fromAgent: string | null;
  /** `<groupId>@<recordedAt>` of the summary record the report was read from. */
  sourceRecord: string;
  /** First request of the whole chain. Kept unchanged through A to B to C. Null when history cannot show it. */
  originalObjective: string | null;
  /** The user's instruction for this agent, or null when the default (the passport's next step) was used. */
  instruction: string | null;
  instructionSource: 'user' | 'default';
  contextChars: number;
  /** sha256 of the exact prompt that was sent, so it can be matched against the task record. */
  contextSha256: string;
  /** Parts that were cut to fit the size limit. Empty when nothing was cut. */
  truncated: string[];
  /** Changes ORNELYON made to the text before sending it (paths made relative or replaced, secret-like values redacted). */
  sanitized?: string[];
  /** Parts that were wanted but not available. They are stated in the context, never invented. */
  missing: string[];
}

/** One line of history.jsonl. Prompt and output are redacted before they are written. */
export interface RunRecord {
  recordedAt: string;
  /**
   * `task`, `review` and `fallback` are agent calls and count toward cost.
   * `summary` is one line per user task: the final result plus the orchestrator's notes
   * (loop-guard decisions, fallbacks, skipped agents). It is never counted as a call.
   * `decision` is a user's accept or reject action. It carries the updated evidence and is not a call.
   */
  role: 'task' | 'review' | 'fallback' | 'summary' | 'decision';
  notes?: string[];
  /** The user task this record belongs to (shared by all steps of one orchestrated run). */
  groupId: string;
  mode: 'L0' | 'L1' | 'L2' | 'L3';
  kind: string | null;
  prompt: string;
  result: TaskResult;
  /** Added in v0.2. Missing in v0.1 records, which are read as having no evidence. */
  evidence?: Evidence;
  /** Added in v0.3.1. Present on the summary record of a handoff task. */
  handoff?: HandoffMeta;
  /**
   * Added in v0.4.1, written by ORNELYON from the adapter it used (not from anything the agent said). Absent in
   * older history and for adapters that do not declare it: both mean "unknown", never "real".
   */
  origin?: Provenance;
  /** Added in v0.2. The contract the call was made under. Objective is redacted on write. */
  contract?: DelegationContract;
}

/** Roles that are agent calls. Only these count toward cost and call limits. */
export const CALL_ROLES: RunRecord['role'][] = ['task', 'review', 'fallback'];

const MAX_TEXT = 20000;

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…[truncated]` : text;
}

export function appendRecord(record: RunRecord, file: string = historyPath(), secrets: string[] = []): void {
  const safe: RunRecord = {
    ...record,
    prompt: clip(redact(record.prompt, secrets)),
    notes: record.notes?.map((n) => redact(n, secrets)),
    contract: record.contract ? { ...record.contract, objective: clip(redact(record.contract.objective, secrets)) } : undefined,
    result: {
      ...record.result,
      output: clip(redact(record.result.output, secrets)),
      errorMessage: record.result.errorMessage === null ? null : redact(record.result.errorMessage, secrets),
    },
  };
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(safe)}\n`, 'utf8');
}

export interface ReadResult {
  records: RunRecord[];
  /** Lines that could not be parsed. They are skipped, not deleted. */
  skippedLines: number;
}

export function readRecords(file: string = historyPath()): ReadResult {
  if (!existsSync(file)) {
    return { records: [], skippedLines: 0 };
  }
  const records: RunRecord[] = [];
  let skippedLines = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    try {
      records.push(JSON.parse(line) as RunRecord);
    } catch {
      skippedLines += 1;
    }
  }
  return { records, skippedLines };
}
