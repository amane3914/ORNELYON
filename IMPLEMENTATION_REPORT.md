# Implementation report: ORNELYON v0.2.0

Sections 1 to 9 describe v0.1 and are kept as history. Section 10 describes v0.2, the current version.

Three states are kept apart: **implemented**, **tested**, and **not verified**. Anything in the last group is not claimed to work.

## 1. Implemented

- **Core:** config with validation, presets, atomic save with `.bak`, corrupt-file recovery; task contract; run history (JSONL, redacted); process runner (stdin prompt, timeout, cancel, Windows process-tree kill); error classification and signatures; redaction; workspace boundary (symlink-aware).
- **Adapters:** Codex (`codex exec`, JSONL plus `-o` final message), Claude Code (`claude -p --output-format json`), Local LLM (OpenAI-compatible HTTP). Each has detect, run, timeout, cancel and error classification. An optional absolute **executable path** can be set per agent to pick a specific install.
- **Orchestrator:** L0, L1 manual, L2 mutual review (with `maxDepth` enforced; `0` skips review with a note), L3 routing by declared capability, priority and daily budget with fallback. Hard cap on calls including retries.
- **Optimization:** failure-loop guard (between attempts only); cost monitor (reported values only, otherwise "unknown"); tool dormancy with four states, applied to Local LLM requests and Claude's `--disallowedTools`.
- **Sub-agents:** off by default (`allowSubagents`). Codex runs with `--disable multi_agent --disable multi_agent_v2`. Claude is told to deny `Task` and `Agent`.
- **Claude write mode:** `workspace-write` maps to `acceptEdits`, never to a bypass mode.
- **Research (EXPERIMENTAL):** CLI only, Research preset only. Tries prompt prefixes, scores them with a regex, saves a *pending* candidate only if a variant beats the baseline. `research apply <id> --yes` changes only `promptPrefix` for that agent. Tampered candidates targeting other fields are refused.
- **History:** one summary line per user task holds the final result and the orchestrator's notes (loop-guard decisions, fallbacks). Summaries are excluded from cost and call counts.
- **GUI:** setup with checks and completion gate, presets, agent settings (including executable path and sub-agent switch), task runner with live log and cancel, run history, agent status, cost view, tool states, raw config editor. Workspace-write runs ask for confirmation.
- **CLI:** `gui`, `doctor`, `run` (`--allow-write` required for workspace-write), `history`, `cost`, `tool`, `research`, `config path`.
- **Launchers:** `start-chimera.bat` (CRLF), `start-chimera.sh` (run as `sh start-chimera.sh`).
- **CI:** `.github/workflows/ci.yml` (test matrix on Windows, macOS and Ubuntu, Node 20 and 24; packaging job). **Not pushed.**
- **Package:** `npm run package` builds the ZIP of compiled output, GUI page, launchers and documents.

## 2. Tested

| Check | Result |
| --- | --- |
| `npm test` (build plus 83 offline tests) | **83 pass, 0 fail** (Windows, Node 24.19.0) |
| Adapters against `scripts/fake-agent.mjs` through the real spawn path: success, auth failure, rate limit, timeout kill, cancel, argument shape, prompt on stdin, sub-agent flags, acceptEdits | Pass |
| `.cmd` launch refuses arguments cmd.exe would interpret (found in self-review) | Pass (Windows) |
| Orchestrator with scripted adapters: L0 to L3, fallback, call cap, retry, budget, maxDepth, prompt prefix | Pass |
| Research with scripted adapters: preset gate, pending candidate, no-improvement, apply whitelist, tamper refusal, reject | Pass |
| Config recovery, redaction, workspace boundary, error classification, loop guard, cost, dormancy, history | Pass |
| GUI server: token, Host check, setup gate, config write cannot set setup-complete, path escape refused, 404 without stack | Pass |
| Live `doctor` against the installed CLIs (version and auth status only) | codex-cli 0.162.1 and Claude Code 2.1.311 both signed in |
| **Live Codex through CHIMERA**: one `run --agent codex` call, read-only | Process ran, exit 0, `--disable` flags accepted, final message read from `-o` file. **The agent could not run any command**: Codex's Windows sandbox setup failed (`helper_unknown_error: setup refresh had errors`), so **no review was produced** |
| **Live Local LLM through the GUI API** (Ollama, `qwen3:14b`, free) | Success: "pong", token counts shown, cost "unknown" |
| **Live Research on Ollama** (3 variants, 1 sample each, free) | All variants passed, so no candidate saved. Correct behaviour |
| GUI in the built-in browser: page loads with token, Standard preset, setup completion | Pass |
| Extracted ZIP: `doctor`, `sh start-chimera.sh` starts the server on 127.0.0.1 | Pass |

## 3. Not verified (read carefully)

- **Codex independent review was not completed.** Two real runs were made; both ended with Codex unable to run commands in its read-only sandbox on this machine. Repairing the Windows sandbox would change machine-wide accounts and network rules, so it was not done. The security review was performed by the main agent instead (see section 6).
- **Codex output-event parsing is only partly verified.** The final message came from the `-o` file. The JSONL fallback (`item.completed` / `turn.completed`) was not exercised by a real run, and CHIMERA did not persist raw stdout, so its shape is still an assumption.
- **Claude Code was never run for a task** (paid, not authorized). `--permission-mode plan`, `acceptEdits`, `--disallowedTools` with `Task`/`Agent`, and the JSON result shape are unverified against the real CLI.
- The Claude sub-agent tool name (`Task` vs `Agent`) differs between versions and is unverified for 2.1.311.
- `codex features` `multi_agent` / `multi_agent_v2` names were accepted by the CLI flag parser, but their effect on a real run was not observed.
- A status of **success** means the process exited 0, produced text, and did not report a failed turn (Codex `turn.failed` / `error` events; Claude result `subtype` other than `success`). It does **not** mean the answer is correct. The earlier Codex review was recorded as success because Codex wrote a non-answer as its final message; no check in CHIMERA can detect that without judging the content. Treat every `success` as "agent finished", not "task solved", and read the output.
- Process-tree kill was tested with a single fake process on Windows only. Grandchild processes of real agents were not tested.
- macOS and Linux: not run on those systems. CI is written for them but has not run.
- GUI: setup and task were exercised. Every settings field and the Research CLI output were not clicked through in the GUI. Research has no GUI.
- The ZIP was not tested on a clean machine without Node or the CLIs.

## 4. Not implemented

- L4 cooperative execution.
- Automatic self-improvement loop. Research is a single explicit run plus manual apply.
- Benchmarks and any Harness² integration (Harness² targets Linux and Python 3.12).
- Automatic tool dormancy. CHIMERA cannot see which tools an external agent calls.
- Codex tool dormancy. The Codex CLI has no per-tool switch.
- **Session continuation.** Each task is an ephemeral session. Both CLIs support resume, but it was not built or verified, because verifying it needs paid runs and a session-id mapping.
- WSL2 or container isolation.
- Live intervention inside a running agent. The loop guard works between attempts only.

## 5. Libraries and versions

- Runtime: none (Node.js built-ins). Tested on Node.js v24.19.0.
- Development: TypeScript 5.9.3 (Apache-2.0), @types/node 20.19.43 (MIT).
- External CLIs used, not bundled: `@openai/codex` 0.162.1 (Apache-2.0), Claude Code 2.1.311 (Anthropic terms).
- Machine note: two Codex installs exist (standalone `~/.local/bin/codex.exe`, and npm `vendor/.../bin/codex.exe`). The standalone one cannot find its helper binaries. CHIMERA prefers `.exe` on PATH, so the standalone one is picked by default. Set the executable path to the npm binary for a working install.

## 6. Safety limits and self-review

Self-review of the launch path, config, server and research code (performed by the main agent, since Codex could not run):

- **Fixed:** on Windows, `.cmd`/`.bat` agent shims run through `cmd.exe`. Arguments with `& | < > ^ % ! " ( )` could have injected commands (for example a folder name containing `&`). Such arguments are now refused before anything starts, with a message to use the `.exe` instead. Trade-off: a workspace path with parentheses cannot be used with a `.cmd` shim.
- Checked and found clean: no `shell: true`, no `eval`, no `innerHTML` (the GUI uses `textContent`), no dangerous Codex or Claude permission modes passed. Research candidate IDs are validated as UUIDs, so no path traversal through candidate files.
- Codex runs read-only by default. `workspace-write` is per run and needs confirmation (`--allow-write` in CLI, dialog in GUI). Full access and auto-approval are not exposed.
- Claude uses plan mode for read-only tasks and `acceptEdits` for write tasks. It never runs with a bypass mode.
- The GUI binds to 127.0.0.1 and requires a per-launch token. The token appears in the terminal URL and in the browser history of that session.
- API keys are never stored; only an environment variable name is.
- Agents receive the full environment (needed for their own sign-in). Any prompt sent to a local LLM stays on that server; any prompt sent to Codex or Claude goes to that service.
- Loop guard and budget checks act between calls. Within a call, only timeout and cancel apply.
- Claude's account email is not copied into notes or logs.

## 7. How to start

- Windows: double-click `start-chimera.bat`.
- macOS/Linux: `sh start-chimera.sh` in the unzipped folder.
- Development: `npm install`, `npm test`, then `node dist/interface/cli.js gui`.

## 8. Package location

`dist-package/ORNELYON-<version>.zip` at the repository root, written by `npm run package` (the folder is git-ignored). This section describes the historical v0.1 build location; the current package is produced by the same command.

Git: the repository is initialized on branch `main`. **Nothing is committed or pushed.**

## 8a. Audit against the original vision (this revision)

Scope: problem spots only. No rewrite, no OS or global configuration change, no push, no external publishing, no paid runs.

| Audit point | Finding | Action in this revision |
| --- | --- | --- |
| 1. Official vs re-implementation | **Codex**: official CLI used as a subprocess (`exec`, `login status`, `--version`). Its agent runtime is not reimplemented. **Claude Code**: official CLI used as a subprocess (`-p`, `auth status`). Only `auth status` and `--version` were run live; no task has run. **Harness²**: not used. CHIMERA's Research is a small regex-scored prompt-prefix experiment, not Harness²'s Propose–Probe–Compose method. **TokenEconomizer**: not used. Its loop guard and tool pruning are reimplemented natively and act only between CHIMERA calls, not inside agent sessions. | Documented here and in ARCHITECTURE.md. No code change. |
| 2. Sub-agent rule | `allowSubagents` defaults to **off**. It is a configuration value shown in the GUI and can be switched on. It is not a hard-coded development rule. The default follows the development constraint, but users can change it. | Kept. The README and this report state that it is a default. |
| 3. Exit vs success | Codex and Claude both reported `success` when exit code was 0 and text existed. A Codex `turn.failed` event after an earlier message was recorded as success. Claude's `subtype` (for example `error_max_turns`) was ignored. | **Fixed.** A failed turn or non-success subtype is now `failed`. Subtype absent is still accepted. Tests added in `src/test/parsers.test.ts`. The non-answer case is still not detectable (see section 3). |
| 4. `allowSubagents` flag consistency | Codex: `--disable multi_agent --disable multi_agent_v2` only when off; placed after `exec`. Claude: `Task` and `Agent` added to `--disallowedTools` only when off; the list stays last because the flag is variadic. Consistent with the config. Flag names were not confirmed to change behaviour in a real run. | Kept. Verified only by unit tests against the argument shape. |
| 5. Unverified format assumptions | Codex: the event names `item.completed`, `agent_message`, `turn.completed`, `turn.failed`, `error` **exist as strings in the installed codex.exe** (checked by reading the binary, not by a run). Their field layout is not verified. Claude: result keys `result`, `is_error`, `subtype`, `total_cost_usd`, `usage`, `modelUsage` are **not verified** against the CLI. Claude sub-agent tool names are not verified. | Documented. The code treats missing fields as unknown, not as failure, to avoid breaking a working run on an unverified shape. |
| 6. Real features vs CHIMERA | See the comparison table below. | Documented. |
| 7. Starter-kit candidates | See the list below. | Listed. No removal in this revision. |

**Harness² vs CHIMERA Research.** Harness² (Apache-2.0, Linux and Python 3.12) is a benchmark framework that proposes, probes and composes harness changes at task and harness level. CHIMERA Research only tries a few prompt prefixes and scores them with one regular expression. It is a demonstration of the idea, not an implementation of Harness² features.

**TokenEconomizer vs CHIMERA optimisation.** TokenEconomizer (Apache-2.0, Claude Code and Codex plugin) works inside the agents' own sessions: micro-skills, tool pruning in each agent's settings, and failure-loop intervention during a session. CHIMERA's loop guard, tool dormancy and cost monitor act only between task attempts and only on values the agents report. Cost savings are not measured by CHIMERA.

