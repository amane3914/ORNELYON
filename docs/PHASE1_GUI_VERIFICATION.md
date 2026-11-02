# Phase 1 plan: live GUI verification of the ORNELYON MCP server

Status: **prepared, not run.** Nothing here has been done against a GUI. Every step below that changes a real client setting needs the owner's approval first. Steps marked PAID start a model turn on the owner's own sign-in and also need approval.

Background and Phase 0 evidence: [NATIVE_GUI_INTEGRATION.md](NATIVE_GUI_INTEGRATION.md).

## 0. Before starting

1. `npm run build`, then `node dist/interface/cli.js mcp --self-test` must print `SELF-TEST PASS`.
2. Pick a scope. Recommended for the check: one named, throw-away task (`--allow-task <id>`), content off. Do not use `--all-tasks` or `--expose-content`.
3. Run `node dist/interface/cli.js mcp --print-config --allow-task <id>` and keep the output.
4. Record client versions first (`codex --version`; Codex app version from its About screen; `claude --version`; Claude desktop app version). The Codex app may differ from the CLI on PATH.

## 1. Install and remove (all clients)

| Client | Install (changes the real setting) | Remove |
| --- | --- | --- |
| Codex app, IDE extension, CLI | `codex mcp add ornelyon ...` or paste the `[mcp_servers.ornelyon]` block into `~/.codex/config.toml` | `codex mcp remove ornelyon` |
| Claude Code CLI and desktop Code tab | `claude mcp add ornelyon --scope user ...` | `claude mcp remove ornelyon --scope user` |

Remove after the check unless the owner wants to keep it. Confirm removal with `codex mcp list` and `claude mcp list`. The WebUI (`ornelyon gui`) is never needed: the MCP server is its own process started by the client, and it opens no port.

## 2. Checks per GUI (record PASS / FAIL / NOT_RUN for each)

Codex app (and IDE extension if used), Claude desktop app Code tab:

| # | Check | Cost |
| --- | --- | --- |
| 1 | After registration and a restart/new session, the GUI lists `ornelyon` as connected (Codex: MCP settings or the tool list; Claude: `/mcp` or Connectors UI). | free |
| 2 | The GUI shows exactly 6 tools: `ornelyon_status`, `ornelyon_recent_tasks`, `ornelyon_dispatch_preview`, `ornelyon_evidence`, `ornelyon_passport`, `ornelyon_handoff_preview`, each shown as read-only/no-approval-needed or as asked by the GUI. Record how the GUI labels them. | free |
| 3 | Call each of the 6 tools once (a model turn: **PAID**). Expected: identifiers, states, hashes; free text shows `(withheld)`; a task outside the scope gives the "No such task" message. | PAID |
| 4 | Confirm the data folder did not change (compare a folder hash before and after, or run `--self-test` afterwards, which also checks this). | free |
| 5 | The GUI never offers a tool that can start an agent or write. | free |

If the GUI can show the server's tool list without a model turn, checks 1, 2, 4 and 5 cost nothing. Check 3 cannot be done without a model turn in a GUI; the Phase 0 CLI health check already covers the protocol side without one.

## 3. Failure and disconnect behaviour

Already measured on 2026-11-02 with the real Claude Code CLI 2.1.311, scratch config only, no model call:

| Case | Result |
| --- | --- |
| Correct registration | `claude mcp list`: Connected |
| `cli.js` path missing (moved folder) | `Failed to connect, CONNECTION_CLOSED` |
| Server exits immediately | `Failed to connect, CONNECTION_CLOSED` |

Meaning: a broken registration shows as a failed connection, not as wrong data. The message does not say why; the cause is found by running the registered command's `--self-test`, or `--print-config` again after a move or rebuild.

Still to measure in the GUIs (free, needs a registered server): what the GUI shows when the server process is killed mid-session (the server is stateless, so a restart or new session should reconnect); whether a tool call after the kill returns a clear error; whether Codex's 10 s startup timeout is ever hit on a cold start (Phase 0 measured 121 ms to initialize, 378 ms for `ornelyon_status`).

## 4. What to report back

Per check: PASS / FAIL / NOT_RUN, the client and version, the exact label or error text the GUI showed, and whether a model turn was used. Only a recorded PASS may be written as verified in the README table; everything else stays NOT_TESTED.

## 5. Approvals needed before running

1. Permission to run the `claude mcp add` / `codex mcp add` commands against the real settings (or to edit the config files), and to remove them afterwards.
2. Whether PAID tool-call checks (3) may be run, and on which sign-in.
3. Which task id may be exposed to the client.
4. That the owner will open the GUIs and read their screens; Claude cannot drive the Codex or Claude apps' own settings screens without computer-use access.

---

# Results (run 2026-11-02)

Legend: PASS = observed. FAIL = tried and failed. BLOCKED = could not be done in this environment. NOT_TESTED = not done because it needs a model turn or a person at the GUI.

Setup: registration name `ornelyon-phase1-test`, scope `--allow-task <one synthetic task>`, content off. The data folder (`ORNELYON_HOME`) and the task were generated by a throw-away script from synthetic values (no real task, no personal data). Client versions: Claude Code 2.1.311; Codex CLI 0.162.1 on PATH; the Codex app's own engine 0.166.0 (`~/.codex/packages/app-server-daemon`); Codex app package 26.1027.3384.

