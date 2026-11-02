# Development policy and plan after v0.5.0 Phase 1

Planning only. Nothing in this file is implemented. Version stays 0.4.2 until the owner decides otherwise.

## Principles

1. **Single-Agent First.** One Codex or one Claude Code must get the full benefit of the harness: Evidence Gate, Task History, Task Passport, Loop Guard, Verification. No feature may require a second agent.
2. **Multi-Agent Optional.** Review, delegation and handoff between agents stay available but off by default, and never limit what a single agent can do.
3. **Native-GUI First.** The official Codex and Claude Code GUIs are the main place of use. The ORNELYON WebUI stays an optional page for setup, administration and diagnosis. New features live in the Core / Service layer (`src/core`, `src/interface/service.ts`) so that the CLI, the WebUI and MCP share one implementation.

## Where things stand (v0.4.2 plus the Phase 0/1 branch)

Read-only MCP (6 tools), `--print-config`, `--self-test`. Connection checked with the Claude Code CLI and the Codex engine without a model call. Not yet checked: the two GUI windows, GUI restart, any tool call inside a model turn (see [PHASE1_GUI_VERIFICATION.md](PHASE1_GUI_VERIFICATION.md)).

## Proposed order

| Step | Content | Why now | Needs before starting |
| --- | --- | --- | --- |
| v0.5.0 close-out | Manual GUI checks (display, restart, one optional tool call), then record them | The Native-GUI claim rests on them | A person at both GUIs |
| v0.6.0 | **Single-agent value through MCP, still read-only:** Evidence Gate result for the *current* work (not only saved tasks), Task History search, Task Passport read for resume. Scope that follows live history by explicit rule instead of a start-time snapshot | Makes the GUI useful for one agent with no write risk | Scope design that does not widen access by default |
| v0.6.x | Session management and recovery: list interrupted tasks, show what a resume would carry (the passport and handoff preview already exist), diagnose a broken registration (`doctor` that compares registered paths with the build) | Recovery is a single-agent need | None beyond v0.6.0 |
| v0.7.0 | **Safe Hooks / Skills integration:** a Claude Code hook or Codex skill that calls the *read-only* tools (for example "show Evidence before I say done"). Packaging as a plugin | One-step setup, guidance on treating returned text as data | A review of what hook output can inject into the model |
| v0.8.0+ | **Action tools over MCP** (record accept/reject, start a task), only after the design below is agreed and reviewed | Highest risk, so last | The design below |
| Anytime, optional | Multi-agent: turn on review/handoff when the owner enables it; keep documentation honest that only Claude Code to Claude Code was run for real | Keeps the optional promise | Real Codex runs, which are paid and need approval |
| Anytime | MCP 2026-07-28 revision (`server/discover`, result types, caching hints) once checked against the specification; HTTP transport on loopback with a token; macOS / Linux verification | Compatibility | Spec check; token handling design |

## Design that must exist before any action tool

An action tool is a tool that writes, starts an agent or records a decision. None exists, and none is to be added until all of these are written down and reviewed:

1. **Per-call approval.** Each action needs a human approval inside the client for that single call; "allow always" must not be enough. The approval text is produced by ORNELYON (what will run, on which task, with which limits), not by the model.
2. **Permission boundary.** A separate server entry (or flag) for action tools, off by default, so enabling read-only access never enables actions. A tool may touch only the tasks and the workspace it was scoped to.
3. **Call limits.** Hard caps outside the model's control: number of calls per session, per task, per hour, and a spend ceiling that is read from ORNELYON's own cost records. Exceeding a cap stops with a clear error.
4. **Audit.** Every action writes an append-only record (who asked through which client, the approved text, the result), in the same history that Evidence Gate already uses.
5. **Evidence Gate unchanged.** An agent's claim never counts as acceptance; an action tool cannot mark a task accepted without the existing checks.
6. **Prompt-injection stance.** Text returned by read tools is data. An action must never take its arguments from returned text without the user seeing them in the approval.
7. **Identity.** stdio has no caller identity. Either accept that and keep actions out of stdio, or move actions to a transport that has authentication.

## Risks to keep in view

- Per-client authentication does not exist on stdio; the scope is the only access control.
- `--expose-content` passes agent-written text to the client model.
- Registrations hold absolute paths and break when the folder moves.
- Whether automated use under a subscription sign-in is allowed is NOT CONFIRMED.
- Version, tag and release decisions belong to the owner.

## Status after v0.6.0 Phase 1

Done on the branch: doctor (GUI integration diagnosis), NO_FINAL_RECORD listing and resume-preview wording, workspace label, output size/stability test. Held: dynamic MCP scope (DYNAMIC_SCOPE_DESIGN.md). Not done: any GUI-window verification (needs a person), MCP 2026-07-28 support, write or agent tools.