**Candidates to remove or consolidate for a starter kit (not done):**
- `src/agents/fake.ts` is a test double but ships in `dist/`. Move it under `dist/test` in the packager.
- Availability logic is computed in both the CLI and the GUI service. Keep one function.
- Research CLI is experimental and has no GUI. Consider moving it to a separate optional package.
- Tool dormancy UI does not affect Codex. Consider hiding it when Codex is the only agent.
- Summary records in history duplicate the attempt records. Keep, but document.
- The raw config editor duplicates the Agents and Setup screens. Keep as an escape hatch.
- README, README_ja and this report repeat the same limits. Keep one source and link to it.

## 8b. Official components: state by component (stage 2)

States: **REFERENCED** (design only), **CONNECTED** (the official component is wired in and visible), **VERIFIED** (its real function was run and checked), **BLOCKED** (not verified, with reason).

| Component | State | Evidence and reason |
| --- | --- | --- |
| OpenAI Codex CLI | CONNECTED, partly VERIFIED | `doctor` and `login status` run live. A live task was run once; the agent could not run commands, see below. |
| Codex JSONL / exec output | BLOCKED | Codex's on-disk session format (`event_msg` with `task_complete`, `turn_aborted`, `token_count`) was read from a local archived session by key names only. The stdout of `codex exec --json` is not verified. The parser accepts both shapes; fixtures are synthetic. |
| Codex Windows sandbox | BLOCKED (OS-level) | The command runner logs show `hide users: failed to hide current user profile dir (the default user profile folder): ... Access denied (os error 5)` and `junction: failed to create <default profile>\.codex\.sandbox\cwd: Access denied`. The failure is a permission problem on the Default profile folder. Fixing it needs an OS or ACL change, which was not done. |
| Claude Code CLI | CONNECTED, BLOCKED for tasks | `auth status` and `--version` are used. No task was run (paid, not approved). JSON result shape is not verified. The local transcript format has no `result` record, so the assumption is unsupported by local data. |
| Microsoft TokenEconomizer | CONNECTED (read-only status), BLOCKED (effect) | CHIMERA reads agent settings for the plugin name and reports its state. It does not install or change the plugin. Not installed on this machine. The upstream wiki lists Claude Code 2.1.300–2.1.310 and Codex 0.153.1–0.164.0. **Installed Claude Code 2.1.311 is outside that list**, so the plugin is unverified here. Range data came from a secondary search summary, not the repository. |
| Google Harness² | REFERENCED, BLOCKED for run | The optional Research backend check reports linux, python3.12 and uv. This machine is Windows, so the backend is BLOCKED. CHIMERA does not import or run Harness². Benchmarks and the official improvement loop are not run. The local CHIMERA Research experiment (regex, prompt prefix) is not Harness². |

**Changes in stage 2:**
- Codex parser accepts the on-disk event names (`task_complete`, `turn_aborted`, `token_count`). Test fixtures are synthetic and contain no real content. Raw logs are not stored.
- Adapter result states now distinguish process exit, reported success and failure (section 3).
- TokenEconomizer status panel in the GUI (read-only).
- Harness² availability check in `/api/status` and the GUI (no requirement when not used).
- The fake adapter moved from `src/agents/` to `src/test/`, so it is no longer in `dist/` or the ZIP.
- The availability rule is now one function, `availabilityFrom`, shared by the CLI and the GUI.

**Not done, and why:**
- No paid live Codex or Claude task (not approved).
- No OS, ACL, account or network change; no change to the user's global Codex or Claude settings; nothing installed.
- No push, no external publishing.

## 9. Next steps

1. Repair the Codex Windows sandbox, or use a Codex install whose sandbox helpers work. Then rerun the security review through CHIMERA.
2. Run one small real Claude Code task (with approval) to verify its flags and JSON shape.
3. Capture raw Codex JSONL in history for debugging, then verify the event parser against it.
4. Run CI on macOS and Linux, and do a clean-machine install test.
5. Implement session continuation for both CLIs.
6. Choose the final copyright holder name before public release (currently "CHIMERA Harness contributors", MIT).

## 10. ORNELYON v0.2.0 (current revision)

### 10.1 Implemented

| Area | What was added | Where |
| --- | --- | --- |
| Evidence Gate Lite | Three separate fields: Execution, Verification, Acceptance. Only `decideAcceptance` sets ACCEPTED or REJECTED, and it refuses when execution is not SUCCESS, verification FAILs, or a required check is UNVERIFIED (override needs a reason, which is recorded). | `src/core/evidence.ts` |
| Workspace snapshots | Before/after hashes of the whole workspace for workspace-write runs and for runs with `--allow-files`; detects changes outside `--allow-files`. Detection only, not prevention. Limits (v0.4.1 audit fix): 20,000 files, 256 MiB each; skipped folders, oversized or unreadable entries and the file limit are reported as gaps and make the scope check UNVERIFIED. | `src/core/workspace.ts` |
| Verification checks | File exists (optional sha256), JSON parses, trusted commands (absolute path, no shell, exit code only, registered in config). Agents cannot register commands. | `src/core/verify.ts` |
| Delegation Contract v1 | Validated before any process starts. Hard-enforced: depth, call count, timeout, budget, sandbox. Detected after the run: allowed files. Cooperative only (objective, expected output). | `src/core/contract.ts` |
| Smart Dispatch | Pure decision function (NO_CALL, CALL_OTHER_PROVIDER, CALL_SPECIFIC_ROLE, ESCALATE, REQUIRE_INDEPENDENT_REVIEW). Review reuse by key (answer, reviewer, kind, constraints, file fingerprint). Off by default. `--dry-run` shows the plan without starting an agent. | `src/orchestrator/dispatch.ts`, `orchestrator.ts` |
| Task Passport | Sealed JSON summary (sha256 over canonical JSON); drift detection by re-hashing changed files; first line of objective only; saved under `data/passports/`. | `src/core/passport.ts` |
| Handoff | Manual only. Starts a read-only task on another agent from a passport. Refuses on drift unless `--accept-current-state`. No automatic handoff. | `src/interface/service.ts` |
| History | Records gain optional `evidence` and `contract`; role `decision` added. Cost summary counts only call roles (task, review, fallback), so decisions and summaries do not inflate call counts. | `src/core/history.ts`, `src/optimization/cost.ts` |
| Config | `multiAi.smartDispatch`, `verification` added with defaults. Config version stays 1; missing fields are normalized. | `src/core/config.ts` |
| CLI | `accept`, `reject`, `verdict`, `passport save|show`, `handoff`, `run --dry-run`, check flags. Exit codes: 0 ok, 1 not success, 3 verification FAIL. | `src/interface/cli.ts` |
| API | `POST /api/tasks/decision`, `POST /api/passports`, `GET /api/passports/:groupId`. Same token and Host checks as before. | `src/interface/server.ts` |
| GUI | Runs table shows Execution, Verification (tooltip lists checks), Acceptance and a decision control. Plain text rendering only. | `web/index.html` |
| Rename | ORNELYON is the name. `ORNELYON_HOME` added; `CHIMERA_HOME` still honoured. `start-ornelyon.bat/.sh` added; `start-chimera.*` kept as wrappers. `chimera` bin kept as alias. Header `x-chimera-token` and placeholder `__CHIMERA_TOKEN__` kept for compatibility. | `package.json`, launchers, docs |
| Distribution | `dist-package/ORNELYON-0.2.0.zip`; CI artifact `ORNELYON-zip`. | `scripts/package.mjs`, `.github/workflows/ci.yml` |

Still in place from v0.1 and unchanged: TokenEconomizer read-only status, Harness² availability check (never runs Harness²), Research command (experimental).

### 10.2 Tested

| Check | Result |
| --- | --- |
| `npm test` (build plus offline tests, fake adapters, no paid calls) | **128 pass, 0 fail** |
| `npm run package` | Built `dist-package/ORNELYON-0.2.0.zip`; 44 entries (including folders); ZIP has no test or fake-adapter files |
| CLI `run --dry-run --require-review --verify-file README.md` in a scratch data folder | Exit 0. Reported dispatch as NO_CALL (Smart Dispatch off), listed checks, and started no agent |
| CLI `history` on an empty scratch folder | Exit 0, "No runs recorded yet." |
| CLI `verdict` on a synthetic task (SUCCESS, UNVERIFIED, PENDING) | Exit 0; shows the three fields and the changed file |
| CLI `accept` without override on that task | Refused (exit 1): required verification not completed |
| CLI `accept --reason --override` | Accepted (exit 0); the message says the changes were already on disk and are not approved by this step |
| CLI `passport save` then `passport show` | Saved, then shown with status ACCEPTED, the changed file and the next step |
| CLI `handoff --to local` after editing the passported file | Refused (exit 1) with the drifted file named, before any agent starts |

The CLI rows used a synthetic `history.jsonl` and a scratch `ORNELYON_HOME` with a scratch workspace. No agent was called.

Test coverage, by file:
- `src/test/ornelyon.test.ts` (45): unit tests for evidence rules, workspace snapshots, verification, contract validation, passport seal and drift. Orchestrator-level end-to-end tests with fake adapters for dispatch, review and review reuse. Handoff is not covered by an automated test; it was checked by the CLI run above.
- `src/test/server.test.ts`: token, Host check, GUI title, unknown routes. **The decision and passport API routes have no automated test.** They were only syntax-checked.
- `src/test/parsers.test.ts` (Codex and Claude output parsing, using synthetic fixtures only).
- `src/test/integrations.test.ts` (TokenEconomizer and Harness² status, read-only).
- Earlier tests for config, history, cost, loop guard, dormancy, research, redaction and paths.

### 10.3 Not verified

- **Real Codex and Claude Code runs with the new checks** were not performed (paid, and Codex sandbox is still broken on this machine). The new flow was tested only with fake adapters and synthetic fixtures.
- **GUI decision controls and the Runs table** were checked for JavaScript syntax (`node --check`) only. They were not clicked or rendered in a browser. The decision and passport API routes have no automated test.
- **Handoff that actually starts an agent** was not run. Only the drift refusal was run, on synthetic data.
- **Verification commands** run with the user's own trust. ORNELYON does not sandbox them.
- **Workspace snapshot** is synchronous and capped at 5,000 files; large repositories will get `UNVERIFIED` for file scope.
- **Allowed-file check** detects changes after the run. It does not stop an agent from writing elsewhere.
- **Claude Code and Codex output formats** remain as in section 3 (unverified against real runs).

### 10.4 Not implemented

- Automatic handoff and automatic self-improvement.
- Session continuation inside Codex or Claude Code (handoff restarts from a summary).
- Sub-agent orchestration beyond what the CLIs do themselves (L4 cooperative execution).
- Sandboxing of verification commands.
- Real Harness² execution (only availability is reported).
- Cost estimation (only reported values are shown).

### 10.5 Name migration

| Item | Before (v0.1) | Now (v0.2) | Compatibility |
| --- | --- | --- | --- |
| Product name | CHIMERA Harness | ORNELYON | Earlier names are mentioned in docs |
| Data folder override | `CHIMERA_HOME` | `ORNELYON_HOME` (or `CHIMERA_HOME`) | Both honoured; `ORNELYON_HOME` wins if both set |
| Launchers | `start-chimera.bat/.sh` | `start-ornelyon.bat/.sh` | Old names kept as wrappers |
| CLI command | `chimera` | `ornelyon` | `chimera` kept as alias |
| Package | `CHIMERA-Harness-0.1.0.zip` | `ORNELYON-0.2.0.zip` | Old ZIP name is not produced |
| Config and history | `config.json`, `history.jsonl` | unchanged | Load as-is; v0.2 fields optional |
| Token header and placeholder | `x-chimera-token`, `__CHIMERA_TOKEN__` | unchanged | Kept on purpose; changing them would break existing clients |

### 10.6 Module count and cost impact

- **Source modules:** 29 non-test files in `src/` (39 with tests and test helpers). Six are new in v0.2: `evidence.ts`, `workspace.ts`, `verify.ts`, `contract.ts`, `passport.ts`, `dispatch.ts`. The v0.1 fake adapter moved from `src/agents/fake.ts` to `src/test/fake-adapter.ts`.
- **Default cost impact: zero extra calls.** Smart Dispatch is off by default, and `--require-review` is opt-in per task.
- **When reviews run,** they count toward `maxCalls` and the daily budget. An identical review that already passed is reused without a call.
- **Cost summary** counts only `task`, `review` and `fallback` records. `summary` and `decision` records are excluded.
- **Cost values** are still only the values an agent reports. ORNELYON does not estimate cost.

### 10.7 Compatibility names kept

- `CHIMERA_HOME` (data folder), `start-chimera.bat` and `start-chimera.sh` (wrappers), `chimera` (CLI alias), `x-chimera-token` (API header), `__CHIMERA_TOKEN__` (GUI placeholder).
- Old `config.json` and `history.jsonl` load unchanged.
- The copyright line in `LICENSE` still reads "CHIMERA Harness contributors". It was not changed. Choose the final holder before public release (section 9, item 6).

### 10.8 v0.3 candidates

