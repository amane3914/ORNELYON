# Architecture

ORNELYON is one TypeScript code base with a thin GUI and CLI over a shared service layer. Runtime dependencies: none (Node.js built-in modules only).

## Layers

| Layer (spec 3.1) | Location | Responsibility |
| --- | --- | --- |
| Core | `src/core/` | Config with validation and atomic save, task contract (`types.ts`), run history (`history.ts`), process runner (`process.ts`), error classification (`errors.ts`), redaction (`redact.ts`), workspace path boundary (`paths.ts`) |
| Agent Adapter | `src/agents/` | `codex.ts` (`codex exec`), `claude.ts` (`claude -p`), `local-llm.ts` (OpenAI-compatible HTTP), `registry.ts` (builds only the adapters that are needed) |
| Evidence (v0.2) | `src/core/evidence.ts` | Three separate fields: Execution, Verification, Acceptance. Only `decideAcceptance` sets ACCEPTED or REJECTED. |
| Checks (v0.2) | `src/core/workspace.ts`, `src/core/verify.ts` | Workspace snapshots and scope check (detection only). File, JSON and trusted-command checks. Commands are never taken from agents. |
| Contract (v0.2) | `src/core/contract.ts` | Delegation Contract v1, validated before any process starts. |
| Passport (v0.2) | `src/core/passport.ts` | Sealed task summary, drift detection, handoff instruction text. |
| Orchestrator | `src/orchestrator/orchestrator.ts` | Levels L0 to L3, call caps, retries through the loop guard, fallback, budget check |
| Dispatch (v0.2) | `src/orchestrator/dispatch.ts` | Pure Smart Dispatch decision and review key. Off by default. |
| Optimization | `src/optimization/` | `loop-guard.ts` (failure-loop detection), `cost.ts` (reported-only cost and token summary), `dormancy.ts` (tool states) |
| Improvement | `src/improvement/research.ts` | EXPERIMENTAL. Tries prompt prefixes, scores them with a pattern, saves a pending candidate only if it beats the baseline. Apply changes only `promptPrefix`, and only with an explicit command. No automatic loop. |
| Safety | spread across `core/paths.ts`, `interface/server.ts`, `agents/*` | Sandbox defaults, plan mode, workspace boundary, local-only GUI, token and Host checks |
| Interface | `src/interface/` and `web/index.html` | `service.ts` (shared logic), `server.ts` (local HTTP API and page), `cli.ts` (commands) |

## Task flow

```
GUI / CLI ──> service.startTask ──> orchestrate(config, input, deps)
                                       │
                 attempt() ◄───────────┤  caps: maxCalls; budget (reported cost only)
                    │                  │
                 adapter.run()         │  retry / change_method / stop  ◄── LoopGuard
                    │                  │
          runProcess (spawn, stdin,    │
          timeout, taskkill /T on win) │
                    │                  │
          classifyFailure / parse      │
                    │                  │
                 TaskResult ───────────┘──> appendRecord (redacted) ──> history.jsonl
```

Prompts are sent on **stdin**, never in argv, to avoid quoting problems and the Windows command-line length limit. Cancellation and timeouts kill the whole process tree (`taskkill /T /F` on Windows, process group on POSIX).

## Adapter contract

```ts
interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  detect(): Promise<DetectionResult>;          // installed, version, signed-in state, note
  run(request: TaskRequest, ctx: RunContext): Promise<TaskResult>;
}
```

Every adapter returns a `TaskResult` with a status (`success`, `failed`, `timeout`, `cancelled`, `unavailable`), an error kind, a normalized error signature, usage (`null` when not reported) and cost (`null` unless the agent reports USD).

Adapters never estimate tokens or prices. Missing values stay `null` and are shown as "unknown".

## Data files

All state lives in `data/` inside the install folder (or in `ORNELYON_HOME` if set; `CHIMERA_HOME` is still honoured).

| File | Contents |
| --- | --- |
| `config.json` | Settings. Written atomically. `config.json.bak` is the previous version. A broken file is kept as `config.json.corrupt`. |
| `history.jsonl` | One line per agent call, plus one `summary` line per task and `decision` lines for accept/reject. Prompt and output are redacted and truncated to 20,000 characters. Unreadable lines are skipped, not deleted. |
| `passports/<task-id>.json` | Task Passport (v0.2). Sealed with an integrity hash; edited files are refused. Written only by `passport save`. |
| `workspace/` | Default working folder for agents (set it in Setup). |
| `tmp/` | Codex writes its final message here; each file is deleted after it is read. |

## Config model (summary)

