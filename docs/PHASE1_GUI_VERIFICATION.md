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