- Run a real Claude Code and a real Codex task (with approval) to verify the v0.2 checks against real output.
- Browser-test the GUI decision controls.
- Capture raw Codex JSONL for parser verification.
- Sandboxed verification commands.
- Passport and handoff from the GUI.
- Async, streaming workspace snapshot for large repositories.

## 11. ORNELYON v0.2.1 (quality hardening, current revision)

No new features. This revision fixes defects found while testing v0.2.0, adds the missing integration tests, and rebuilds the package.

### 11.1 Baseline

- Git: the folder is a repository on branch `main` with **no commits**. All files are untracked. Nothing was committed or pushed.
- Project rules: no AGENTS.md or CLAUDE.md in the project. The v0.2 spec's rules were followed.
- v0.2.0 baseline before changes: 128 tests, 128 pass. The source was snapshotted before any edit.

### 11.2 Defects found and fixed

| # | Defect in v0.2.0 | Effect | Fix | Where |
| --- | --- | --- | --- | --- |
| 1 | With multi-AI off, `run --agent X` and `handoff --to X` ran the **main** agent. The requested agent was ignored without any message. | A user who asked for Claude could get Codex, and the result said `[L0] codex`. | The requested agent is used. A disabled one is refused per call. | `orchestrator.ts` (L0), `agents/registry.ts` (`buildAdapters(config, requested)`) |
| 2 | In auto mode, a handoff was routed by capability and priority, so the named agent could be skipped. | Handoff did not run the agent the user chose. | New `pinAgent` input: a pinned run uses only the named agent, with no routing or fallback. Handoff sets it. | `orchestrator.ts`, `service.ts` (`handoffTask`) |
| 3 | Handoff checked only the passport seal and file drift. It did not re-check the target's availability, capability, budget, or depth. | The spec's "re-check permissions, constraints and budget" was not met. | `handoffRefusal()` checks, before any process starts: target enabled, target available, target declares the task's capability, handoff depth ≤ `maxDepth`, daily budget not exceeded, no drift. | `service.ts` |
| 4 | The passport did not record the task kind, and handoff depth was not tracked. | Capability and depth could not be checked for a handoff. | Passport gets an optional `kind` (absent in older passports, which skip the check). Handoff tasks carry a `handoff-from:<id>` note, from which depth is computed. The link is hidden from passport decisions. | `passport.ts`, `service.ts` |
| 5 | The Runs table showed the acceptance from the **first** summary row. After a decision, the row still said PENDING and kept its Accept buttons. | GUI disagreed with the CLI and API, which read the latest evidence. A user could accept twice. | `/api/history` returns `latest` per task (the same last-record-with-evidence rule the CLI uses). The GUI reads it. No decision logic was added to the GUI. | `server.ts`, `web/index.html` |
| 6 | Two comments still said "CHIMERA" in user-facing code. | Naming inconsistency. | Changed to ORNELYON. | `workspace.ts`, `token-economizer.ts` |
| 7 | The fake local-LLM server in the HTTP tests cancelled its own reply timer. | Test artefact only, found while writing the tests. | Fixed in the test helper. Not a product defect. | `api.test.ts` |

Behaviour that was already correct and is now covered by tests: a sign-in failure is `BLOCKED` (unavailable), not `FAILED`. The override never changes a check result, never accepts a non-successful run, and is recorded only when a blocker existed.

### 11.3 Tests

| File | New tests | Type | What it covers |
| --- | --- | --- | --- |
| `src/test/relay.test.ts` | 12 | E2E (real Codex and Claude adapters running `scripts/fake-agent.mjs`; no paid agent) | Agent A runs, passport saved, Agent B runs the handoff, history and passport agree; pinned handoff in auto mode; explicit agent in L0; refusals for drift, corrupt passport, removed open issues (also re-sealed), invalid id, depth (incl. a chain), capability, budget, unavailable or disabled target; Agent B failing to run |
| `src/test/api.test.ts` | 19 | INTEGRATION (real HTTP server on 127.0.0.1; localhost fake OpenAI-style server for the local-LLM adapter) | Token required on every `/api` route, page without token; foreign Host 403; unknown route 404; malformed JSON 400; missing fields 400; unknown task 409; required check blocks accept; override recorded and not PASS; FAILED and CANCELLED cannot be accepted even with override; reject needs reason; passport save, read, tamper refusal; Smart Dispatch config round-trip; setup flag not editable; real run completes; cancel records CANCELLED; timeout records FAILED; bad input 400 with no model call; oversized body refused |
| `src/test/evidence-boundary.test.ts` | 15 | UNIT, plus one CLI process test | Success alone is never PASS; PASS needs all checks; agent path cannot set ACCEPTED; normal accept refusals; override accepts a FAIL but keeps it FAIL; override never accepts a non-successful run; override only recorded when needed; reject leaves judgements unchanged; "does not apply or approve" wording; structural check that agent, orchestrator, optimization and improvement code cannot reach the decision functions; CLI accept and verdict through the real command |

Total: **174 tests, 174 pass, 0 fail** (128 from v0.2.0 plus 46 new). None of the original 128 tests needed to change behaviour.

### 11.4 Browser test (built-in browser, real server)

The GUI was run by the real server on 127.0.0.1 against a scratch data folder with three seeded tasks. The browser was used to click through every decision case.

| Step | Result |
| --- | --- |
| Setup page shows "ORNELYON Setup" and the ORNELYON heading | PASS |
| Runs table shows Execution, Verification (with its checks) and Acceptance for every task | PASS |
| Accept with no reason is refused and the message is shown in the row | PASS |
| Accept with reason, no override, on an UNVERIFIED required check: refused with "required verification was not completed" | PASS |
| Same task with override ticked: accepted; the row shows ACCEPTED, Verification still UNVERIFIED, Accept controls gone | PASS (this exposed defect 5 before the fix) |
| Accept with override on a FAILED run: refused with "execution is FAILED" | PASS |
| Accept with reason on a clean run: accepted with no override | PASS |
| Agents tab shows the real status of Codex, Claude Code and the local LLM | PASS (read-only detection of the installed CLIs; no task was run) |
| Smart Dispatch settings in the GUI | NOT EXPOSED. Only in the raw configuration view. |
| Passport view and handoff in the GUI | NOT EXPOSED. CLI and API only. |
| CLI `verdict` after the GUI accept shows the same state (ACCEPTED, UNVERIFIED) | PASS |

The server and the browser pane were stopped afterwards. The browser was not tried on any other browser engine.

### 11.5 Clean package check

- `npm test` from the development folder: 174 pass.
- `npm run package` produced `dist-package/ORNELYON-0.2.1.zip`, extracted to a new folder outside the development tree.
- The extracted folder has no `node_modules` and runs without it.
- `doctor` runs and reports the real agents on this machine. `run --dry-run` runs and starts no agent (after a scratch setup was marked complete).
- `gui` starts; the page returns 200; an API call without the token returns 401; a foreign Host returns 403. The server was then stopped and the port is free.
- The ZIP contains no test files and no fake agent. Expected files are present.

### 11.6 Compatibility