## What was done to the real settings

- Before: byte copies of `~/.claude.json` and `~/.codex/config.toml` were made in `%USERPROFILE%\ornelyon-phase1\backup\` (copied, not read or printed). Existing servers recorded: Codex 7 (`blender-ai-studio`, `codex_app`, `cua_repl`, `local-llm`, `node_repl`, `serena`, `zdd-task-intake`); Claude CLI user scope 2 (`local-llm`, `serena`).
- Registered with `claude mcp add --scope user` and `codex mcp add`; removed again with the matching `remove` commands. Also registered and removed a deliberately broken `ornelyon-phase1-bad` in Claude.
- After: the same 7 Codex servers and the same 2 Claude user-scope servers remain (definitions identical in `~/.claude.json`). The bytes of `~/.codex/config.toml` differ from the backup: the Codex tooling or the running Codex app rewrote it (key order, `120` to `120.0`, an empty `args = []` dropped, the app-managed `node_repl` env block re-ordered; the key sets are otherwise identical). No server or setting of the user was lost. The backup was deliberately not restored over the live file, because the app manages part of it.
- The backup folder contains copies of both client files, which may hold account data. Delete `%USERPROFILE%\ornelyon-phase1\backup\` when no longer needed.

## Results

| Item | Result |
| --- | --- |
| Claude Code CLI: real registration shows `Connected` (`claude mcp list`, no model call) | PASS |
| Claude Code sent `server/discover` (2026-07-28), got "method not found", then `initialize` 2025-11-25 | PASS (fallback works) |
| Codex engine 0.166.0 (the Codex app's): starts the server and lists tools, via `scripts/codex-mcp-probe.mjs` (app-server `mcpServerStatus/list`, no model call) | PASS |
| That engine's MCP client sent `initialize` with protocol 2025-06-18, then `tools/list`, `resources/list`, `resources/templates/list`; the server answered all; resources stayed empty | PASS |
| Tools recognised: all 6 (`ornelyon_status`, `ornelyon_recent_tasks`, `ornelyon_dispatch_preview`, `ornelyon_evidence`, `ornelyon_passport`, `ornelyon_handoff_preview`), all `readOnlyHint: true` (Codex engine) | PASS |
| Codex CLI 0.162.1 `codex mcp add/get/list/remove` accepts and shows the registration (`list` does not connect) | PASS (config only) |
| Works with no WebUI: the server is its own process started by the client; `ornelyon gui` was never started | PASS |
| Registration survives a new CLI process (fresh `claude mcp list`, `codex mcp get` after the add) | PASS (file level) |
| Broken path, Claude Code: `Failed to connect, CONNECTION_CLOSED` (real settings) | PASS (failure shown) |
| Broken path and instant-exit server, Codex engine: `MCP startup failed: handshaking with MCP server failed: connection closed: initialize response`; the healthy server in the same config still worked | PASS (failure shown, isolated) |
| Recovery: remove then re-add the same entry gives `Connected` again (Claude) and a listed entry (Codex) | PASS |
| Removal of the test registrations; original server lists unchanged | PASS |
| Codex app window shows the server and tools | **BLOCKED**: the permission to operate the Codex app (it appears as "ChatGPT") was declined, so no GUI was operated |
| Claude desktop Code tab shows the server and tools | **BLOCKED**: Claude cannot be given control of its own window, and the session running this work started before the registration |
| GUI restart keeps the registration | **NOT_TESTED** at GUI level (config files were not changed by a restart; the apps were not restarted because one of them hosts this session) |
| What the Codex app and the Claude Code tab display on failure | **NOT_TESTED** (only the engines' messages above were seen) |
| Calling any of the 6 tools from a GUI or from a model turn | **NOT_TESTED** (needs a model turn, which was not allowed). Connection success must not be read as tool-call success. |
| macOS, Linux | NOT_TESTED |

The Codex PASS rows are for the Codex engine bundled with the app, not for the app window. They show that the app's MCP client accepts the server; they do not show how the window presents it.

## Manual checks left for a person (about 5 minutes, no model turn needed for 1 to 3)

Register again (same commands as `--print-config`, name `ornelyon-phase1-test`, a synthetic data folder), then:

1. Codex app: Settings, MCP servers (or the plugins/MCP page): is `ornelyon-phase1-test` listed and enabled, and are 6 tools shown?
2. Claude desktop app, Code tab, **new** session: type `/mcp`. Is the server connected, and are 6 tools shown?
3. Quit and restart each app: is the entry still there?
4. Optional, uses a model turn: ask for `ornelyon_recent_tasks`.
5. Remove: `claude mcp remove ornelyon-phase1-test --scope user` and `codex mcp remove ornelyon-phase1-test`.

## Recovery notes

| Symptom | Cause found | Recovery |
| --- | --- | --- |
| `Failed to connect` / `connection closed: initialize response` | `cli.js` path missing (moved folder, no build) or the process exits at start | Run `node dist/interface/cli.js mcp --self-test` with the same arguments; if the path moved or was rebuilt elsewhere, run `--print-config` and register again |
| Tools missing in an already-open session | Servers are read when a session starts | Start a new session |
| New task not visible | Scope is a start-time snapshot | Restart the server (new session) or use `--allow-task` |
