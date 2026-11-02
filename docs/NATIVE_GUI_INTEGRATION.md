# Native GUI integration (v0.5.0 Phase 0)

Goal: use ORNELYON's read-only features from the official Codex and Claude Code GUIs, without ORNELYON's own WebUI. The WebUI stays an optional tool for setup, administration and diagnosis.

Phase 0 adds **no new server and no new permission**. It reuses the v0.4.x read-only MCP server (`ornelyon mcp`, six tools, stdio) and adds only what is needed to connect and check it.

## What Phase 0 added

| Item | Where |
| --- | --- |
| `ornelyon mcp --print-config` also prints a Codex `config.toml` block and the Claude desktop note | `src/interface/mcp.ts` (`registrationHelp`) |
| `ornelyon mcp --self-test [scope options]`: starts the server as a client would, speaks MCP, prints PASS/FAIL per step | `src/interface/mcp-selftest.ts` |
| Tests for both | `src/test/mcp.test.ts` |

`--self-test` lives in its own module because `mcp.ts` must never import anything that can start a process (an existing test enforces it). The self-test checks: node and entry paths exist, `initialize`, all tools read-only, the tool list equals the build's list, `ornelyon_recent_tasks`, `ornelyon_dispatch_preview` (starts nothing), `ornelyon_status` (timed), that an action tool is refused, and that the data folder is byte-identical afterwards. It makes no model call. It tests this server only, never a GUI.

## How to connect

Registration is always yours; ORNELYON never edits a client's settings. Print the exact commands for your machine (absolute node and `cli.js` paths, correct quoting):

```bash
node dist/interface/cli.js mcp --print-config
node dist/interface/cli.js mcp --self-test
```

Run `npm run build` first. The default scope is `--recent 5` (snapshot at server start). Choose a narrower one with `--allow-task <id>`.