- Kept on purpose: `CHIMERA_HOME`, `start-chimera.bat`, `start-chimera.sh`, the `chimera` CLI alias, the `x-chimera-token` header, the `__CHIMERA_TOKEN__` placeholder, and `LICENSE` (holder name pending the user's decision).
- Not a compatibility name but kept as history: v0.1 sections of this report and the scratch test name prefixes.
- Old `config.json` and `history.jsonl` load unchanged. Old passports (no `kind` field) still verify and skip the capability check.
- Records written by v0.2.0 are read correctly by the new `latest` rule, because it only uses records that carry evidence.

### 11.7 Not verified

| Item | Status | Reason |
| --- | --- | --- |
| Real Codex task and real Claude Code task, with the v0.2 checks | NOT_TESTED (REAL_AGENT) | Costs money. Codex's Windows sandbox is still broken on this machine (OS change needed; not made). |
| Handoff that starts a real agent | NOT_TESTED (REAL_AGENT) | Same reason. The relay ran with the real adapter code against the fake CLI. |
| macOS and Linux | NOT_TESTED | Only Windows 11 was available. `start-ornelyon.sh` was not run. |
| `start-ornelyon.bat` double-click | NOT_TESTED | Not executed in this session. |
| GUI in browsers other than the built-in browser | NOT_TESTED | |
| Smart Dispatch against a real reviewer | NOT_TESTED | Covered by unit and orchestrator tests with fake adapters only. |
| TokenEconomizer and Harness² effects | NOT_TESTED | Read-only status only, as in v0.2. |
| Real `verification` commands | NOT_TESTED | Commands are trusted user config and run through the same code path as the unit tests; no real user command was run. |

### 11.8 Carried to v0.3

- Decide whether a handoff counts toward `maxDepth` the way it does now, or get its own limit. Documented as is.
- Show passports and handoff in the GUI, with the same refusal messages as the CLI.
- Show Smart Dispatch settings in the GUI.
- Real-agent runs with approval, for the relay path and the review path.
- macOS and Linux runs of the clean ZIP check.
- Keep the source tree under git with a first commit, so future baselines are real commits and not snapshots.
- Set the copyright holder (LICENSE), still pending the user's decision.

### 11.9 Real-agent smoke test: Claude Code (post-baseline record)

Run after the `v0.2.1` baseline commit, with the owner's approval. One task, no code changed. This section is the only change recorded by the commit `docs: record verified Claude Code smoke test`.

| Item | Measured |
| --- | --- |
| CLI used by the adapter | `claude -p --output-format json` |
| Runs | 1 |
| Result | Success |
| Duration | about 11 seconds (10,737 ms in history) |
| Exit code | 0 |
| Reply | `pong` |
| Execution / Verification / Acceptance | SUCCESS / NOT_RUN / NOT_REQUIRED |
| History | 2 records (task and summary); `verdict` agrees |
| Tokens reported | input 2, output 4 |
| Cost reported by Claude Code | $0.1630 |
| Permission | `plan` mode; 2 sub-agent tools denied |
| Timeout | 90 seconds |
| Isolation | temporary `ORNELYON_HOME` and temporary workspace; the user's own data was not touched |
| Files changed | none (workspace stayed empty, repository unchanged) |

The cost is the figure Claude Code reported. It is not an invoice amount and does not show how much subscription quota was used. The two token counts reported (2 in, 4 out) should not be read as explaining that whole cost; the reason for the difference was not investigated.

**VERIFIED (REAL_AGENT, one run):** connection to the real Claude Code CLI; parsing of this JSON output; parsing of a normal successful result; recording in the Evidence Gate; agreement of CLI `verdict` and history.

**NOT verified:** Claude Code editing real files; handoff between real agents; real-agent failure, cancel and timeout; independent review by a real agent; any real Codex task.

**BLOCKED:** Codex tasks. The Windows sandbox setup error on this machine persists; nothing was changed to repair it.

## 12. ORNELYON v0.3.0 (handoff limits and minimal GUI, current revision)

Scope: separate nested depth from sequential handoffs, and show Smart Dispatch, passports and manual handoff in the existing GUI. No automatic handoff, no new engine, no new dependency.

### 12.1 Baseline and Git

- `v0.2.1` (commit `a657a80`) was not moved. The smoke-test record (section 11.9) is its own commit on `main`: `docs: record verified Claude Code smoke test`.
- v0.3 work is on branch `feat/v0.3`. Nothing was pushed and there is no remote.

### 12.2 What changed

| Area | Change | Where |
| --- | --- | --- |
| Config | New `multiAi.maxHandoffs` (0 to 5, default 2). `maxDepth` is unchanged and limits nested calls only. A config without `maxHandoffs` starts from its old `maxDepth` value, so it is never more permissive than v0.2.1. | `core/config.ts` |
| Handoff count | `handoffChain()` counts handoffs from history (the `handoff-from:` notes), not from the passport. The chain is **unverified** when the task or an ancestor is missing from history, or the lineage loops. An unverified count is refused, never taken as zero. | `core/passport.ts` |
| Refusal | `handoffRefusal()` now checks `maxHandoffs` (and chain verification) instead of `maxDepth`. All refusals still happen before any agent starts. | `interface/service.ts` |
| Overview | `handoffOverview()`: the same checks per target agent, without starting anything. Used by the API and the GUI so the preview and the real refusal cannot disagree. | `interface/service.ts` |
| API | `POST /api/handoffs` (needs `"confirm": true`), `POST /api/dispatch/plan` (dry run, starts nothing), `GET /api/passports/<id>` now includes the handoff overview. | `interface/server.ts` |
| CLI | `passport show` prints the handoff count and limit (or says it cannot be verified). | `interface/cli.ts` |
| GUI | Agents: Smart Dispatch card (enable, critical kinds, decision preview) and a `maxHandoffs` field. Runs: Passport panel and manual handoff with target choice, reasons, confirmation. The first allowed target is preselected; the outcome stays visible after the table refreshes. | `web/index.html` |

The orchestrator and the contract (`maxDepth`, `invocationDepth`) were not changed. Nested calls are still bounded by `maxDepth`.

### 12.3 Tests

Total: **188 tests, 188 pass, 0 fail** (174 from v0.2.1, one replaced, 15 added: 7 in `relay.test.ts`, 8 in `api.test.ts`).

| Test | What it shows |
| --- | --- |
| `maxHandoffs 0` | Every handoff refused before the agent starts |
| `maxDepth and maxHandoffs are independent` | `maxDepth` 0 does not block a handoff; high `maxDepth` does not allow more handoffs than `maxHandoffs` |
| `nested calls bounded by maxDepth` | A review at `maxDepth` 0 is refused by the recursion limit and no second agent starts |
| `chain counted in history` | Counts 0, 1, 2; the third handoff is refused at `maxHandoffs` 2 |
| `passport saved again` | Deleting and regenerating the passport three times never resets the count |
| `count that cannot be verified` | Missing parent, looping lineage, and task absent from history are all refused |
| `compatibility` | Config without `maxHandoffs`; a passport without `kind` and `integrity` re-sealed in the old shape still verifies and hands off |
| API (8) | Overview content; token, confirm and input validation without any model call; a confirmed handoff runs the agent exactly once and appears in history and in the next chain count; limit refused with a regenerated passport; disabled target and unknown passport; dispatch preview default and after a settings change; `maxHandoffs` config round trip |

### 12.4 Browser test (built-in browser, real server, fake local model)

Environment: scratch data folder, real GUI server on 127.0.0.1, a localhost fake model that counts its calls. Codex and Claude Code were disabled there. No real agent ran.

| Step | Result |
| --- | --- |
| Smart Dispatch: tick Enable, set critical kind, Save (real clicks) | PASS. `config.json` on disk shows `enabled: true` and the kind |
| Preview with kind `security` | PASS. Shows policy, selected agent, `NO_CALL`, the reason (no other enabled agent), "Extra agent call needed: no" |
| Runs: open Passport on a task with no passport | PASS. Shows "No valid passport" and a Save passport button |
| Save passport, view | PASS. Agent, status, checks, open issues, next step, handoff 0 of at most 2 |
| Hand off now without ticking the confirmation | PASS. Refused in the page; the model count stayed 0 |
| Hand off to a disabled target with the confirmation ticked | PASS. Server refusal shown ("disabled"); model count stayed 0 |
| Hand off to Local LLM with the confirmation ticked (real clicks) | PASS. One model call, a new task row, outcome notice kept after the refresh |
| Second handoff from the new task | PASS. Shown as "handoff 1 (at most 2 in a row); came from ..." and allowed; model count 2 |
| Third handoff (a chain of 2 already) | PASS. "Handoff limit reached: this would be handoff 3 ... maxHandoffs=2", also for Local LLM; model count stayed 2 |
| CLI on the same data | PASS. `passport show` prints "2 (limit 2)" and `handoff` is refused with the same message |

The first run of the page exposed two usability gaps, both fixed and rechecked: the target list started on a refused agent, and the handoff outcome disappeared when the table refreshed. The second and third handoff steps were driven by script clicks in the page (the same event handlers), not by pointer clicks. The page was only looked at in the built-in browser.

### 12.5 Package check

- `npm test` after removing `dist`: 188 pass. `npm run package` wrote `dist-package/ORNELYON-0.3.0.zip` (109,844 bytes, 43 files).
- No test, fake-agent, fixture, `.env`, `node_modules`, serena or history/config files in the ZIP; no key, token or personal-path pattern found in it.
- Extracted into a separate folder: `--help`, `doctor` and `run --dry-run` work and start no agent. `gui` served the page (200); an API call without the token returned 401, `POST /api/handoffs` without the token 401, a foreign Host 403. The server was stopped and the port was free. The only `node.exe` left is the Codex runtime of this machine, not ORNELYON.

### 12.6 Compatibility with v0.2.1

- `config.json` and `history.jsonl` from v0.2.1 load unchanged. A v0.2.1 passport (no `kind`) still verifies and can be handed off.
- Behaviour change: with `maxDepth` 0, a handoff is no longer blocked by it (it is not a nested call). In a v0.2.1 config the old `maxDepth` value becomes the starting `maxHandoffs`, so such a config allows no more handoffs than before.
- Handoff count in a chain whose earlier tasks were deleted from history: refused (v0.2.1 would have counted only what it could see).
- Kept names: `CHIMERA_HOME`, `start-chimera.*`, the `chimera` alias, `x-chimera-token`, `__CHIMERA_TOKEN__`, LICENSE holder.

### 12.7 Verification state

| Item | State |
| --- | --- |
| Claude Code, one read-only task | VERIFIED (section 11.9) |
| Claude Code editing real files, real handoff, real failure or timeout, real review | NOT_TESTED |
| Codex, any real task | BLOCKED. The Windows sandbox setup error persists; nothing was changed to repair it |
| Codex real `exec --json` output format | NOT_TESTED (fixtures are synthetic) |
| macOS and Linux, `.sh` launchers, double-click of the `.bat` | NOT_TESTED |
| GUI in browsers other than the built-in one | NOT_TESTED |
| Harness² execution, TokenEconomizer effect | NOT_TESTED (status detection only) |

### 12.8 Cost

No paid call was made in this revision. The only paid call is the single Claude Code smoke task recorded in section 11.9. Smart Dispatch stays off by default, so default runs make no extra agent call. The new API routes and the GUI start an agent only for an explicit, confirmed handoff.

### 12.9 Candidates for the next version

- Real-agent runs, with approval: Claude Code failure, cancel and timeout; one real Claude-to-Claude or Claude-to-Codex handoff once Codex is unblocked.
- Show the handoff chain as a list of links in the Runs table; narrow-screen layout for the passport panel.
- Count accumulated calls and cost over a whole handoff chain (today each handoff is checked against the daily budget per agent).
- macOS and Linux runs of the clean ZIP check.
- LICENSE holder: still the owner's decision.

## 13. Real-agent integration verification (v0.3.0, branch test/real-agent-v0.3)

Tag `v0.3.0` (99858800576897ab208d8765cbc9e8634bea2e55) was not touched. Nothing was pushed. Paid budget granted: Claude Code 2 calls, Codex 1 call. Used: Claude Code 2, Codex 0.

### 13.1 Conditions

Isolated `ORNELYON_HOME` and a temporary workspace holding only `sample.txt` (`ORNELYON_REAL_AGENT_HANDOFF_TEST`). Only Claude Code enabled; Smart Dispatch off; read-only (plan mode, 2 sub-agent tools denied); timeout 120 s; per-run budget 0.6 USD; no retries, no review. The file hash was identical before and after every step.

### 13.2 Results

| Step | Result |
| --- | --- |
| A1 real run (`run --agent claude`, `--verify-file sample.txt:<sha256>`) | Execution SUCCESS, Verification PASS (file check), Acceptance PENDING. Exit 0, 23 s, model `claude-sonnet-5-5`, tokens in 4 / out 512, reported cost $0.1883. JSON parsed by the existing adapter. |
| A2 `passport save` | Valid sealed passport. Handoff count 0 (limit 2). |
| A3 first `handoff --to claude` | Refused before launch (0 calls): the task kind `docs` is not declared by Claude's capabilities (`code`, `text`). This was a setup mistake of the test, and the refusal worked as designed. |
| A3 handoff after declaring `docs` in the scratch config | Real Claude Code started. Execution SUCCESS, Verification NOT_RUN, Acceptance NOT_REQUIRED. 13.8 s, tokens in 4 / out 505, reported cost $0.0736. History note `handoff-from:<A>` present; chain count 1 (limit 2). |
| Cost | `cost` total $0.2619 = the two task records. Summary records are not double counted. |
| Side effects | None: `sample.txt` unchanged (same sha256), workspace holds only that file, no history line holds a key or token (the word "token" occurs only in usage field names). The agent output does contain the local workspace path (stays in the scratch history only). |
| Offline regression | Clean build then `npm test`: 188 tests, 188 pass, 0 fail. No code was changed. |

### 13.3 Findings

1. **The handoff passes task state, not facts.** `handoffInstruction` sends objective, status, decisions, open issues, changed files and next step. It does not carry the previous agent's reported content or the file hash. Agent B said the content "matches what the previous agent reported", but it was not given that report, so this sentence is unsupported. The real handoff proves delivery of the state, not comparison of content. File equality is proven only by Agent A's sha256 check.
2. **The child passport loses the original goal.** Its objective is the line "Handoff from task <id>.", so a second handoff in a chain does not show the real objective.
3. **No custom handoff prompt.** The CLI cannot supply an own task text for Agent B, so the requested instruction ("compare with the handoff information") could not be given; B ran the passport's objective.
4. **Verification does not carry over.** B had no checks, so Verification is NOT_RUN (correct under the Evidence Gate, but the A-side PASS is not inherited).
5. **Capability declaration blocks a first handoff** when the task kind is not declared by the target. The message is clear; the default Claude capabilities do not include `docs`.

### 13.4 Codex

CLI 0.162.1, signed in (ChatGPT). `~/.codex/.sandbox/setup_error.json` (written 2026-10-31 15:36) still reads `helper_unknown_error: setup refresh had errors`; the earlier Default-profile access-denied cause was not changed. Per the rules, no Codex call was made, nothing was repaired, and the unused call was not moved to another paid test. State: BLOCKED. Real `exec --json` output remains NOT_CAPTURED.

### 13.5 State

| Item | State |
| --- | --- |
| Claude Code direct run, real JSON parsing, Evidence Gate, passport, cost accounting | VERIFIED |
| Real Claude-to-Claude handoff (start, history link, count, limit data) | VERIFIED |
| Handoff content comparison (A's report reaches B) | NOT_VERIFIED (not carried, see 13.1 finding 1) |
| Codex real run and `exec --json` | BLOCKED |
| Claude file edits, failure, cancel, timeout, real review; macOS and Linux; other browsers | NOT_TESTED |

## 14. ORNELYON v0.3.1 (Handoff Context, branch feat/v0.3.1)

Base: `test/real-agent-v0.3` (`1a76b6d`, which holds the v0.3.0 tag commit `9985880` and the section 13 record). The `v0.3.0` tag was not moved. Nothing was pushed; no v0.3.1 tag was made.

### 14.1 What changed

| Area | Change |
| --- | --- |
| Passport (still version 1) | Optional new fields: `originalObjective`, `agentReport` (bounded copy with sha256 of the full text, source record), `checkedFiles` (hash when saved), `handoff` (metadata when the task was itself a handoff). Older passports verify unchanged; a missing field is shown as "not recorded". |
| Objectives | `objective` is the current task (the user's instruction, or the original objective). `originalObjective` is the first request of the chain and survives A to B to C. "Handoff from task ..." is no longer used as an objective. |
| Handoff Context | `buildHandoffContext` (core/passport.ts) writes nine parts: original objective, current objective, previous agent, previous report, verified evidence, unresolved issues, next actions, constraints, instruction. No model call. |
| Trust | The report is framed as untrusted data and every line is prefixed, so it cannot imitate a heading or close the frame. Permissions, sandbox, budget and limits come only from configuration. |
| Evidence | ORNELYON's checks of the previous task are listed apart with the hash at save time next to the hash now. The previous Verification PASS is not inherited; the new task starts at NOT_RUN. |
| Limit | New `multiAi.handoffContextMaxChars` (default 6000, range 1000 to 20000). A long report is cut and the cut is stated and recorded. If the required parts leave no room, the handoff is refused before launch. |
| Instruction | `handoff --instruction "<text>"`, API field `instruction` (at most 1000 characters). Without it the earlier behaviour (the passport's next step) is kept; the source (`user` or `default`) is recorded. |
| Preview | `handoff --preview` and `POST /api/handoffs/preview` show the exact text and start nothing. The GUI passport panel got an instruction box, a collapsed report and a preview button, all backed by the API. |
| Drift | A file named by a passed file check is now also compared with its saved hash, so a changed checked file refuses the handoff before launch (unless "accept current state"). |
| Record | `RunRecord.handoff` on the summary record of a handoff task: source record, instruction, size, sha256 of the sent prompt, cut and missing parts. The task record holds the exact text. |

New modules: 0 (changes in passport, history, config, service, server, cli, web page). New dependencies: 0. Extra model calls needed to build the context: 0.

### 14.2 Offline tests

Total **207 tests, 207 pass, 0 fail** (188 from v0.3.0, 17 in `handoff-context.test.ts`, 2 in `api.test.ts`; one assertion in the relay E2E was updated because the prompt is now the Handoff Context). They cover: B receives A's report; report and evidence are separate; A's Verification PASS is not inherited; the original objective survives A, B, C; instructions pass and are recorded; an instruction cannot change configuration or start another agent; regenerating the passport or changing the instruction does not reset the count; a changed checked file refuses before launch; older passports load, gaps are named and nothing is invented; a missing report is stated; no evidence is shown as VERIFIED; the size limit and its cut; refusal when no room is left; the limit is a validated setting; a forged frame or heading in a report does not work and trusted limits still apply; forged, malformed and mismatching passport data and a damaged history line are refused or flagged; the same text from the Core function, the API preview and the real handoff (the fake model received exactly the previewed text); the GUI page builds no context of its own.

### 14.3 Real Claude Code check (1 call, Codex 0)

Data: the history of the earlier real Agent A (section 13, task `95e5f8f2`, real report, recorded 2026-10-31T15:12:36Z), copied into a new scratch home; its passport was regenerated with the v0.3.1 build (the original v0.3.0 passport was not used). This reuses a real report; it is not a new Agent A run.

| Check | Result |
| --- | --- |
| Started through the existing handoff path | Real Claude Code, plan mode, 2 sub-agent tools denied, timeout 120 s, `claude-sonnet-5-5` |
| What ORNELYON sent | 2927 characters; sha256 of the `task` record prompt in history equals the `handoff.contextSha256` on the summary record (`0b3a69e1aa8f`) and equals the preview |
| Report in the prompt | The prompt contains A's real sentence about being unable to tell CRLF from LF |
| Agent B's answer | It quoted what the report said about line endings and the trailing newline, read the file bytes itself (LF, no BOM, one trailing newline), found the content identical, and noticed that its own working directory differed from the path in the report |
| Evidence | Execution SUCCESS, Verification NOT_RUN, Acceptance NOT_REQUIRED (A's PASS not inherited) |
| Chain | Handoff count 1 (limit 2); original objective kept; the new objective is the instruction |
| File | `sample.txt` unchanged (same sha256) |
| Reported cost | $0.0893 (Claude Code's own figure; tokens in 4 / out 888). Not an invoice or quota figure |

Reception is shown by the ORNELYON-side hash match and by Agent B quoting content that exists only in the report. Agent B's answer alone was not taken as proof.

### 14.4 Package

`ORNELYON-0.3.1.zip` (121,408 bytes, 43 files plus the dist folder entry). It holds no test, fake adapter, history, config, passport or key; a scan for the user name and key patterns found none. Extracted into a separate folder: `--help` shows the new handoff options, `run --dry-run` starts no agent, the GUI served the page (200), an API call without the token 401, `POST /api/handoffs/preview` without the token 401, a foreign Host 403; the server was stopped and the port was free. The only `node.exe` left is the Codex runtime of this machine.

### 14.5 State

| Item | State |
| --- | --- |
| Handoff Context from history and passport, zero model calls, size limit, recorded hash | VERIFIED (offline tests and the real check) |
| Real Claude Code received a real previous report through the handoff path | VERIFIED for read-only Claude to Claude, one run |
| A real Agent A run under v0.3.1 | NOT_TESTED (the real A report was reused from section 13) |
| Context quality for large or multi-file reports, long chains (A to B to C with real agents) | PARTIALLY_VERIFIED (offline only) |
| Codex (any run) | BLOCKED (Windows sandbox, unchanged) |
| Real file edits, failure, cancel, timeout; macOS and Linux; other browsers | NOT_TESTED |
| LICENSE holder | Open, the owner's decision |

Known limits: the prompt carries local paths that appear in a report (here the scratch path) to the next agent; the report copy in the passport is capped at 4000 characters (the full text stays in history); the GUI preview was covered by API tests and a syntax check, not by a new browser session.

## 15. ORNELYON v0.3.1 final verification (branch feat/v0.3.1)

`v0.3.0` (9985880) was not moved. Nothing was pushed. No v0.3.1 tag was made.

### 15.1 Privacy audit of the handoff context

Finding: the previous agent's report can contain absolute local paths (the real report of section 14 held the scratch path) and, in principle, secret-like values. v0.3.1 first sent them on unchanged.

Fix (`cleanForHandoff` in core/passport.ts, applied to the report, original objective, issues, decisions, constraints, next step and check details; the saved passport and history are not changed):

| Rule | Behaviour |
| --- | --- |
| Absolute path inside the workspace (either slash style, any case) | Shown relative: `./sub/file`. Work stays possible. |
| Absolute path outside the workspace | Replaced by `<outside-workspace-path:name>`; the next agent is told such paths are not available unless the user grants them. |
| Secret-like values | `redact()` runs again over the text (history already redacted them at write time). |
| Disclosure | The context states what was changed and that the form of a path is not the previous agent's choice; `handoff.sanitized` records it in history. The sent text, the preview and the history hash stay identical. |
| The user's own instruction | Redacted for secrets, but paths in it are not rewritten (the user chose them). |
| Report text | Still framed as untrusted data; every line prefixed; trusted configuration alone decides permissions (tests show that an instruction or a report cannot change configuration or limits). |

Limits of this audit: pattern matching cannot prove that no secret is left, so it is a second layer, not a guarantee. Only Windows drive paths and the common POSIX roots (`/Users`, `/home`, `/mnt`, `/var`, `/tmp`, `/private`, `/etc`, `/opt`, `/c`, `/d`) are recognised; paths in other forms (UNC, `~`, other roots) pass unchanged. The GUI box "Previous agent report" shows the saved copy as it is, on the user's own screen; only what is sent is cleaned.

The real run showed a side effect: Agent B saw `./sample.txt` and called A's path "relative", although A had written an absolute one. The wording of the notice was changed (it now says the form of a path is not the previous agent's choice); the real run was not repeated. Also fixed: an original objective longer than 200 characters is now cut with a visible mark.

### 15.2 GUI in a real browser (built-in browser, real server on 127.0.0.1, fake local model, isolated home)

| Step | Result |
| --- | --- |
| Runs tab, Passport button (real pointer click), Save passport (real click) | PASS. Shows Original objective, Current objective, agent, status, checks, issues, next step, handoff history |
| Previous Agent Report | PASS. Collapsed; opened with a real click |
| Instruction typed (real typing), Preview (real click) | PASS. 2009 characters, sha256 `3595d7b50b99`, shows the exact text; workspace path relative, outside path replaced, disclosure line present |
| Hand off now without the confirmation (real click) | PASS. Refused in the page, model calls 0 |
| Confirmation (real click on the checkbox), Hand off now | PASS. One model call. The sha256 of the prompt the model received equals the history `handoff.contextSha256` and the preview (`3595d7b50b99`) |
| Runs after the handoff | PASS. The outcome notice "done: success" was kept after the refresh; the history row shows Verification NOT_RUN and the instruction |
| Refusals: Claude and Codex disabled; Local LLM without capability `security`; file changed after the passport was saved | PASS. The reason is shown before start and by the server on a confirmed attempt; model calls stayed 1 |

The refusal steps and the page-state reads were driven by script clicks in the page (the same handlers), not pointer clicks. Only the built-in browser was used.

### 15.3 Real Claude Code A to B on the v0.3.1 build (2 calls, Codex 0)

Scratch home and workspace; `sample.txt` was a 48-byte two-line CRLF file; read-only, plan mode, sub-agents denied, 120 s, Smart Dispatch off, no retry.

| Step | Result |
| --- | --- |
| A: `run --agent claude --verify-file sample.txt:<sha256>` | Execution SUCCESS, Verification PASS (ORNELYON's sha256 check, independent of A's text), Acceptance PENDING. A reported CRLF, 48 bytes, both lines and a hex dump. Reported cost $0.0826 (tokens in 4 / out 618) |
| Passport | Saved with original objective, report copy (sha256) and checked file hash |
| Preview | 2845 characters, sha256 `748c70ca702d`, report ATTACHED |
| B: `handoff --to claude --instruction ...` | Started through the existing path. The `task` prompt in history has sha256 `748c70ca702d`, equal to `handoff.contextSha256` and the preview, and contains A's sentence "The hex dump shows". Execution SUCCESS, Verification NOT_RUN, Acceptance NOT_REQUIRED (A's PASS not inherited). Reported cost $0.0831 (tokens in 4 / out 975) |
| B's content | Read the bytes itself; compared line 1, line 2, line endings and size with A's claims, all matched; found the 48 bytes and CRLF independently |
| Chain and limits | Handoff count 1 of 2; original objective kept; no budget or limit changed |
| Side effects | `sample.txt` unchanged (same sha256); no other file in the workspace |

Total reported cost of the two calls: $0.1657 (Claude Code's own figure, not an invoice or quota figure). Reception is shown by the hash match and by B quoting A's specific claims; B's answer alone was not taken as proof. A's claims did not become "verified" by being passed on: the only independent evidence is the sha256 check.

### 15.4 MCP design memo (not implemented; decision for a later version)

Keep the internal agent calls on the CLI adapters. An MCP server would only expose parts of the Core so that other tools can ask ORNELYON questions.

- Initial tools, read-only and preview-only: `status` (doctor summary), `dispatch_preview` (the function behind `run --dry-run` and `POST /api/dispatch/plan`), `passport_show` (loadPassport plus the handoff overview), `handoff_preview` (`prepareHandoff`, nothing started), `evidence_verdict` (`evidenceFor`). Each is a thin wrapper over a function the CLI and API already call, so no judgement logic is duplicated.
- Out of scope at first: starting agents, running a handoff, recording accept or reject, changing configuration or tool states.
- Transport: local stdio first (a child process of the host tool; no listening port). An HTTP transport would need the same host and token checks as the GUI server and is a later question.
- Boundaries: the server sees the user's history and passports. It must apply the same cleaning as the handoff context to anything it returns (paths, secret-like values) and return only what a tool needs. Tool results are data for the calling agent, never permission.
- Cost: every tool definition is added to the calling agent's context. Five tools with short descriptions and small result schemas keep that small; results should be capped like the handoff context.
- Optional: ORNELYON must run unchanged with no MCP. The server would be a separate entry point, not a dependency of the Core, and must not add runtime dependencies if the stdio protocol can be handled in a small module (to be checked).
- CLI versions seen here: Claude Code 2.1.311 has `claude mcp add|list|get|remove` (stdio and HTTP); Codex 0.162.1 has `codex mcp list|get|add|remove|login|logout` and `codex mcp-server`. Client behaviour and tool-approval prompts differ, so the design must be tested on each, and tool names kept short and stable.
- Not a workaround: MCP is not a way around the Codex Windows sandbox failure (section 13). Codex still runs its own tools in its sandbox, and doing the sandbox's work from outside it would remove a safety boundary.

### 15.5 Regression and package

Clean build and `npm test`: **209 tests, 209 pass, 0 fail** (188 + 19 for v0.3.1 + 2 privacy tests). `run --dry-run` and the API integration tests pass. `ORNELYON-0.3.1.zip` (124,801 bytes) was rebuilt; it contains no test, fake adapter, history, passport, config, `.env` or auth file, and no user name or key pattern. Extracted into a separate folder: `--help` shows the new options; the GUI served the page (200); an API call without the token returned 401; `POST /api/handoffs/preview` without the token 401; a foreign Host 403; the server was stopped and the port was free. The only `node.exe` left is the Codex runtime of this machine.

### 15.6 State

| Item | State |
| --- | --- |
| Handoff Context (history to context, no model call, size limit, hash record, path and secret cleaning) | VERIFIED (offline tests, GUI, one real A to B) |
| Real Claude A to B on the v0.3.1 build, read-only, CRLF file | VERIFIED (one run each) |
| GUI in the built-in browser (passport, preview, confirmed handoff, refusals) | VERIFIED for that browser; some steps script-driven |
| Behaviour with large reports, many files, paths in unusual forms | PARTIALLY_VERIFIED (offline only) |
| Codex (any real run) | BLOCKED (Windows sandbox, unchanged) |
| Real file edits, failure, cancel, timeout; macOS and Linux; other browsers | NOT_TESTED |
| LICENSE holder | Open, the owner's decision |

## 16. ORNELYON v0.4.0 (MCP Server Lite and Efficiency Benchmark, branch feat/v0.4.0)

> Historical. Sections 16.1 (data minimisation, e-mail masking) and the "shown text versus sent text" limit were changed in v0.4.1; the current behaviour is in section 17.

Base: v0.3.1 (00c97b0, 209 tests). `v0.3.1`, `v0.3.0`, `v0.2.1` and `main` were not touched. Nothing was pushed. No v0.4.0 tag was made. **No paid agent was called in this version** (no new Claude or Codex run); Codex remains BLOCKED.

### 16.1 MCP Server Lite

| Item | Decision |
| --- | --- |
| Entry point | `ornelyon mcp` (stdio, one JSON-RPC message per line). `mcp --print-config` prints registration commands for Claude Code, Codex and mcp.json clients and changes nothing. No client setting was edited. |
| SDK or own code | Own small handler. `@modelcontextprotocol/sdk` 1.32.2: 4.5 MB unpacked, 17 direct dependencies (express, hono, zod, ajv, jose, ...). ORNELYON has no runtime dependency and needs four methods (initialize, ping, tools/list, tools/call). The SDK is a **dev dependency** used by one test as the reference client. Wire format is not extended: standard methods, standard result shape (`content`, `isError`), tool annotations `readOnlyHint` etc. Protocol versions 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 are accepted (checked against the SDK's own list). |
| Tools (6) | `ornelyon_status`, `ornelyon_recent_tasks`, `ornelyon_dispatch_preview`, `ornelyon_evidence`, `ornelyon_passport`, `ornelyon_handoff_preview`. Each calls an existing Core function. `dispatchPreview` was moved from server.ts into service.ts so the API, the CLI and MCP share it (the API test for it still passes). |
| Cannot act | No start-agent, run-handoff, accept/reject or configuration tool exists. No tool takes a path, command, setting or confirmation; unknown arguments are refused. A test checks the compiled `mcp.js` for imports of anything that can act. |
| Data minimisation | Default: ids, states, counts, sizes, hashes. Objectives, reports, next steps, acceptance reasons, instruction echo and the handoff text only with `--expose-content`. All strings: workspace paths relative, outside paths replaced, secret-like values and e-mail addresses masked, cut at 4000 characters (handoff text 20000). `--tools` limits the offered tools. |
| Not a Codex workaround | Nothing in MCP starts or runs a Codex task. |

### 16.2 Efficiency Benchmark

`optimization/benchmark.ts` (pure functions over history) and `interface/cli-benchmark.ts`. Commands: `benchmark [--by agent|kind|shape] [filters] [--json] [--history file]`, `benchmark compare --a ... --b ...`, `benchmark synth --out file` (deterministic synthetic history). Per task: calls, extra calls, Execution/Verification/Acceptance, agent time, tokens, reported cost, cost of extra calls, cost per successful task. Unreported values stay unknown (left out of averages with n and unknown counts shown). Only `task`, `review` and `fallback` records are calls, deduplicated by task id. Fake and synthetic calls are flagged. `compare` lists differences (kinds, final agents, overlap, group size), pairs identical first prompts, and sets `likeForLike` only when nothing differs and no fake data is present. Output is reproducible (`data sha256`). The module imports no agent, orchestrator or network code (checked by a test). No GUI change.

### 16.3 Tests

`npm test`: **234 tests, 234 pass, 0 fail, 0 skipped** (209 + 13 benchmark + 12 MCP). Included: hand-worked totals that also agree with the existing cost monitor; duplicate call records; unknown cost/tokens; shapes; paired comparison; reproducibility; synthetic flagging; CLI leaves the history file byte-identical; MCP in-process (handshake, version negotiation, errors, argument validation, smuggled arguments, content withheld/cleaned, no file in the data folder changes, refusals reported as tool errors), the stdio loop, and the **official SDK client over a real child process** (connect, list, call, refused unknown tool, nothing written).

Also run by hand (no model): `ornelyon_status` through the SDK client (369 ms; it runs only the `--version` and sign-in checks `doctor` already runs); the extracted zip answered as server 0.4.0 to the SDK client.

### 16.4 Package

`ORNELYON-0.4.0.zip`: about 160 KB (v0.3.1: 124,801 bytes, so about +35 KB). Contains no tests, no node_modules, no history, passport, config, `.env` or auth file. `package-lock.json` in the zip lists the dev-only SDK (3 lines); a user install needs no `npm install`, or `npm ci --omit=dev`.

### 16.5 State

| Item | State |
| --- | --- |
| MCP protocol conformance of `ornelyon mcp` against the official SDK client (Windows, Node 24) | VERIFIED |
| Read-only guarantee (no acting tool, no disk change, no agent start) | VERIFIED by tests and code-level checks |
| Benchmark arithmetic, no double counting, unknown handling, reproducibility | VERIFIED on hand-built and synthetic history |
| Benchmark on real agent history, real token or cost savings | NOT_TESTED (needs an approved paired real-agent run) |
| Registering in real Claude Code / Codex and calling from them | NOT_TESTED (would change the user's CLI settings or cost a model call) |
| Per-client authorisation, HTTP transport, other OS, other MCP clients | NOT_IMPLEMENTED / NOT_TESTED |
| Codex (any real run) | BLOCKED (unchanged) |
| Masking of secrets and paths (pattern based; unusual path forms, UNC, `~`); the real handoff does not mask e-mail addresses | known limit, unchanged |
| MCP content mode: shown handoff text can differ from the sent text (extra masking); `textIsExactlyWhatWouldBeSent` says so | known limit |
| Benchmark fake/synthetic detection is by name only (fake-agent.mjs through real adapters is recorded as claude/codex and not flagged) | known limit |
| Conformance check method | the SDK client plus a read of the 2025-11-25 spec pages (transports, lifecycle, tools). Our -32002 for requests before initialize is allowed but not mandated by the spec |
| LICENSE holder | Open, the owner's decision |

### 16.6 Final checks from the extracted zip

GUI served from the extracted folder: page 200; `POST /api/dispatch/plan` without token 401; foreign Host 403; with token it returned `started:false` (the refactored shared `dispatchPreview`); server stopped, port free. `tools/list` is 3,375 characters (about 850 tokens) of context per MCP session; MCP and benchmark calls make no model call. The only `node.exe` left is the machine's Codex runtime (host-daemon).

## 17. ORNELYON v0.4.1 (MCP security and reliability, branch feat/v0.4.1)

Base: v0.4.0 (6384f90, 234 tests). `v0.3.1`, `v0.3.0`, `v0.2.1` and `main` were not touched. Nothing was pushed. No v0.4.1 tag was made (it waits for the owner's final check). **No paid agent was called** (no Claude or Codex run); Codex remains BLOCKED. Two sub-agents were used only to read specification web pages (no code, no model work on the project).

### 17.1 MCP data scope (P0)

The server cannot tell which program started it, so the control is a scope the operator fixes at start. Default: **no task is visible**. `--recent N` (snapshot of the N newest at start), `--allow-task <id>` (repeatable), `--all-tasks` (explicit; refused together with `--expose-content`, in the CLI and again in `createMcpSession`). Content mode shows free text only for tasks in scope. Out-of-scope and non-existent tasks give an identical error. Ids must match the UUID form exactly (path-like, upper-case, padded, non-string, array, object values refused before any file access). `recent_tasks` filters by scope before its limit. Damaged passports (edited after sealing, truncated) and garbage history lines give a tool error or are skipped; a healthy in-scope task is still served. Annotations stay as hints only. Agent start, handoff, accept/reject and configuration changes remain impossible (no such tool; compiled-module check unchanged).

Migration: a v0.4.0 registration (no scope) sees no tasks in v0.4.1; register again with `--recent N` or `--allow-task`. `mcp --print-config` prints the narrow default (`--recent 5`) and states that the scope is the only access control.

### 17.2 Handoff and MCP protection (P0)

Cause of the v0.4.0 difference: MCP applied an extra e-mail mask on top of `cleanForHandoff`, while the real handoff did not mask e-mail at all. Now there is one cleaner. `cleanForHandoff` also replaces e-mail addresses with `[email-removed]` and counts them; the handoff context discloses the count (`handoff.sanitized`), so a real handoff now removes addresses too. The MCP handoff preview returns the exact string the handoff builder made, after checking its sha256; the test compares it with `prepareHandoff`'s text (CLI, API and a real handoff use the same string). Differences that remain are by design and documented: MCP withholds text unless content mode is on and the task is in scope; the passport tool shows the report cut at 4000 characters; a caller's own preview instruction is shown as given. Guarantees and limits of cleaning are written in ARCHITECTURE.md (patterns only; UNC, `~`, unusual roots, unrecognised secrets and non-address personal data pass; a marker can hide a needed fact, so the context says that something was removed and how often).

`--expose-content` re-evaluated: kept, but narrower (needs a scope, in-scope tasks only, never with `--all-tasks`).

### 17.3 Benchmark origin (P1)

`AgentAdapter.provenance` (`cli`, `local-endpoint`, `fake-adapter`, `test-command`) is set by the adapter classes from how they were built and written by the orchestrator to the new optional `RunRecord.origin`. Nothing an agent returns can set it (tested with an agent whose output claims to be real). Real = `cli`, `local-endpoint`. Older records have no origin and are **unknown**: not real, not fake. Task origin: `real` only if every call is real; any non-real call makes it `non-real`; else `unknown`. `likeForLike` requires all tasks in both groups to be `real`; the compare report lists the conditions that differ (kinds, final agents, shapes, overlap, size, origin) and warns when both groups have the same shape. The v0.4.0 name-based flag stays as a second signal. Totals for old history are unchanged (tested). Dedup key now includes role, agent and time besides the task id; a test with the real orchestrator (review, fallback, retry) shows no paid call is dropped (v0.4.0 follow-up). Local endpoints cannot be proven real: a stand-in HTTP server is recorded as `local-endpoint`.

### 17.4 MCP protocol (P1)

Read from modelcontextprotocol.io (2025-11-25 pages in v0.4.0; the 2026-07-28 changelog, versioning and the TypeScript SDK v2 pages now). 2026-07-28 removes `initialize`, adds a required `server/discover`, a required `resultType`, `ttlMs`/`cacheScope` on `tools/list`, removes `ping`. Not read: the 2026-07-28 lifecycle, tools and stdio pages, so exact shapes are unverified. Decision: stay on the legacy era (2024-11-05 to 2025-11-25) and say so; do not implement 2026-07-28 from partial knowledge. A dual-era client probing `server/discover` gets "method not found" (tested) and falls back to `initialize`. A client that speaks only 2026-07-28 cannot use this server. SDK v2 (`@modelcontextprotocol/server`, needs zod) was not adopted: a dependency tree for a read-only stdio tool, and the v1 SDK client remains the conformance reference in one test.

### 17.5 Claude Code as MCP client

In a temporary folder, `claude mcp add --scope project` wrote only that folder's `.mcp.json`; `claude mcp list` showed the server as **Pending approval (run `claude` to approve)**. Approving requires an interactive `claude` session (a model session, and it records trust in the user's `~/.claude.json`). Not done. The only change in `~/.claude.json` between before and after was the routine `oauthAccount.profileFetchedAt` timestamp; no project entry was added. Procedure for a live check, which needs the owner's approval: in the temporary folder run `claude`, approve the `ornelyon` server, ask it to call `ornelyon_recent_tasks`; expect the tasks chosen by `--recent`/`--allow-task`.

### 17.6 Tests and package

`npm test`: **249 tests, 249 pass** (234 + 7 MCP + 8 provenance). New MCP tests: scope isolation and identical refusals, default none, `all` + content refused, content only in scope, 15 odd id forms and 6 odd `to` values with the data folder unchanged, damaged passports and history, `server/discover` fallback, CLI flag refusals and the narrow default registration. SDK end to end now starts the server with `--allow-task`.

### 17.7 Test policy decided by the owner

From this point v0.4.1 is not tested with any paid or metered agent call (outside the subscription allowance). Consequences, recorded as they are: no real Claude Code or Codex call was made in v0.4.0 or v0.4.1; the live connection from Claude Code to `ornelyon mcp` was **omitted by policy and is NOT_TESTED** (the `claude mcp add` / `claude mcp list` attempt in 17.5 only reached "Pending approval"); real `cli` and `local-endpoint` origins and real token or cost figures are not exercised by any test. The procedure in 17.5 stays for a later, separately approved check. Results already obtained, including the official SDK client over stdio, keep their status below. The documents were checked against the code only; no feature or test was added after commit 797695e.

### 17.8 State

| Item | State |
| --- | --- |
| MCP scope enforcement, refusal equality, id validation, damaged data | VERIFIED (in process and over stdio with the official SDK client) |
| MCP read-only property (no acting tool, no disk change) | VERIFIED |
| Handoff and MCP use one cleaner; preview text equals sent text | VERIFIED |
| Cleaning completeness (secrets, paths, personal data) | PARTIALLY_VERIFIED: pattern based by nature |
| Benchmark origin recording and use; old history unchanged | VERIFIED with fake adapters, test commands and hand-built records |
| Origin of real `cli` and `local-endpoint` calls | PARTIALLY_VERIFIED: constructor-level and by rule; no real call was made in this version |
| Protocol 2025-11-25 and earlier | VERIFIED against the official SDK client |
| Protocol 2026-07-28 | NOT_IMPLEMENTED (documented); lifecycle/tools/stdio pages of that revision NOT_TESTED |
| Live connection from Claude Code | NOT_TESTED (omitted by policy; implemented and reachable only through the official-SDK stdio path, which is VERIFIED) |
| Codex (any run, as MCP client or agent) | BLOCKED (Windows sandbox, unchanged) |
| Real token/cost saving, real-agent paired comparison | NOT_TESTED (needs approval) |
| macOS/Linux, other MCP clients, HTTP transport, per-client authorisation | NOT_TESTED / NOT_IMPLEMENTED |
| LICENSE holder | Open, the owner's decision |

### 17.9 Independent audit fixes (F1 to F7)

An independent read-only audit (base commit e85a2d9) found seven defects. Fixed with fake adapters, stubbed fetch and temporary folders only: no real agent, credential or paid call. F1 workspace boundary: a path is inside only by a real-path relation (no string prefix), links and junctions are resolved first, loops and unknown boundaries fail closed; file checks, JSON checks and hashing share `resolveInsideWorkspace`; snapshots use lstat and never follow links. F2 scope: the whole workspace is snapshotted (not just the working folder) for workspace-write runs and for any run with a scope rule; files up to 256 MiB are hashed; gaps (excluded folders, oversized or unreadable entries, file limit) turn the scope check into UNVERIFIED; a read-only setting no longer yields PASS by itself. F3 Research: disabled agents are refused, the plan is refused up front when variants x samples exceeds `maxCalls`, and calls are recorded with their origin. F4 MCP: the four history-reading tools mark answers `historyComplete: false` when history lines were skipped. F5: a failure while the local-LLM response body is read becomes a failed result with unknown usage and cost. F6: benchmark input and output tokens are known independently. F7: MCP loads the config read-only (no `.corrupt` copy). Known side effect: because `.git` and `node_modules` are excluded folders, a scope check in such a workspace is UNVERIFIED, not PASS. Tests: 281 (249 existing + 32 in `audit-fixes.test.ts`). The API tests were intermittently failing with ECONNRESET on a pooled connection (also before these changes); the test client now opens a fresh connection per call (test-only change).

F2 follow-up (Codex re-audit of 1b9fca2 reproduced it). The scope snapshot was taken after the agent and before the verification commands, so a command that wrote outside the allowed files was never seen. The order is now: baseline before the agent; every verification command once, waited for; final snapshot; scope rule against the baseline (`scopeCheck`, `core/verify.ts`); a throw from a command is recorded as UNVERIFIED, not PASS, and a failing command still gets the final snapshot. Six automated regression tests in `audit-fixes.test.ts` cover: the Codex reproduction (fails on 1b9fca2); an overwritten out-of-scope file; a failing command with a side effect; a read-only run whose command writes outside; a gap; and normal work. **Detection of a deleted file was confirmed in a supplementary audit experiment. It is not among these six automated tests.**
F8 (verification results could go stale). Codex's re-audit found that the file, hash and JSON checks ran before the verification commands, so a command that changed a checked file left the old PASS in place. Now `src/interface/service.ts` (`startTask`) and `src/core/verify.ts` run: the baseline before the agent; the agent; each verification command once, waited for (`runCommandChecks`); the final snapshot; the scope rule against the baseline (`scopeCheck`); the file, hash and JSON checks against the final state (`runStateChecks`). A check whose file no longer matches the final snapshot is UNVERIFIED. A failed final snapshot makes the file, hash and JSON checks UNVERIFIED. `runVerification` keeps its signature and its result order for existing callers. Eight automated tests in `audit-fixes.test.ts` cover the Codex cases: invalid JSON written by the command (fails on 0fc85ce); changed content behind a correct hash (fails on 0fc85ce); a failing command that also changes the JSON (fails on 0fc85ce); a command that changes nothing (PASS); an out-of-scope write (scope FAIL); a gap; a single execution of the command; and the unit rules for a snapshot mismatch and a snapshot failure.

What the snapshots guarantee, and what they do not. They detect differences inside the defined workspace between observation points. They do not prevent writes. They give no guarantee against writes outside the workspace, against a change that is fully undone before the next snapshot, or against a separate process that keeps writing after the final check. A deleted file is detected by the same comparison (confirmed in the supplementary experiment above, not in an automated test). The result of a check is only as current as the final snapshot it is compared with.

Limit that remains: a verification script the agent may edit proves nothing about its own result. ORNELYON cannot tell an edited check from an honest one, so a PASS from such a command is not independent evidence. Mitigation for the user is to keep check scripts outside the allowed files. A future change could mark a command UNVERIFIED when a file it runs changed in the same run; it is not implemented.

### 17.10 Release-candidate status

v0.4.1 is a **release candidate**, not a released version: no tag, no push, no publication. It is confirmed for what the VERIFIED rows cover. Everything marked NOT_TESTED, PARTIALLY_VERIFIED or BLOCKED above is a stated limit, not a result. A tag or release needs the owner's separate approval.

## 18. ORNELYON v0.4.2 (GUI name and version, handoff documentation, package safety; branch feat/v0.4.2)

A maintenance release. No feature was added. Base: `338b1c9` (branch `feat/v0.4.1`), the same source as the published v0.4.1 (`src`, `web`, `scripts`, `package.json`, `package-lock.json` compared file by file before the changes: identical). Not committed, not pushed, no tag. This section was corrected after the first independent audit (18.7); where it differs from the first version of this section, this version is the record.

### 18.1 What changed

| Area | Change |
| --- | --- |
| GUI header | `web/index.html`: the old-name sentence and the fixed "(v0.3.1)" are gone. The header shows `v<version>` from the placeholder `__ORNELYON_VERSION__` |
| Version source | `src/interface/server.ts`: `readPackageVersion()` reads `package.json` (the only place the version is written) and requires `x.y.z` with an optional `-suffix`. `renderPage()` fills the version and the session token in one pass with replacer functions, so `$&` and similar patterns are never expanded. Each placeholder must occur exactly once in the template, otherwise start-up fails instead of serving a raw placeholder. No new API, no new dependency |
| Session token | The quoted placeholder `'__CHIMERA_TOKEN__'` is replaced by a complete JSON string literal in which `<`, `>`, `&`, U+2028 and U+2029 are written as `\u` escapes. Every token that `startServer(port, existingToken)` accepted before is still accepted (the first version of this release wrongly limited it to letters, digits, `-` and `_`). The URL printed at start-up carries the token through `encodeURIComponent`. Authentication compares the original value |
| Package script | `scripts/package.mjs`: (1) the whole `dist-package` folder is no longer deleted; only this version's staging folder and zip are replaced, other versions are left alone; (2) the package is compiled into its own fresh folder (`dist-package/.build-ORNELYON-<version>`, removed afterwards) and only that output is copied, never the contents of `dist`, so a stale file in `dist` cannot enter the zip; a failed compile stops before any existing package is touched |
| Tests | `src/test/server.test.ts`: 5 tests added (version equals `package.json`, no placeholder left; header without the old name or the old version; 401 without a token; `renderPage` accepts and refuses the right inputs; eleven token shapes: all embedded as an exactly restoring script literal, the ASCII ones also authenticated over HTTP, see 18.4) |
| Documents | README and README_ja: handoff routes (four kept-apart statements, nine routes, availability and capability conditions as the code applies them), version, test count and build lines. SECURITY.md (current version; v0.4.1 listed as older) and UNINSTALL.md (example folder). `package.json` and `package-lock.json` (two version fields): 0.4.2 |

Unchanged on purpose: `CHIMERA_HOME`, `start-chimera.*`, the `chimera` bin alias, `x-chimera-token`, `__CHIMERA_TOKEN__`, internal type names, and the historical "saved before v0.3.1" texts. The handoff logic, agent routing, authentication of the agent CLIs and the MCP server were not changed.

### 18.2 Handoff documentation: what is and is not claimed

All nine source and target combinations of Claude Code, Codex and the local LLM go through the same checks (`handoffRefusal`) and always run read-only (`sandbox: 'read-only'`); same-agent and different-agent routes are not treated differently. Handoff is manual only; a handoff that edits files is not supported. The README keeps four statements apart: implemented in code (nine routes), offline tests (representative routes with fake agents: targets Codex, Claude Code and local; not every pair separately), real-agent results (Claude Code to Claude Code only) and not verified (the rest).

Availability as the code applies it (`availabilityFrom`): Codex and Claude Code are available when the program was found, its version command ran, and its login-status command reported a signed-in state (an unreadable status counts as not signed in); the local LLM is available when the configured URL answers `GET /models` below HTTP 500 (no API key is needed unless `apiKeyEnv` is set; a rejected key or a missing model is found only when the run starts). The capability check runs only when the passport records a task kind; a passport without a kind (task without `--kind`, or saved before v0.2.1) skips it. The first version of this section and of the README said "installed or signed in at the last check" and "does not declare the task's capability" without these limits; that was too coarse.

### 18.3 Real-agent check on the v0.4.2 build (2026-11-02)

This is a check of ORNELYON's own handoff path with a real agent. It is separate from any code review.

| Item | Result |
| --- | --- |
| Conditions | Claude Code 2.1.311 with its subscription sign-in (`claude.ai`); no API key variable set; isolated `ORNELYON_HOME` and a scratch workspace holding one 44-byte CRLF file; only Claude Code enabled; Smart Dispatch off; read-only (plan mode, 2 sub-agent tools denied); timeout 120 s; per-run budget 0.6; no retry; no sub-agent and no review by another agent was used |
| Run A: `run --agent claude --kind text --verify-file sample.txt:<sha256>` | Execution SUCCESS, Verification PASS (ORNELYON's file hash check), Acceptance PENDING. Claude Code reported the two lines, CRLF and 44 bytes |
| Passport and handoff B: `handoff --to claude --instruction ...` | Execution SUCCESS, Verification NOT_RUN, Acceptance NOT_REQUIRED. The sha256 of the prompt stored in history equals `handoff.contextSha256` (`153e0892a31a`). B's answer states that A's claims match the file. **No trace of B opening or reading the file was saved**, so that B read the file is not proven; what is shown is that B received the exact text and that its answer agrees with the file as ORNELYON's hash check saw it |
| Side effects | The file hash was unchanged; the workspace holds only that file |
| Calls and cost | Claude Code 2 calls; Codex 0. Claude Code's own reported figure for the two calls: $0.2699 (tokens in 8, out 1302). It is not an invoice or a quota figure |
| Codex | **Not run (NOT_TESTED).** The Windows sandbox helper of Codex has an earlier recorded side effect on this machine's profile permissions and a standing decision not to run it without a new decision, and nothing may be loosened for a test. No Codex call, no Claude Code to Codex and no Codex to Claude Code handoff was made |
| Terms | Whether a third-party tool may drive these CLIs under a subscription sign-in stays **NOT CONFIRMED**. One successful run does not change that |

Only the Claude Code to Claude Code route has real-agent evidence, now from v0.3.0, v0.3.1 and this check. The other eight routes remain NOT_TESTED. A handoff that edits files, a real failure, and macOS and Linux were not tested.

### 18.4 Tests and package checks (measured on Windows 11, Node.js 24.19.0, this machine)

Offline tests and real-agent runs are counted separately and are not added together.

| Check | Result |
| --- | --- |
| TypeScript build | PASS |
| `npm test` (build + all offline tests, no real agent) | PASS: 286 tests, 286 pass, 0 fail (281 before this release, 5 added) |
| Token test cases (in the offline suite) | `abc.def`, `abc+def=`, a single quote, a double quote, backslashes, `</script><script>alert(1)</script>`, `<!-- x`, `$& $1 $$` and a backtick, U+2028 with U+2029, a token that contains the version placeholder, and non-ASCII text. The test first checks that each string really contains the intended characters, then checks: page 200, no placeholder left, same number of inline scripts as the template, no raw U+2028 or U+2029, the script compiles (`vm.Script`), the literal evaluates to exactly the token, the printed URL decodes to the token, and (for ASCII tokens, which an HTTP header can carry) 200 with the token, 401 with a changed token and 401 without |
| `git diff --check` | PASS (the extra blank line at the end of this file was removed) |
| Stale build output | Reproduced in an isolated copy with `dist/audit-stale.js`, `dist/core/removed-module.js` and `.js.map` files that have no source: none of them is in the zip (58 entries, CRC test clean, no `dist/test`). Run twice (same-version regeneration works). A planted `ORNELYON-0.0.9.zip` and a copy of the v0.4.1 zip were byte-identical afterwards. A deliberate compile error left the existing 0.4.2 zip unchanged and no `.build` folder in the zip |
| Zip extracted to a new folder, started with an isolated data folder | CLI `doctor` and GUI start: 200, `v0.4.2`, no placeholder, no old name, token embedded once, 401 without and 200 with the token |
| v0.4.1 artifacts | `ORNELYON-0.4.1.zip` sha256 `206c63e1eb0cf1e273199ebcda42515482e508c2479e54cea560c3afff2d3df0`: identical before the first change, after the backup, after each package run, and at the end of this phase; the `ORNELYON-0.4.1` folder's file-list hash was identical too |
| Same version generated twice | The zip is valid; its bytes differ because entry timestamps are stored. It is not reproducible byte for byte |
| Real browser | PASS in the first round (built-in browser, extracted zip, small viewport only); other browsers and sizes NOT_TESTED |

### 18.5 Old-name residue scan of the development zip (Phase B2; all letter cases)

Scanned: file names and all lines of every entry of the freshly built zip (58 entries, 48 text files, no binary entry) including the compiled JavaScript, plus the source, the CLI help and the GUI page. Binary content could not be searched; there was none. For this scan only, the text of this section 18 was left out of the counts; the final scan in 18.10 includes it. **PUBLIC_UNINTENDED: 0. UNKNOWN: 0.**

| Class | Count | What | Why it stays |
| --- | --- | --- | --- |
| COMPAT_REQUIRED | 32 | `CHIMERA_HOME` (paths, MCP, docs), `start-chimera.bat` and `.sh` (names and mentions), `x-chimera-token`, `__CHIMERA_TOKEN__` (page and compiled server), the `chimera` bin alias in `package.json` and `package-lock.json`, the documented `chimera` alias (README, CLI help text) | Existing installs and clients depend on them |
| HISTORICAL | 23 | The README and README_ja sentence saying "CHIMERA Harness" and "NEXORA Harness" are earlier names; the comment lines of the two legacy launchers; sections 1 to 17 of this report | Correct history; sections 1 to 17 are kept as written |
| PUBLIC_UNINTENDED | 0 | none | |
| UNKNOWN | 0 | none | |

Internal identifiers such as `ChimeraConfig` exist in the source and tests (COMPAT_REQUIRED, internal type name); the compiled output of a type-only name carries no text. The classification is rule based: each hit was assigned by a pattern for the compatibility names, by the "earlier names" and launcher-origin sentences, and by position (before this section) for the older report sections; a hit that matched no rule would have been UNKNOWN. The final zip must be scanned again (see 18.6).

### 18.6 What was checked on which artifact

| Artifact | Checked | State |
| --- | --- | --- |
| 1. Development source | build, 286 offline tests, `git diff --check`, name scan of the source | PASS |
| 2. Development zip (`dist-package/ORNELYON-0.4.2.zip`, built from the development tree) | entries, CRC, stale-file test, extracted CLI and GUI start, name scan, secret and personal-data scan: no key-like strings, no e-mail address, no user name. **It still contains personal environment paths**: `IMPLEMENTATION_REPORT.md` line 94 holds the local development folder path and line 133 holds the path of the default Windows user-profile folder (section 1 to 17 text, unchanged on purpose) | PASS for the checks listed; **not publishable as is** |
| 3. Final zip after the public-only edits (README issue URL, SECURITY contact, report path masking, `.bat` CRLF) | At the time of the first version of this table: not built. Built later from a separate stage, see 18.10 | See 18.10 |

### 18.7 First audit (BLOCKED) and how it was answered

The first independent audit passed all 285 tests but blocked the release. Seven points (as handed over in the task description) and their answers:

| Point | Answer |
| --- | --- |
| Stale `dist` files enter the zip (reproduced with `dist/audit-stale.js`) | Fixed: fresh build folder (18.1, 18.4) |
| The token character limit rejects safe values such as `abc.def` and `abc+def=` | Fixed: JSON literal embedding (18.1, 18.4) |
| README conditions on availability and capability were inexact | Corrected from the code (18.2) |
| README wording of verified versus implemented routes | Four statements kept apart (18.2) |
| This section mixed source, development zip and final zip | Separated (18.6) |
| Personal paths remain in the development zip | Recorded (18.6); removal is a public-only edit for the next phase |
| `git diff --check` reported a blank line at the end of this file | Fixed |

### 18.8 Known minor limit (not fixed in this release)

If the compile step of `npm run package` fails, the temporary folder `dist-package/.build-ORNELYON-<version>` can stay behind. It is removed at the start of the next run, it is never copied into a zip, and the failed run leaves existing packages untouched (checked in 18.4). It was left as it is on purpose, to keep this release to the audited changes.

### 18.9 State of the development tree

Uncommitted. The public repository, tags, Releases and published zips were not touched. The public-only edits are not applied in the development tree; they exist in the separate release-candidate stage described next.

### 18.10 Release candidate (built from a separate stage)

The distributable candidate is not built from the development tree. It was built in a private stage outside both repositories: the tracked files of the published v0.4.1 commit were exported (`git archive`, no history), then exactly eleven files were brought over from the development tree: seven unchanged on the public side were copied (`UNINSTALL.md`, `package.json`, `package-lock.json`, `scripts/package.mjs`, `src/interface/server.ts`, `src/test/server.test.ts`, `web/index.html`) and four were merged three-way (`README.md`, `README_ja.md`, `SECURITY.md`, this report) so that the public-only edits stay: the issue URL, the private vulnerability reporting notice, and the masked personal paths of the older sections. Launchers keep CRLF; `start-chimera.*` are kept. After the merge, the stage differs from the published v0.4.1 only in those eleven files, and from the development tree only in those public-only lines.

Three small corrections were made before the build: the README text on a local server's availability now says that no answer, or an answer to `/models` of HTTP 500 or higher, makes it unavailable, while a rejected key, an unknown model or an error on the chat request is found only when the agent runs; section 18.3 no longer says that agent B compared the claims with the file (the saved evidence shows what B received and what B said, not that B opened the file); the token test is named and commented so that restoring the script literal (every token) and HTTP authentication (printable ASCII tokens only) are separate claims.

Checks on the candidate zip itself (structure and CRC, entry list, extraction, CLI and GUI start, 200 and 401, version display, placeholders, old-name ledger over every file name and line including this section, personal-data and secret scan) and the independent audit are kept in a separate audit record, not in this file or in the zip, so that the zip does not have to contain its own hash. The record, not this section, is the authority for the final counts.

What stays unverified is unchanged: any Codex run, the other eight handoff routes, the local LLM routes, macOS, Linux, Node.js 20, and the terms question (NOT CONFIRMED). That agent B opened the file was not proven.

## 19. ORNELYON v0.5.0 Phase 0 (native GUI integration; uncommitted, version still 0.4.2)

Base: 237e4ee (v0.4.2), clean tree. Added `mcp --print-config` Codex TOML block and Claude desktop note, `mcp --self-test` (own module `mcp-selftest.ts`, because `mcp.ts` must not import `child_process`: an existing test caught the first attempt), two tests (288 pass). No new tool, permission, dependency or credential handling. Real-client evidence (scratch config dirs, no model call): Claude Code 2.1.311 `mcp list` Connected via `server/discover` fallback to `initialize` 2025-11-25; Codex 0.162.1 accepted the registration but `mcp list` does not connect. GUI connections (Claude desktop, Codex app/IDE), tool calls inside a model turn, macOS and Linux: NOT_TESTED. Details and v0.6.0+ backlog: docs/NATIVE_GUI_INTEGRATION.md. The version number is unchanged. `scripts/package.mjs` now packages docs/NATIVE_GUI_INTEGRATION.md; the zip was extracted into an empty folder, every relative README link resolved, `mcp --self-test` passed from the extracted copy, and a scan found no logs, temp files, key files, credentials or personal paths (50 files).

### 19.1 Phase 1 (live connection checks, 2026-11-02)

No server or tool change. Added `scripts/codex-mcp-probe.mjs` (developer script, not packaged): asks a Codex binary's app-server which MCP servers a scratch config defines and what they offer; no prompt, no model call. Results: Claude Code CLI 2.1.311 `mcp list` Connected on a real registration (falls back from `server/discover` to `initialize` 2025-11-25); the Codex 0.166.0 engine (the one the Codex app uses) lists all 6 tools, all read-only, and reports a broken path and an instant-exit server as startup failures without disturbing the healthy one; remove and re-add recovered both. The registration was made with a synthetic task in a throw-away data folder, then removed; the original server lists are unchanged (Codex `config.toml` bytes were re-serialised by Codex tooling or the app, no setting lost). BLOCKED: operating the Codex app (permission declined) and the Claude desktop Code tab (own window). NOT_TESTED: GUI display, GUI restart, any tool call inside a model turn. Full table: docs/PHASE1_GUI_VERIFICATION.md.

### 19.2 Phase 1 second run and plan

History: two commits with a user-specific path replaced by one commit of the same tree (force-with-lease on the dev branch only; old objects may persist on GitHub). Re-registration and connection checks repeated with the same results. GUI windows still not operated (BLOCKED); registration left in place for the manual checklist. `docs/DEVELOPMENT_PLAN.md` records the Single-Agent First / Multi-Agent Optional / Native-GUI First policy and the v0.6.0+ order; no feature was implemented. Tests 288/288; zip extraction, links, self-test and personal-data scan clean (51 files).

## 20. ORNELYON v0.6.0 Phase 0 (Single-Agent Core Enhancement; branch feat/v0.6.0-single-agent, version still 0.4.2)

Base: main 0766118. Core: `evidenceGaps` (core/evidence.ts), `passportSaved` (core/passport.ts). Service: `recentTasks` takes an optional filter (agent, execution, verification, decision, taskId, scope predicate applied before the limit), `evidenceFor` reports whether a record exists, `continuationAssessment`. MCP: `ornelyon_recent_tasks`, `ornelyon_evidence` and `ornelyon_passport` extended; no tool added, read-only and scope rules unchanged (the filter argument is named `decision` because the existing guard test forbids arguments named accept). A scope that follows new tasks was reviewed and held (docs/DYNAMIC_SCOPE_DESIGN.md). Tests: 294 pass (6 new). Synthetic data only; no agent was started.

Independent review (a Claude Code subagent, read-only) found 7 issues, none high; all were fixed and covered by a test: `verifiedByOrnelyon` is now false for a rejected task, for any non-PASS or missing check, for an override, and whenever history lines were unreadable (continuation is then at most CAUTION); check names and details and the drift paths follow content mode; the evidence tool gives the scope message for an unknown id; `passportSaved` was renamed `passportFilePresent`; the filter echo uses the input name. Not found: any scope bypass or new write path.

## 21. ORNELYON v0.6.0 Phase 1 (Single-Agent Reliability & Recovery; branch feat/v0.6.0-single-agent, version still 0.4.2)

- **doctor** (`src/interface/doctor.ts`, `ornelyon doctor [--name <entry>]`): reads the clients' own list output (`codex mcp list --json`, `claude mcp get`), never their credential files, keeps no environment values, and prints repair commands without running them. Checks the registered command, entry file, other copies of ORNELYON, scope width, the self-test, history lines, passports and the workspace label. A GUI window is always NOT_TESTED. Exit code 1 on any FAIL.
- **Tasks without a final record**: `ornelyon_recent_tasks` with `incomplete=true` lists tasks with agent-call records and no `summary` (state `NO_FINAL_RECORD`). They are never called interrupted: a run still going looks the same. `minutesSinceLastRecord` is a hint only. They have no passport and no Evidence Gate record, so passport, evidence and handoff preview refuse them. `ornelyon_passport` continuation now carries `resumed: false`: CLEAR/CAUTION/BLOCKED says whether saved data is consistent, not that anything was resumed or would succeed.
- **Workspace label** (`src/core/workspace-id.ts`): HMAC of the real folder path with a per-install key, 16 hex characters, on new summary records only. MCP shows SAME / OTHER / UNKNOWN. A search aid, not a permission (docs/WORKSPACE_IDENTITY.md).
- **Dynamic scope**: re-evaluated with the label available and held again; the label does not discriminate while there is one global workspace (docs/DYNAMIC_SCOPE_DESIGN.md).
- **Output**: a test fixes that each tool answers under 9,000 characters (the 20-row listing under 7,000), gives identical text on repeat, and shows no local path or workspace label.
- **Not verified**: official GUI windows (see docs/PHASE1_GUI_VERIFICATION.md); real agent runs; behaviour on a very large real history beyond the synthetic scans in the tests.

## 22. ORNELYON v0.7.0 Phase 0 (Native Skills & Safe Hooks; branch feat/v0.7.0-native-integration, version still 0.4.2)

Base: main ba03107. Added three Agent Skills (integrations/skills: evidence check, task history, resume preview) that only name the existing read-only MCP tools; `ornelyon skills list|install|remove` (dry run unless --apply, never overwrites or deletes a folder it did not write or that has extra files); an opt-in Claude Code Stop-hook helper (`ornelyon hook stop`, `ornelyon hooks print`) that emits only a user-facing systemMessage, never blocks and keeps no state. No MCP tool was added; scope, content gating and read-only rules are unchanged. Codex hooks and PreToolUse/PostToolUse hooks are held. Tests: 325 pass. Not verified: loading of the skills by Codex or Claude Code, firing of the hook by Claude Code, the `args` field of the hook entry, any Codex skills folder. See docs/NATIVE_SKILLS_AND_HOOKS.md.

### 22.1 Phase 1 (Native Skills Compatibility)

Codex `agents/openai.yaml` (`allow_implicit_invocation: false`, display name = name) added to the three skills. The installer now lists every written file with its sha256, treats a folder as ORNELYON's only when it holds exactly those files, reads the first-build marker as a one-file list, moves a folder aside before verifying and replacing or deleting it, checks parents are plain folders before each delete, never follows links, and reports interrupted-run folders (`.name.tmp-*`, `name.removing-*`) without deleting them. Tests: 327 pass. The Codex 0.162.1 engine lists the skills (no model call, `scripts/codex-skills-probe.mjs`); whether the policy is honoured is NOT_TESTED, and Codex issue 40600 reports it may block explicit use too. Not verified: any GUI window, any model turn, Claude Code loading the skills or firing the hook. See docs/NATIVE_SKILLS_AND_HOOKS.md.
