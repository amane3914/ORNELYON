# ORNELYON v0.4.2

A small, local harness that lets you run tasks through **OpenAI Codex**, **Claude Code** or a **local OpenAI-compatible LLM** from one setup screen and one command. It is independent of, and not affiliated with, endorsed by or sponsored by, OpenAI, Google, Microsoft or Anthropic. Read [Accounts, billing and provider terms](#accounts-billing-and-provider-terms) before you use a Codex or Claude Code sign-in.

> Status: **Public Preview** (v0.4.2). It is not a stable release, and nothing in it is guaranteed beyond what is described below. 288 offline tests pass (fake adapters, a localhost fake model, hand-built history and the official MCP SDK client, no paid calls). Real Claude Code runs so far: read-only tasks and read-only Claude Code to Claude Code handoffs (v0.3.0, v0.3.1, and one of each again on the v0.4.2 build). **v0.4.0 and v0.4.1 added no real-agent run. v0.4.2 ran two real Claude Code calls (one read-only task and one Claude Code to Claude Code handoff, 2026-11-02) and no real Codex call.** The Efficiency Benchmark has only been checked on hand-built, synthetic and fake-adapter history, so it says nothing yet about real token or cost savings. Real file edits, real failures, any real Codex task (including any handoff with Codex), other operating systems and a live connection from Claude Code or Codex to the MCP server were **not** run (by policy, no paid or metered agent call is used to test v0.4.1 or v0.4.2; these paths are NOT_TESTED, not verified). See [IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md) sections 13 to 17.

## What ORNELYON does

- Runs one task through the agent you choose (Codex CLI, Claude Code CLI, or an OpenAI-compatible local model), from a local GUI or from the command line.
- Records each run in a local history and gives three separate judgements: **Execution** (did the agent finish), **Verification** (what checks show) and **Acceptance** (your decision).
- Checks results only with the checks you choose: files, JSON, trusted commands, a file-scope rule and an optional independent review. With no checks, a successful run is not reported as verified.
- Can save a Task Passport and hand a task to another agent, only when you ask for it.
- Offers an optional read-only MCP server for other tools, a benchmark computed from your own history, and an experimental Research command.

What it does **not** do: it does not sign in for you, does not store API keys or sign-in tokens, does not run a self-improvement loop, does not resume agent sessions, and does not isolate agents in WSL or a container. Extra agent calls (Smart Dispatch reviews) are off by default.

## What you need

- **Node.js 20 or newer** (https://nodejs.org). Nothing else is installed globally, and no administrator rights are needed. The version verified so far is Node.js 24 on Windows.
- Optional, per agent you want to use:
  - Codex: the Codex CLI published by OpenAI, installed by you, then `codex login`.
  - Claude Code: the Claude Code CLI published by Anthropic, installed by you, then `claude auth login`.
  - Local LLM: any OpenAI-compatible server (for example Ollama, LM Studio, llama.cpp server).

## Public Preview: what has been verified

This is the first public preview. The table says what was checked and what was not. "NOT_TESTED" means it was not run, not that it works.

| Item | Status |
| --- | --- |
| Windows 11 with Node.js 24: `npm test` (288 offline tests), build, packaging, launch | Verified by the maintainer on a local machine |
| Node.js 20, macOS, Linux | **Not verified on real machines.** A CI workflow (`.github/workflows/ci.yml`) is in the repository; it has not been run yet |
| Real Claude Code runs | Read-only tasks and read-only Claude Code to Claude Code handoffs: v0.3.0 and v0.3.1, and one of each again on the v0.4.2 build (2026-11-02, Claude Code 2.1.311, subscription sign-in, 2 calls, both succeeded). **No real-agent run for v0.4.0 or v0.4.1** |
| Real Codex task | NOT_TESTED (not run in v0.4.2 either; an earlier check on the maintainer's Windows machine was BLOCKED by the Codex sandbox setup) |
| Handoff routes (nine, see [Handoff routes](#handoff-routes-implemented-is-not-verified)) | All nine are implemented as read-only handoffs. Only Claude Code to Claude Code was run with a real agent. The other eight are NOT_TESTED |
| Real file edits and real failures | NOT_TESTED |
| MCP server connection from Claude Code CLI 2.1.311 and the Codex 0.166.0 engine (handshake and tool list, no model call) | Verified 2026-11-02 (see [docs/PHASE1_GUI_VERIFICATION.md](docs/PHASE1_GUI_VERIFICATION.md)) |
| MCP tools shown or called in the Codex app window or the Claude desktop Code tab; any tool call inside a model turn | NOT_TESTED (GUI operation was not available; a model turn was not allowed) |
| Efficiency Benchmark: real token or cost savings | **Not shown.** Checked only on synthetic and hand-built history |
| Whether automated use under a subscription sign-in is allowed | **NOT CONFIRMED.** See [Accounts, billing and provider terms](#accounts-billing-and-provider-terms) |
| Gemini CLI | **Not implemented, not supported** |

Results from the tests use fake agents and a local fake model. They show that the code behaves as its tests describe, not how a real agent behaves.

## Accounts, billing and provider terms

Read this before you run ORNELYON with a Codex or Claude Code sign-in. Last checked against the providers' public pages on 2026-11-01. This is a technical description, not legal advice, and a disclaimer in this file does not change any provider's terms.

- **Independent project.** ORNELYON is not affiliated with, endorsed by or sponsored by OpenAI, Anthropic, Google or Microsoft. Their product names are used only to say which tools ORNELYON can work with. "ORNELYON" is this project's own name, not the name of any provider's product.
- **How the CLIs are used.** ORNELYON starts the Codex CLI and the Claude Code CLI that **you** installed, unmodified, as ordinary child processes in their non-interactive modes (`codex exec`, `claude -p`). It does not read, copy, store, relay or send their login tokens or credential files, offers no sign-in of its own, and does not call OpenAI or Anthropic web APIs itself. Signing in stays with each CLI. The local-LLM adapter calls the OpenAI-compatible URL you configure; if you point it at a hosted service, that service's terms and billing apply to you.
- **Billing can differ from what you expect.** Each CLI decides how a call is authenticated and charged: a subscription sign-in, an API key saved by the CLI, or an API-key environment variable. ORNELYON passes its own environment to the CLI unchanged and never chooses or switches the method, so a key that is present in your environment (for example one named in a provider's documentation) can make a run metered even though you are also signed in with a subscription. Check the CLI's login status (`codex login status`, `claude auth status`) and your environment, and read the provider's billing documentation, before you run. ORNELYON shows a cost only when the agent reports one.
- **Terms status: NOT CONFIRMED.** A CLI's own non-interactive mode is one question; whether a third-party tool such as ORNELYON may drive it under a **subscription sign-in** is another. ORNELYON does not claim that it is allowed, and does not claim that it is prohibited. These two paths are unconfirmed:
  - Anthropic: `claude -p` driven by ORNELYON with a Claude subscription sign-in.
  - OpenAI: `codex exec` driven by ORNELYON with a ChatGPT sign-in.

  Until you have checked the current terms yourself (or asked the provider), treat these paths as your own risk. The providers' documents recommend API-key authentication for automated or programmatic use; check that too. Multi-agent features (review, fallback, handoff) can make more calls through the same sign-ins, within the limits you set.
- **Terms to read.**
  - Anthropic: [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [Claude Code headless mode](https://code.claude.com/docs/en/headless).
  - OpenAI: [Terms of Use](https://openai.com/policies/terms-of-use/) (users outside the EEA, Switzerland and the UK), [Terms of Use for the EEA, Switzerland and the UK](https://openai.com/policies/eu-terms-of-use/), and the business terms linked from those pages for API and enterprise use; [Codex authentication](https://developers.openai.com/codex/auth).
- **Gemini CLI: not implemented, not supported.** This version has no Gemini CLI adapter and no code path that starts it, so it cannot be a routing or fallback target. Policy: ORNELYON will not support automated runs of Gemini CLI through a Google-account subscription or OAuth sign-in, and will not obtain, reuse or relay its OAuth credentials. Any future support depends on checking which authentication methods and conditions Google allows. The Gemini API and Vertex AI are separate routes: they are not implemented, and if they ever are, they will need explicit enabling and consent to billing.

## Quick start

1. Unzip the package.
2. Windows: double-click **`start-ornelyon.bat`**. macOS/Linux: open a terminal in the unzipped folder and run **`sh start-ornelyon.sh`**. (The ZIP does not keep the executable bit, so `./start-ornelyon.sh` will not run until you `chmod +x` it. The macOS/Linux launcher has not been tested on a real machine.)
3. Open the link printed in the terminal (it contains a session token and is valid only while ORNELYON runs).
4. On **Setup**, choose a preset, pick your main AI, check the requirements, then **Complete setup**.
5. Open **Task**, write a prompt, and press **Run**.

Keep the terminal window open while you use the GUI. Press Ctrl+C in it to stop.

### Command line

```bash
node dist/interface/cli.js doctor
node dist/interface/cli.js run "Summarize the files in this folder" --agent local
node dist/interface/cli.js history
node dist/interface/cli.js cost
node dist/interface/cli.js tool WebFetch DORMANT
```

## Install presets

| Preset | What it turns on |
| --- | --- |
| Lite | One agent. Multi-AI hidden and not loaded. |
| Standard | Multi-AI with manual switching and mutual review, failure-loop guard, history, cost view. |
| Research | Standard plus automatic routing, and the experimental Research command below. There is no automatic self-improvement loop in v0.1. |

### Research (experimental)

Available only with the Research preset, and only when you run it:

```bash
node dist/interface/cli.js research run "What is 2 + 2? Reply with only the number." --agent local --expect "^4$" --samples 1
node dist/interface/cli.js research list
node dist/interface/cli.js research show <id>
node dist/interface/cli.js research apply <id> --yes
```

It tries a few prompt prefixes against your task and checks each answer with the `--expect` pattern. A prefix is kept as a **pending** candidate only if it beats the unchanged baseline. Applying a candidate changes only that agent's `promptPrefix`. Sandbox, loop guard, budgets, tools and keys are never changed. With fewer than three samples per variant, the candidate is marked low evidence. Research starts only an **enabled** agent and obeys `maxCalls` like a normal task: each variant needs `--samples` calls, so the default three variants with `--samples 1` need three calls, and a plan that needs more than `maxCalls` is refused before anything runs. Its calls are recorded in history with their origin.

A preset only sets starting values. Everything can be changed later on the Setup or Agents page.

## Collaboration levels

| Level | Meaning |
| --- | --- |
| L0 | Single agent. |
| L1 | Manual switch: you choose the agent. No automatic switching. |
| L2 | Mutual review: a different enabled agent checks the main answer. |
| L3 | Rule-based routing: agents declare capabilities, priority and a daily budget; the first matching available agent runs, with fallback on failure. |
| L4 | Cooperative execution: **not implemented** in v0.1. |

Hard limits for every task: maximum agent calls (`maxCalls`, default 3, including retries and reviews), maximum nesting depth, per-agent timeout, and per-agent daily budget when the agent reports cost.

## Safety defaults

- The GUI listens on **127.0.0.1 only**, rejects foreign `Host` headers, and requires a per-launch token on every API call.
- Codex runs with a **read-only sandbox** by default. Claude Code runs in **plan mode** for read-only tasks and never with a permission-bypass flag.
- Agents may only work inside the **workspace folder** you configure. Paths that escape it (including through symlinks) are refused.
- **API keys are never stored in the config.** Local LLM stores only the name of an environment variable.
- Logs and history are redacted for common key formats and for the values of the environment variables you name.
- Config saves are atomic and keep the previous version as `config.json.bak`. A corrupt config is restored from that backup, and the broken file is kept as `config.json.corrupt`.

## Known limits

- **Public Preview.** Interfaces, file formats and defaults may change before a stable release. Read [Public Preview: what has been verified](#public-preview-what-has-been-verified) first.
- **Platforms:** only Windows with Node.js 24 has been run. macOS, Linux and Node.js 20 are not verified.
- **Real agents:** v0.4.0 and v0.4.1 added no real-agent check. On the v0.4.2 build (2026-11-02, Claude Code subscription sign-in), one read-only Claude Code task and one read-only Claude Code to Claude Code handoff succeeded: the hash of the handoff context matched what was sent, and the receiving agent's answer agreed with the file's content. No record shows that the receiving agent opened the file, so that is not proven. A handoff that involves Codex, a handoff to or from a local LLM, real Codex work, real edits, real failures and MCP connections from a client are NOT_TESTED. Whether automated use under a subscription sign-in is allowed is NOT CONFIRMED.
- **Gemini CLI** is not implemented and is not supported through a Google-account sign-in.
- **Cost:** shown only when an agent reports it. Anything else is shown as "unknown". ORNELYON never estimates prices.
- **Failure-loop guard** works between attempts (retries and fallbacks). It cannot intervene inside a running Codex or Claude session.
- **Tool dormancy:** removes tools from requests to the local LLM and passes them to Claude Code as disallowed. Codex CLI has no per-tool switch, so dormancy does not apply to it. Tools are changed only by you.
- **Sub-agents** are off by default (`allowSubagents`). Codex runs with its `multi_agent` features disabled. Claude Code is told to deny its sub-agent tools by name (`Task`, `Agent`). The exact tool name is not verified for every Claude Code version.
- **Claude `workspace-write`** uses `acceptEdits`. Edits are accepted automatically. Shell actions that would need approval are refused, because headless mode cannot ask.
- **Session continuation** is not implemented. Every task starts a new, ephemeral agent session.
- No automatic self-improvement, no benchmarking, no WSL/container isolation in v0.1.

### Several installs of the same CLI

If `doctor` reports a broken agent, or you have both a standalone and an npm install, set the absolute path in **Agents → Executable path**. ORNELYON then runs that exact file.

## What is new in v0.2

v0.2 adds checks around agent work. The CLI does all of it. The GUI shows the same results and can record accept or reject. Nothing requires the GUI.

**Three separate judgements per task** (shown by `run`, `history`, `verdict` and the Runs screen):

| Field | Values | Meaning |
| --- | --- | --- |
| Execution | SUCCESS, FAILED, BLOCKED, CANCELLED, UNKNOWN | Did the agent process finish with a usable answer. This is not a judgement of correctness. |
| Verification | PASS, FAIL, UNVERIFIED, NOT_RUN | What checkable evidence shows. A process exit code 0 is never a PASS by itself. |
| Acceptance | PENDING, ACCEPTED, REJECTED, NOT_REQUIRED | Only your decision sets ACCEPTED or REJECTED. An agent saying "tests pass" does not. |

Checks are chosen per task:

```bash
ornelyon run "Add a retry to the upload code" --sandbox workspace-write --allow-write \
  --allow-files src/upload.ts,test/upload.test.ts \
  --verify-file src/upload.ts --verify-json package.json \
  --verify-command unit-tests --require-review
```

- `--allow-files` is checked **after** the run from workspace snapshots (workspace-write runs, and read-only runs when this option is given). It detects changes outside the list; it does not block them.
- `--verify-file path[:sha256]` checks that the file exists and, with a hash, matches what was reviewed.
- `--verify-json path` checks that the file parses.
- `--verify-command name` runs a command you registered in `config.json` (see below). Agents cannot add commands.
- `--require-review` asks another enabled agent for an independent review. Its `VERDICT: OK` is recorded as a check. It is evidence of an AI judgement, not proof.

**Accepting.** `ornelyon accept <task-id> --reason "..."`. Acceptance is refused when execution did not succeed, when verification failed, or when a required check is missing. Add `--override` with a reason to accept anyway; the override is recorded. Accepting records a decision about the result. It does not apply or approve changes that are already on disk.

**Dry run.** `ornelyon run "..." --dry-run` shows the dispatch plan and the checks that would run. It starts no agent and does not probe availability.

**Trusted verification commands** live in `config.json`:

```json
"verification": {
  "allowCommands": true,
  "commands": {
    "unit-tests": { "command": "C:\\Program Files\\nodejs\\node.exe", "args": ["test.js"], "timeoutSec": 300 }
  }
}
```

Commands must use an absolute path, run without a shell, and run only when a task names them. `allowCommands` is off by default.

**Smart Dispatch** (off by default). With `multiAi.smartDispatch.enabled` on, a finished answer in a critical kind (`criticalKinds`, for example `security`) gets one independent review by another enabled agent. An identical review that already passed is reused. The same repeated failure stops with a suggestion to change method. Explicit `--require-review` works even when Smart Dispatch is off. Reviews count toward `maxCalls` and the daily budget. There are no hidden calls.

**Task Passport and handoff.** `ornelyon passport save <task-id>` stores a summary of the task's state under `data/passports/`: objective (first line only), statuses, changed files with hashes, open issues, next step and the workspace git commit when there is one. Passports are sealed with an integrity hash; edited or truncated ones are refused. `ornelyon handoff <task-id> --to <agent>` starts a new read-only task on another agent from that passport. It runs only when you ask. If files changed since the passport was saved, it stops and lists them unless you add `--accept-current-state`. It also refuses, before any agent starts, when the target agent is disabled or not available, does not declare the task's capability, has no budget left, or when the chain would exceed `multiAi.maxHandoffs`. A handoff always runs the agent you named, with no routing or fallback.

**Two separate limits (v0.3).** `multiAi.maxDepth` limits *nested* agent calls (an agent calling another agent inside one task; for example a review inside a run). `multiAi.maxHandoffs` limits *sequential* manual handoffs in one chain of tasks (default 2). They do not affect each other. The handoff count is read from history, not from the passport, so saving the passport again cannot reset it. If the history cannot prove the count (an earlier task is missing, or the lineage loops), the handoff is refused, because an unknown count is never treated as zero. A config written before v0.3 has no `maxHandoffs`; it then starts from its old `maxDepth` value, which is never more permissive than v0.2.1.

**Limits in v0.2:**
- Verification is only as strong as the checks you choose. With no checks, a successful run is `UNVERIFIED` or `NOT_RUN`, not `PASS`.
- Workspace snapshots cover the whole workspace, not only the working folder: up to 20,000 files, each up to 256 MiB. Links and junctions are recorded but never followed. Skipped folders (`node_modules`, `.git`, `.serena`, `data`, `dist`, `dist-package`), files that are too large, unreadable entries and the file limit are reported as gaps. With any gap the scope check is `UNVERIFIED`, never `PASS`, so a workspace that contains `.git` or `node_modules` cannot get a scope `PASS`. A read-only setting is not taken as proof that nothing changed: a scope rule makes ORNELYON measure read-only runs too.
- Allowed files are detected after the run, not prevented.
- The order of verification is fixed. Every verification command runs once and is waited for. Then the final workspace snapshot is taken, and the scope rule compares it with the baseline taken before the agent ran. Then the file, hash and JSON checks read the same final state. A file that changed after the snapshot gives an UNVERIFIED result, and a failed final snapshot makes the file, hash and JSON checks UNVERIFIED too. A command that fails or cannot start is measured the same way.
- What the snapshots show, and what they do not. They compare the defined workspace between observation points. They do not prevent writes. They give no guarantee against writes outside the workspace, against a change that is fully undone before the next snapshot, or against a separate process that keeps writing after the final check. A change inside the workspace that a snapshot sees is reported; whether it was intended is not judged.
- A verification command is only as independent as its script. If the agent can edit the script (for example because it sits inside the allowed files), a PASS from that command is not independent evidence, and ORNELYON cannot tell whether the script was edited to pass. Keep verification scripts outside the agent's allowed files, and review any change to them yourself.
- Session resume inside Codex or Claude Code is not used. Handoff starts a new run with a summary.
- Automatic handoff is not implemented.

## Handoff routes: implemented is not verified

A handoff is started only by you (`ornelyon handoff`, or the GUI button with its confirmation). **Automatic handoff is not implemented.** The code accepts any of the three agents as the source and as the target, so all nine routes below exist. Four things are kept apart here, because they are not the same:

1. **Implemented in the code:** all nine routes, read-only.
2. **Offline tests (fake agents and a localhost fake model, no paid call):** representative routes only. The tests start handoffs whose target is Codex, Claude Code or the local model, and test each target's refusal conditions. They do **not** run each of the nine source and target pairs end to end.
3. **Verified with a real agent:** Claude Code to Claude Code only (below).
4. **Not verified:** the other eight routes, every handoff that involves Codex, every handoff between different agents, every handoff that involves a local LLM, and any handoff that edits files.

| From | To | Kind | In the code | Verified with a real agent |
| --- | --- | --- | --- | --- |
| Claude Code | Claude Code | same agent | Read-only | **Succeeded**: v0.3.0 and v0.3.1, and again on the v0.4.2 build (2026-11-02) |
| Claude Code | Codex | different agents | Read-only | NOT_TESTED |
| Claude Code | Local LLM | different agents | Read-only | NOT_TESTED |
| Codex | Claude Code | different agents | Read-only | NOT_TESTED |
| Codex | Codex | same agent | Read-only | NOT_TESTED |
| Codex | Local LLM | different agents | Read-only | NOT_TESTED |
| Local LLM | Claude Code | different agents | Read-only | NOT_TESTED |
| Local LLM | Codex | different agents | Read-only | NOT_TESTED |
| Local LLM | Local LLM | same agent | Read-only | NOT_TESTED |

- **What the real runs were.** Read-only tasks on a small scratch file in an isolated folder, with a Claude Code subscription sign-in and no API key (see [IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md) sections 13, 15 and 18). v0.3.0 and v0.3.1 ran them; v0.4.0 and v0.4.1 did not repeat them; v0.4.2 repeated one task and one handoff (2 calls, both succeeded) and **made no Codex call**. The next agent's answer is not taken as proof by itself: the evidence is ORNELYON's file hash check and the hash of the text that was sent.
- **Handoffs are read-only.** The target always runs in read-only mode. A handoff that edits files is **not supported**. This is separate from ordinary tasks (`ornelyon run`), which can edit files in the workspace depending on the sandbox you choose.
- **Same agent and different agents use the same checks.** The code does not treat them differently. Different agents have only been tried with fake agents.
- **Checked before any agent starts** (any failure stops the handoff, and nothing is started):
  - The target is **enabled** in the agent settings.
  - The target is **available** when the check is made (a recent check may be reused). For Codex CLI and Claude Code CLI this means the program is found and its version command runs, and its login-status command reports a signed-in state. For the **local LLM** it means only that the configured URL answers `GET /models` with anything below HTTP 500. A local server that needs **no API key** is available; no key is required unless you configured `apiKeyEnv`. A server that does not answer, or answers `/models` with HTTP 500 or higher, makes it unavailable. A rejected API key (for example HTTP 401), an unknown model name, or an error on the later chat request is **not** found by this check.
  - The **capability check**, only when the passport records a task kind (for example `--kind code`): the target must list that kind in its capabilities. A passport with **no recorded kind** (a task started without `--kind`, or a passport saved before v0.2.1) skips this check.
  - The handoff count must be provable from history and stay within `multiAi.maxHandoffs`.
  - The target's daily budget must not be spent (when you set one).
  - Files must not have changed since the passport was saved, unless you add `--accept-current-state`.
- **Only found out when the agent runs:** a sign-in that expires after the check, a rejected local API key, a missing model, a server error on the chat request, a timeout, the agent CLI's own errors, and sandbox problems (an earlier check of Codex on the maintainer's Windows machine was blocked this way). Such a run is recorded as failed, never as a successful handoff.
- **Subscription sign-ins.** Whether ORNELYON may drive the Codex CLI or Claude Code CLI automatically under a subscription sign-in is **NOT CONFIRMED** (see [Accounts, billing and provider terms](#accounts-billing-and-provider-terms)). Having run it once does not change that.
- **Gemini CLI is not implemented** and is not a source or target.

## What a handoff carries (v0.3.1)

A handoff sends the next agent a **Handoff Context**, built by ORNELYON from history and the passport. No model is called to build it. It has nine parts: original objective, current objective, previous agent, previous agent report, verified evidence, unresolved issues, next actions, constraints and your instruction.

- **The report is a claim, not proof.** It is shown inside a frame marked as untrusted data, every line prefixed so it cannot imitate a heading or close the frame. Permissions, sandbox, budget and limits always come from your configuration, never from text in the report or in the instruction.
- **What ORNELYON removes is stated.** Paths inside the workspace become `./relative`, paths outside it and secret-like values are replaced, and since v0.4.1 **e-mail addresses are replaced by `[email-removed]`**. The context lists how many of each, so a marker is never mistaken for what the previous agent wrote. The user's own instruction is not path-rewritten or e-mail-masked (you chose it), but secrets in it are redacted.
- **Evidence is separate.** ORNELYON's own check results of the previous task are listed apart, with the file hash at the time the passport was saved next to the hash now. The previous task's Verification PASS is **not** inherited: the new task starts at NOT_RUN and only checks on the new task change it.
- **The original objective is kept** through A to B to C. The line "Handoff from task ..." is no longer used as an objective.
- **Gaps are stated, not filled.** A passport saved before v0.3.1 has no report copy, so the report is read from history and the context says so. A missing report, a report that disagrees with history, or a missing hash is named in the context and in a warning.
- **Size is bounded.** `multiAi.handoffContextMaxChars` (default 6000, 1000 to 20000). A long report is cut and the cut is stated; if the required parts leave no room for the report, the handoff is refused before any agent starts.
- **What was sent is recorded**: the task record holds the exact text, and the summary record holds its length, sha256, source record, instruction and any cut or missing parts.

```bash
node dist/interface/cli.js handoff <task-id> --to claude --preview --instruction "Compare the report with the file"   # shows the exact text, starts nothing
node dist/interface/cli.js handoff <task-id> --to claude --instruction "Compare the report with the file"            # runs it
```

API: `POST /api/handoffs/preview` (same fields as `/api/handoffs` without `confirm`; starts nothing) and `instruction` (at most 1000 characters) on `POST /api/handoffs`.

## MCP Server Lite (v0.4, optional, read-only; scope added in v0.4.1)

`ornelyon mcp` lets another MCP-capable tool (Claude Code, Codex, an editor) ask ORNELYON questions over **stdio**. It is a separate entry point: nothing else needs it, and ORNELYON works the same with it unused. It adds no runtime dependency.

| Tool | Answers |
| --- | --- |
| `ornelyon_status` | Which agents are enabled, installed and signed in; main settings and limits |
| `ornelyon_recent_tasks` | Tasks **in scope** with agent, kind, Execution / Verification / Acceptance (no prompts or outputs) |
| `ornelyon_dispatch_preview` | What Smart Dispatch would decide (same function as `run --dry-run` and `POST /api/dispatch/plan`) |
| `ornelyon_evidence` | Evidence Gate result of one task in scope, check by check |
| `ornelyon_passport` | Saved Task Passport of one task in scope and what a handoff to each agent would do |
| `ornelyon_handoff_preview` | Size, hash, report state and file states of the handoff context. The text only in content mode |

**What it cannot do:** start an agent, run a handoff, record accept or reject, or change settings, history or passports. No such tool exists, no tool accepts a path, command, setting or confirmation, and extra arguments are refused. It is not a way around the Codex sandbox.

**Who can see what (v0.4.1).** A program that starts a stdio server cannot be identified or authenticated, so the only access control is the **scope the operator fixes when the server starts**. The tool annotations (`readOnlyHint` and so on) are hints for the client; they are not what protects data.

| Option | Effect |
| --- | --- |
| (none) | No task is visible. `ornelyon_status` and `ornelyon_dispatch_preview` still work. |
| `--recent N` | The N newest tasks **at the moment the server starts** (1 to 20). Later tasks stay hidden until a restart. |
| `--allow-task <id>` | Exactly these tasks (repeatable). |
| `--all-tasks` | Every task in the history. Never together with `--expose-content`. |
| `--expose-content` | Adds objectives, reports, next steps, acceptance reasons and the handoff text, **only for tasks in scope**. |
| `--tools a,b` | Offers only the named tools. |

A task outside the scope gets the same answer as a task that does not exist. Task ids must be exact UUIDs; anything else is refused before any file is touched. A damaged passport gives a tool error. Unreadable lines in the history file are skipped, and the four tools that read the history (`ornelyon_recent_tasks`, `ornelyon_evidence`, `ornelyon_passport`, `ornelyon_handoff_preview`) then add `historyComplete: false`, `skippedHistoryLines` and a warning to their answer: treat such an answer as possibly missing records. The server reads the configuration without writing anything, so a damaged `config.json` is not copied or backed up by a question.

**Cleaning.** Everything returned passes the same cleaner a handoff uses: workspace paths become `./relative`, paths outside the workspace and secret-like values and **e-mail addresses** are replaced (e-mail by `[email-removed]`), long strings are cut. Report text is labelled as data written by an agent. Pattern matching cannot prove that nothing sensitive is left; keep the scope narrow.

**Registering** is up to you. ORNELYON never edits a client's settings:

```bash
node dist/interface/cli.js mcp --print-config                      # prints the claude / codex / mcp.json forms (default scope: --recent 5)
node dist/interface/cli.js mcp --print-config --allow-task <id>    # a chosen task
```

**Native GUI use (v0.5.0 Phase 0).** `--print-config` also prints a Codex `config.toml` block (shared by the Codex app, IDE extension and CLI) and the Claude desktop Code tab note. `node dist/interface/cli.js mcp --self-test` starts the server as a client would and reports PASS/FAIL, with no model call. A live connection from a GUI is still NOT_TESTED. Steps, evidence and limits: [docs/NATIVE_GUI_INTEGRATION.md](docs/NATIVE_GUI_INTEGRATION.md).

**Protocol.** Speaks the MCP versions 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05 over stdio (its own handler, checked against the official TypeScript SDK client). It does **not** implement the 2026-07-28 revision (no `server/discover`; that revision removed `initialize`). A client that speaks both eras falls back to `initialize` when `server/discover` is answered with "method not found", which this server does; a client that speaks only 2026-07-28 cannot use it.

**Moving from v0.4.0:** a registration made with v0.4.0 had no scope, so with v0.4.1 it sees **no task**. Register again with `--recent N` or `--allow-task`. Content mode that you used before now also needs a scope and refuses `--all-tasks`.

Every tool definition is added to the calling agent's context (six short definitions, about 850 tokens). Calling a tool starts no model.

## Efficiency Benchmark (v0.4)

`ornelyon benchmark` measures from your **history**; it calls no agent and writes nothing.

```bash
node dist/interface/cli.js benchmark --by shape        # single / multi (review or fallback added) / handoff
node dist/interface/cli.js benchmark --by agent --kind code --hours 168
node dist/interface/cli.js benchmark compare --a "shape=single" --b "shape=multi"
node dist/interface/cli.js benchmark synth --out synthetic.jsonl   # SYNTHETIC data to test the measuring code
node dist/interface/cli.js benchmark --history synthetic.jsonl --by shape
```

- **Per user task:** calls (and extra calls), Execution / Verification / Acceptance, agent time, tokens, reported cost, cost per successful task, cost of the extra calls.
- **Reported, not guessed:** tokens and cost are what each agent reported. A task with any unreported call is unknown for that figure and is left out of the average; the report shows how many tasks were counted and how many were not. Providers count tokens differently, so the report warns when agents differ.
- **No double counting:** only agent calls count; summary and decision records are not calls, and a call record repeated in the file is skipped and reported.
- **Comparison states what differs.** Tasks in history were not chosen to be alike. `compare` lists differences in kind, final agents, overlap and group size, pairs requests whose first prompt is identical, and says "NOT a like-for-like comparison" unless the groups match. Even then it is observational, not a controlled test.
- **Fake data is labelled.** Calls from fake, test or synthetic agents are counted and flagged; their numbers test the measuring code only.
- **Where a call came from (v0.4.1).** ORNELYON writes an `origin` on each call record from the adapter it built: `cli` (Codex / Claude Code command) and `local-endpoint` count as real; `fake-adapter` and `test-command` (a real adapter pointed at a test command) do not. Records without an origin (all history before v0.4.1) are **unknown**: never counted as real and never called fake. A comparison is called like-for-like only when every task has a recorded real origin, and the report lists the conditions that differ (kinds, final agents, shapes, overlap, size, origin).
- **Reproducible:** the same history gives the same output and the same `data sha256`.

A real comparison of one agent against ORNELYON-routed work needs the same requests run both ways with real agents. That is deliberately left for a separately approved run.

## The GUI in v0.3 (optional)

Everything below also works from the CLI and the HTTP API. The GUI only shows the same results.

- **Agents → Smart Dispatch**: switch it on or off, set the critical kinds, and preview a decision (routing policy, selected agent, decision, reasons, whether an extra agent call would be needed). The preview starts nothing. The decision itself comes from the same core rules as `run --dry-run`.
- **Runs → Passport**: expand a task to see its original and current objective, agent, state, verification checks, open issues, next step and handoff history, with the previous agent report in a collapsed section. v0.3.1 adds an instruction box and **Preview what will be sent**. If no passport is saved, there is a **Save passport** button.
- **Manual handoff** (in the same panel): pick the target (the first allowed one is preselected, with the reason shown for each refused one), tick the confirmation, and press **Hand off now**. Nothing starts without the confirmation. The server refuses a handoff request that lacks `"confirm": true`.

API: `POST /api/handoffs` (`fromGroupId`, `to`, `confirm: true`, optional `acceptCurrentState`, `timeoutSec`), `GET /api/passports/<id>` (includes the handoff overview), `POST /api/dispatch/plan`.

### Running without the GUI

```bash
node dist/interface/cli.js run "..." --agent claude      # one task
node dist/interface/cli.js passport save <task-id>
node dist/interface/cli.js passport show <task-id>       # shows the handoff count and the limit
node dist/interface/cli.js handoff <task-id> --to codex  # manual handoff
node dist/interface/cli.js run "..." --dry-run           # shows the dispatch plan, starts nothing
```

## Names and compatibility

ORNELYON is the name of this project; it is not the name of any provider's product. "CHIMERA Harness" and "NEXORA Harness" are earlier names.

- Existing `config.json` and `history.jsonl` files load unchanged. v0.2 fields are optional and default to off.
- `CHIMERA_HOME` is still honoured. `ORNELYON_HOME` is the new name for the same setting.
- `start-chimera.bat` and `start-chimera.sh` still work. They start ORNELYON.
- The `chimera` command is an alias of `ornelyon`.

## Optional components (not installed by ORNELYON)

- **Microsoft TokenEconomizer** (Claude Code and Codex plugin, https://github.com/microsoft/TokenEconomizer). ORNELYON only reads the agent settings for the plugin name and shows its state and the agent version in **Setup**. ORNELYON never installs or changes it. The plugin runs inside each agent session; ORNELYON's own loop guard and tool dormancy work between tasks and are separate. The upstream wiki's supported versions are a secondary source. Check them yourself.
- **Google Harness²** (https://github.com/google-research/harness2). Requires Linux, Python 3.12 and uv. ORNELYON shows whether these exist. It does not run Harness² yet. The Research command is ORNELYON's own small experiment, not Harness².

## Development

```bash
npm install
npm test          # build + offline tests (no paid API calls)
npm run package   # build dist-package/ORNELYON-0.4.2.zip
```

Runtime dependencies: none. Dev dependencies: TypeScript, Node type definitions and the official MCP TypeScript SDK (used by one test as a protocol client; the zip does not need it, so `npm ci --omit=dev` is enough for an install).

## Documents

- [README_ja.md](README_ja.md): 日本語版の説明
- [ARCHITECTURE.md](ARCHITECTURE.md): layers, data files, adapter contract
- [IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md): what was built, what was verified, what was not
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): licenses and reference projects
- [UNINSTALL.md](UNINSTALL.md): how to remove ORNELYON
- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute, fork and redistribute
- [SECURITY.md](SECURITY.md): how to report a security problem

## Uninstall

ORNELYON installs nothing globally and registers no services. Stop it with Ctrl+C, then delete the folder you unzipped. The settings and history are in its `data` folder, so copy that folder first if you want to keep them. ORNELYON never stores API keys or sign-in tokens; to sign out of the official tools, use `codex logout` or `claude auth logout`. Details are in [UNINSTALL.md](UNINSTALL.md).

## Reporting a problem

Open an issue at https://github.com/amane3914/ORNELYON/issues. Please include:

- the version (`ORNELYON-0.4.2`), your operating system and your Node.js version (`node --version`);
- the command or GUI step you ran, and what you expected;
- the output of `node dist/interface/cli.js doctor`, with any paths or account details you do not want public removed;
- the task id and the relevant part of `verdict <task-id>`, if the problem is about a result.

Do **not** post API keys, sign-in tokens, `config.json` with secrets, or history files that contain private prompts or code. If you think a problem is a security issue, read [SECURITY.md](SECURITY.md) and do not post it as a public issue.

## Contributing

Forks, modifications and redistribution are welcome under the MIT license. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
