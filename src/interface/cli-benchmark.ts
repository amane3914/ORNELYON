import { writeFileSync } from 'node:fs';
import { readRecords } from '../core/history.js';
import { compare, summarize, syntheticHistory, type CohortStats, type CompareReport, type GroupBy, type Selector, type Shape } from '../optimization/benchmark.js';

/** `ornelyon benchmark`: reads history (or a given file) and prints figures. Calls no agent and writes nothing except `synth --out`. */

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function selectorFrom(parts: Record<string, string | undefined>): Selector | string {
  const s: Selector = {};
  if (parts.agent !== undefined) {
    s.agent = parts.agent;
  }
  if (parts.kind !== undefined) {
    s.kind = parts.kind;
  }
  if (parts.shape !== undefined) {
    if (!['single', 'multi', 'handoff'].includes(parts.shape)) {
      return 'shape must be single, multi or handoff.';
    }
    s.shape = parts.shape as Shape;
  }
  if (parts.hours !== undefined) {
    const h = Number(parts.hours);
    if (!Number.isFinite(h) || h <= 0) {
      return 'hours must be a positive number.';
    }
    s.since = new Date(Date.now() - h * 3600_000).toISOString();
  }
  return s;
}

function parseSelector(text: string): Selector | string {
  const parts: Record<string, string> = {};
  for (const piece of text.split(',').map((p) => p.trim()).filter((p) => p !== '')) {
    const m = /^(agent|kind|shape|hours)=(.+)$/.exec(piece);
    if (!m) {
      return `Cannot read "${piece}". Use key=value with keys agent, kind, shape, hours.`;
    }
    parts[m[1]] = m[2];
  }
  return selectorFrom(parts);
}

const num = (v: number | null, digits = 0): string => (v === null ? 'unknown' : v.toFixed(digits));
const usd = (v: number | null): string => (v === null ? 'unknown' : `$${v.toFixed(4)}`);