**Codex (app, IDE extension, CLI).** Per the [official docs](https://developers.openai.com/codex/mcp), all three read the same `~/.codex/config.toml`. Either run the printed `codex mcp add ...` or paste the printed `[mcp_servers.ornelyon]` block. Paths are written as TOML literal strings, so Windows backslashes need no escaping. Codex defaults (per the docs): `startup_timeout_sec = 10`, `tool_timeout_sec = 60`.

**Claude Code (CLI and desktop app Code tab).** Run the printed `claude mcp add ornelyon --scope user ...`. Per the [official docs](https://code.claude.com/docs/en/mcp), user-scope servers live in `~/.claude.json`, and the desktop app's Code tab reads that file (and `.mcp.json`). The standalone CLI does not read the desktop *chat* app's `claude_desktop_config.json`; this document does not use that file. A project-scope `.mcp.json` also works (the printed JSON form).

To remove: `claude mcp remove ornelyon`, `codex mcp remove ornelyon`.

## Evidence: verified and not verified

Verified on 2026-11-02 on this machine (Windows 11, Node, Claude Code 2.1.311, Codex CLI 0.162.1). Client config used scratch directories (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) and a scratch `ORNELYON_HOME`, so no real client setting was changed. No model call was made.

| Item | Status |
| --- | --- |
| `npm test`: 288 offline tests (286 existing + 2 new) | PASS |
| `ornelyon mcp --self-test` (initialize 121 ms, status 378 ms) | PASS |
| Official MCP SDK client over a child process (existing test) | PASS |
| `codex mcp add` accepts the registration; `codex mcp get` and `list` show it | PASS (config accepted only; `codex mcp list` does not connect) |
| `claude mcp add --scope user` accepts it; `claude mcp list` health check shows **Connected** | PASS (real Claude Code CLI handshake, no model call) |
| Protocol the real Claude Code sent | It first sent `server/discover` (2026-07-28), got "method not found", then `initialize` with `2025-11-25`. The documented fallback works. |
| Claude desktop app (Code tab) shows and calls the tools | **NOT_TESTED** (Phase 1: BLOCKED, see PHASE1_GUI_VERIFICATION.md) |
| Codex app / IDE extension shows and calls the tools | **NOT_TESTED** (Phase 1: the app's own engine 0.166.0 lists all 6 tools, PASS; the window was not operated) |
| Codex CLI real handshake and tool call | **NOT_TESTED** (needs a model turn, which is a paid call) |
| Claude Code tool call inside a model turn | **NOT_TESTED** (same reason) |
| Codex app version actually in use (may differ from CLI 0.162.1 on PATH) | **NOT_TESTED** |
| macOS, Linux | **NOT_TESTED** |

To check a GUI yourself after registering: open a new session, ask it to list its MCP tools, then call `ornelyon_recent_tasks`. That uses your own subscription; Phase 0 did not do it.

## Current constraints

- Read-only, six tools. No write, no agent start, no handoff, no accept/reject. Unchanged.
- **No per-client authentication.** A stdio server cannot know which program started it. The only access control is the scope given on the command line.
- **Scope is fixed at server start.** `--recent N` is a snapshot; tasks recorded later are invisible until the client restarts the server. In a GUI that means per session or restart, which is easy to forget.
- `--expose-content` returns agent- and user-written text to the client model. That text is data but could contain prompt injection aimed at the receiving model. Keep content off unless needed, and never with `--all-tasks` (refused).
- The server speaks MCP 2024-11-05 to 2025-11-25 only. A client that supports only 2026-07-28 cannot connect. Today's Claude Code falls back; a future GUI might not.
- Registration commands embed absolute paths: moving the folder or running `npm run build` elsewhere breaks them. Re-run `--print-config`.
- `ornelyon_status` runs `<agent> --version` and `auth status` (no model call). If these are slow on another machine they could exceed a client's tool timeout. `--self-test` prints the time.
- No credentials are read, stored or relayed by any of this. Sign-in stays with each official client.

## Backlog for v0.6.0 and later

The current order, based on Single-Agent First, is in [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md); the list below is the earlier, unordered version.

Ordered roughly by value. Each item that adds capability needs its own security review first.

1. Live GUI verification checklist run by a person on the Codex app and the Claude desktop app, recorded as evidence (turns NOT_TESTED into PASS or FAIL).
2. Support for the MCP 2026-07-28 revision (`server/discover`, result types, caching hints), once the exact shapes are checked against the specification.
3. Scope that follows live history instead of a start-time snapshot, without widening access by default. Re-evaluated in v0.6.0 Phase 1 and held: see DYNAMIC_SCOPE_DESIGN.md.
4. (`doctor` done in v0.6.0 Phase 1: `ornelyon doctor [--name <entry>]`; the `--client` filter is not done.) A `--print-config --client codex|claude|json` filter and a `doctor` that also compares a registered entry's paths with the current build (read the client's *own* `mcp get` output, never its credential files).
5. Streamable HTTP transport on loopback with a bearer token, for clients that do not spawn stdio servers. Needs token handling design, Origin checks and no credential relay.
6. Controlled write tools (record accept/reject) and agent execution tools: only with explicit per-call human approval in the client, an audit record, spend limits, and the existing Evidence Gate unchanged. Not started; no design exists yet.
7. Packaging as a Codex plugin or Claude Code plugin/skill so registration is one step, plus guidance telling the model how to treat returned text as data.
8. macOS and Linux verification of registration and self-test.

## Safety issues to settle before items 5 and 6

- Who is the caller? stdio has no identity; HTTP needs one.
- Prompt injection through returned content and through tool results fed back into write tools.
- Spend: a tool that starts an agent can start paid calls from a model's decision. It needs a hard cap outside the model's control.
- Whether automated use under a subscription sign-in is allowed is still NOT CONFIRMED (see README).

## Checking the setup and finding unfinished tasks (v0.6.0 Phase 1)

`ornelyon doctor` now ends with an "ORNELYON MCP / GUI integration" section (`--name <entry>` if you registered under another name). It reads what Codex and Claude Code themselves report (`codex mcp list --json`, `claude mcp get`), never their credential files. It checks that the registered node and entry file exist, whether they are this copy of ORNELYON, how wide the scope is, runs the self-test, and checks history, passports and the workspace label. Every fix is a printed command; nothing is changed. A GUI window is always NOT_TESTED. Exit code 1 means at least one FAIL.

To see tasks that never wrote a final record, call `ornelyon_recent_tasks` with `incomplete: true`. They are shown as `NO_FINAL_RECORD`, not as interrupted, because a run that is still going looks the same. Only tasks already in the server's scope appear; to add one, restart with `--allow-task <id>`.