- `preset`, `setupCompleted`, `workspaceRoot`, `defaultSandbox` (default `read-only`)
- `multiAi`: `enabled`, `mainAgent`, `mode` (`manual` | `review` | `auto`), `maxCalls`, `maxDepth` (nested calls), `maxHandoffs` (sequential manual handoffs, v0.3; counted from history), `handoffContextMaxChars` (size limit of the handoff context, v0.3.1)
- `agents.{codex,claude,local}`: `enabled`, `capabilities`, `priority`, `budgetUsd`, `timeoutSec`, `model`; local adds `baseUrl` and `apiKeyEnv` (variable name only)
- `optimization.loopGuard`: `enabled`, `maxRetries`, `stopAfterSameErrors`
- `optimization.tools`: `name`, `description`, `state` (`ACTIVE` | `DORMANT` | `QUARANTINED` | `DISABLED`)
- `gui.port`

Invalid values are replaced by defaults and reported as warnings when loaded.

## Safety boundaries

- **GUI:** binds to `127.0.0.1`. Requests with a Host other than `127.0.0.1:<port>` or `localhost:<port>` get 403. API calls need the per-launch token (`x-chimera-token` header, kept from v0.1 for compatibility; compared in constant time). Responses carry `no-store`, `nosniff` and a Content-Security-Policy.
- **Workspace:** `resolveWorkspacePath` resolves symlinks first, then checks the path is inside the root.
- **Codex:** `codex exec -s read-only` by default. `workspace-write` is opt-in per task. `danger-full-access` and `--approve-for-me` are never passed.
- **Claude Code:** `--permission-mode plan` for read-only tasks, `acceptEdits` for workspace-write tasks. No bypass flag.
- **Secrets:** API keys come from environment variables named in config. Values are redacted from logs, history and errors.
- **Multi-AI off:** `buildAdapters` constructs only the main agent.

## Optimization details

- **Loop guard:** the signature is `agent | error kind | normalized message` (digits, hex ids and paths masked). Non-retryable kinds (not installed, not signed in, invalid request, cancelled) stop at once. Other failures retry up to `maxRetries`, stop after `stopAfterSameErrors` identical failures, and otherwise suggest a change of method. The guard works between attempts only. It is not a live intervention.
- **Cost monitor:** summarizes reported values per agent over a time window. A daily budget blocks an agent only when its reported spend reaches the limit. If some runs reported no cost, the budget state is `unverified` and the UI says so.
- **Tool dormancy:** states change only by user action. `dormantToolNames` feeds Claude Code's `--disallowedTools`. `activeTools` decides which tool descriptions are added to the local LLM request. Codex has no equivalent switch.

## Reference projects

- **Harness²** (Apache-2.0, Linux/Python 3.12 benchmark framework): not integrated. Its idea of proposing, testing and comparing harness variants is the basis for the planned Research work, which is not implemented in v0.1.
- **TokenEconomizer** (Apache-2.0, Claude Code/Codex plugin): not integrated. Its loop guard and tool-pruning ideas are implemented natively in ORNELYON. Those mechanisms run inside the agents' own sessions, and ORNELYON only sees task boundaries.

## Handoff Context (v0.3.1)

`buildHandoffContext` in `core/passport.ts` is the only place that writes the text a handoff sends. `prepareHandoff` in `interface/service.ts` runs every refusal check first and then calls it; the CLI (`handoff --preview`), the API (`POST /api/handoffs/preview`), the GUI (which only displays the API result) and the real `handoffTask` all use that one function, so the preview, the stored hash and the text the agent received are the same.