function printStats(label: string, s: CohortStats): void {
  const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(0)}%`);
  const sec = (v: number | null): number | null => (v === null ? null : v / 1000);
  console.log(label);
  console.log(`  origin of tasks: real ${s.origins.real}, fake/test/synthetic ${s.origins.nonReal}, unknown ${s.origins.unknown}`);
  console.log(`  tasks ${s.tasks}, calls ${s.calls} (extra calls ${s.extraCalls}), agents ${JSON.stringify(s.agents)}, shapes ${JSON.stringify(s.shapes)}`);
  console.log(`  Execution SUCCESS ${s.executionSuccess}/${s.tasks} (${pct(s.executionSuccess, s.tasks)}); Verification PASS ${s.verificationPass}/${s.verificationChecked} checked; accepted ${s.accepted}, rejected ${s.rejected}`);
  console.log(`  agent time per task: ${num(sec(s.durationMs.mean), 1)} s (total ${num(sec(s.durationMs.sum), 1)} s)`);
  console.log(`  tokens per task: in ${num(s.inputTokens.mean)} / out ${num(s.outputTokens.mean)} (reported for ${s.inputTokens.n} task(s), unreported ${s.inputTokens.unknown})`);
  console.log(`  reported cost per task: ${usd(s.costUsd.mean)} (total ${usd(s.costUsd.sum)}; reported for ${s.costUsd.n}, unreported ${s.costUsd.unknown}); cost per successful task: ${usd(s.costPerSuccessUsd)}`);
  if (s.extraCalls > 0) {
    console.log(`  cost of extra calls (review / fallback): ${usd(s.extraCostUsd.sum)} over ${s.extraCostUsd.n} task(s) with a known cost`);
  }
}

function printCompare(r: CompareReport): void {
  printStats('A', r.a.stats);
  printStats('B', r.b.stats);
  const line = (name: string, x: { a: number | null; b: number | null; ratio: number | null }, f: (v: number | null) => string): void => {
    console.log(`  ${name}: A ${f(x.a)} -> B ${f(x.b)}  (B/A ${x.ratio === null ? 'unknown' : x.ratio.toFixed(2)})`);
  };
  console.log('Per task (means over tasks that reported the value):');
  line('calls', r.perTask.calls, (v) => num(v, 2));
  line('cost', r.perTask.costUsd, usd);
  line('input tokens', r.perTask.inputTokens, (v) => num(v));
  line('output tokens', r.perTask.outputTokens, (v) => num(v));
  line('agent time (ms)', r.perTask.durationMs, (v) => num(v));
  line('execution success rate', r.perTask.successRate, (v) => num(v, 2));
  line('verification pass rate', r.perTask.verificationPassRate, (v) => num(v, 2));
  const p = r.paired;
  console.log(`Paired (identical first prompt in both groups): ${p.pairs} pair(s)`);
  if (p.pairs > 0) {
    console.log(`  cost A ${usd(p.cost.a)} vs B ${usd(p.cost.b)} over ${p.cost.n} pair(s); calls A ${num(p.calls.a)} vs B ${num(p.calls.b)}; agent time A ${num(p.durationMs.a)} ms vs B ${num(p.durationMs.b)} ms`);
  }
  console.log(`Conditions that differ: ${r.conditions.differences.length === 0 ? 'none found' : r.conditions.differences.join(', ')}`);
  console.log(r.likeForLike ? 'Conditions look alike (same kinds and agents, no overlap, enough tasks). Still observational, not a controlled test.' : 'NOT a like-for-like comparison:');
  for (const c of r.caveats) {
    console.log(`  - ${c}`);
  }
}

export function cmdBenchmark(args: string[]): number {
  const sub = args[0] !== undefined && !args[0].startsWith('--') ? args[0] : undefined;
  const json = args.includes('--json');
  if (sub === 'synth') {
    const out = flag(args, '--out');
    if (!out) {
      console.error('Usage: ornelyon benchmark synth --out <file> [--seed N] [--tasks N]');
      return 2;
    }
    const records = syntheticHistory(Number(flag(args, '--seed') ?? 1) || 1, Math.min(Math.max(Number(flag(args, '--tasks') ?? 20) || 20, 1), 1000));
    writeFileSync(out, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    console.log(`Wrote ${records.length} synthetic record(s) to ${out}. They are marked synthetic and say nothing about real usage.`);
    return 0;
  }
  const historyFile = flag(args, '--history');
  const read = historyFile ? readRecords(historyFile) : readRecords();
  if (read.skippedLines > 0) {
    console.error(`${read.skippedLines} unreadable history line(s) were skipped.`);
  }
  if (sub === 'compare') {
    const a = parseSelector(flag(args, '--a') ?? '');
    const b = parseSelector(flag(args, '--b') ?? '');
    if (typeof a === 'string' || typeof b === 'string') {
      console.error(typeof a === 'string' ? `--a: ${a}` : `--b: ${String(b)}`);
      return 2;
    }
    const report = compare(read.records, a, b);
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printCompare(report);
    }
    return 0;
  }
  if (sub !== undefined) {
    console.error('Usage: ornelyon benchmark [compare|synth] ...');
    return 2;
  }
  const by = (flag(args, '--by') ?? 'none') as GroupBy;
  if (!['agent', 'kind', 'shape', 'none'].includes(by)) {
    console.error('--by must be agent, kind or shape.');
    return 2;
  }
  const selector = selectorFrom({ agent: flag(args, '--agent'), kind: flag(args, '--kind'), shape: flag(args, '--shape'), hours: flag(args, '--hours') });
  if (typeof selector === 'string') {
    console.error(selector);
    return 2;
  }
  const report = summarize(read.records, selector, by);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  if (report.cohorts.length === 0) {
    console.log('No tasks match.');
  }
  for (const c of report.cohorts) {
    printStats(c.label, c.stats);
  }
  console.log(`data sha256: ${report.dataSha256.slice(0, 16)}  (the same history always gives the same value)`);
  if (report.duplicateCallsSkipped > 0) {
    console.log(`${report.duplicateCallsSkipped} repeated call record(s) were skipped so no use is counted twice.`);
  }
  for (const n of report.notes) {
    console.log(`- ${n}`);
  }
  return 0;
}