- Inputs: the passport (sealed; the new fields `originalObjective`, `agentReport`, `checkedFiles`, `handoff` are optional, so older passports verify unchanged), the history (the report is read from the previous task's summary record and matched by sha256 against the passport copy), and the current workspace hashes.
- Trust: the report is the agent's claim and is framed as untrusted data; evidence is ORNELYON's check results, listed apart; the new task's Evidence starts at NOT_RUN. The count of handoffs still comes from history, and limits, budget, sandbox and capability checks run before the context is built.
- Record: `RunRecord.handoff` (summary record of a handoff task) keeps the source record, instruction, size, sha256 and any cut or missing parts.
- No model call, no new module, no new dependency.

## MCP Server Lite (v0.4.0)

> Access scope, the shared cleaner (including e-mail addresses) and the protocol decision were added in v0.4.1; see the last section of this file. The statements below about content mode apply only to tasks in scope.

`interface/mcp.ts` is a separate entry point (`ornelyon mcp`); no other module imports it. It speaks the Model Context Protocol over stdio, one JSON-RPC message per line, with its own small handler (initialize, ping, tools/list, tools/call; versions 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05 are accepted). It was checked against the official TypeScript SDK client.

- **Why not the SDK at runtime.** `@modelcontextprotocol/sdk` 1.32.2 is about 4.5 MB unpacked with 17 direct dependencies (express, hono, zod, ajv, jose and others); ORNELYON has none. Read-only stdio tools need four methods, so a small handler is cheaper to ship and audit. The SDK is a dev dependency of one test, so protocol conformance is still checked against the reference client.
- **No logic of its own.** Each tool calls an existing function: `detectAgents`, `recentTasks`, `dispatchPreview` (moved to `interface/service.ts` so the API, the CLI and MCP share it), `evidenceFor`, `loadPassport` with `handoffOverview`, and `prepareHandoff`. The handoff preview hash equals the one the CLI, the API and a real handoff use.
- **Cannot act.** The module does not import `startTask`, `handoffTask`, `decideTask`, `saveConfig`, `appendRecord`, `savePassport`, any child-process or network module (a test checks this on the compiled file). Tools take only an id, an agent name, a kind, a limit, an instruction text for the preview and a review flag; unknown arguments are refused.
- **Data minimisation.** Free text is withheld unless the operator starts the server with `--expose-content`. Every returned string passes `cleanForHandoff` (workspace paths relative, outside paths replaced, secret-like values redacted), has e-mail addresses replaced, and is cut at 4000 characters (the handoff text at 20000). Tool results are data, never permission.

## Efficiency Benchmark (v0.4.0)

`optimization/benchmark.ts` holds pure functions over history records (`buildRows`, `cohortStats`, `summarize`, `compare`, `syntheticHistory`); `interface/cli-benchmark.ts` prints them. It imports no agent, orchestrator or network module, so measuring cannot cause a model call.

- One row per user task: only `task`, `review` and `fallback` records are calls, deduplicated by task id; `summary` and `decision` records add evidence, never usage. Execution, Verification and Acceptance come from the newest evidence.
- Unreported tokens or cost make that task unknown for the figure; sums and means are over reported tasks with `n` and `unknown` shown. Cost per successful task needs every task's cost.
- `compare` is observational: it reports differences in kind, final agent, overlap and size, pairs identical first prompts, and sets `likeForLike` only when nothing differs and no fake or synthetic call is present.
- The report carries a sha256 of its input rows, so identical history gives identical output.

## v0.4.1: MCP scope, one cleaner, benchmark origin

**MCP scope.** `McpOptions.tasks` (a list of task ids, or `'all'`) is checked in the server for every per-task tool; the default is none. `--recent N` is resolved once at start (a snapshot), `--allow-task` names ids, `--all-tasks` must be asked for and is refused together with `--expose-content` (in the CLI and again in `createMcpSession`). A task outside the scope and a task that does not exist give the same message. Ids must match the UUID form exactly. `ornelyon_recent_tasks` filters by scope before applying its limit. Annotations are only hints. A stdio server cannot know which program started it, so there is no per-client authorisation; the scope is the control.

**One cleaner.** `cleanForHandoff` (core/passport.ts) is the only place that rewrites paths, redacts secret-like values and, since v0.4.1, replaces e-mail addresses (`[email-removed]`, counted in `handoff.sanitized` and named in the context). The handoff builder and the MCP server both call it. The MCP handoff preview returns the string the handoff builder produced, unchanged, after checking that its sha256 equals `context.sha256`; so the MCP text, the CLI and API preview and the text a real handoff sends are the same string. What differs between MCP and a handoff is *how much*, not *how it is cleaned*: MCP withholds free text unless content mode is on and the task is in scope; a handoff sends the report section as designed (bounded by `handoffContextMaxChars`); the passport tool shows the report cut at 4000 characters. The caller's own instruction in a preview is shown as given (redacted for secrets only).

**What cleaning guarantees, and what it does not.** It guarantees that workspace-absolute Windows and common POSIX paths, matches of the secret patterns in `core/redact.ts` and well-formed e-mail addresses are not in what leaves, and that the change is counted. It does not guarantee that no sensitive text remains: UNC paths, `~`, unusual roots, secrets with no recognised shape and personal data that is not an address pass through. A marker such as `[email-removed]` or `<outside-workspace-path:name>` can hide a fact the receiver needs; the context says that something was removed and how often, never what.

**Benchmark origin.** `AgentAdapter.provenance` (`cli`, `local-endpoint`, `fake-adapter`, `test-command`) is set by the adapter classes from how they were built (a replacement command or fetch makes it `test-command`). The orchestrator writes it to `RunRecord.origin` on every call record. Nothing an agent returns can set it. Records without `origin` are *unknown*. A task is `real` only if every call has a real origin; any non-real call makes it `non-real`; otherwise `unknown`. `likeForLike` needs every task in both groups to be `real`. The name-based flag of v0.4.0 stays as a second signal for older records.

**Protocol.** Legacy-era MCP (2024-11-05 to 2025-11-25). The 2026-07-28 revision removes `initialize`, requires `server/discover`, a `resultType` on results and `ttlMs`/`cacheScope` on `tools/list`. It is not implemented here: exact shapes were not verified from the specification pages, and the official SDK v2 would add a dependency tree for a read-only stdio tool. The server answers `server/discover` with "method not found", which is the fallback signal for dual-era clients.
