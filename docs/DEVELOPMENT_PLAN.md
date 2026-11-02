# ORNELYON development status and roadmap

This document distinguishes implemented features from plans. Development branch: v0.6.0 Phase 0/1; package version remains **0.4.2** until the owner approves a release. A merged branch is not itself a released version.

## Principles

1. **Single-Agent First.** One Codex or one Claude Code must get the full benefit of the harness: Evidence Gate, Task History, Task Passport, Loop Guard, Verification. No feature may require a second agent.
2. **Multi-Agent Optional.** Review, delegation and handoff between agents stay available but off by default, and never limit what a single agent can do.
3. **Native-GUI First.** The official Codex and Claude Code GUIs are the main place of use. The ORNELYON WebUI stays an optional page for setup, administration and diagnosis. New features live in the Core / Service layer (`src/core`, `src/interface/service.ts`) so that the CLI, the WebUI and MCP share one implementation.

## Implemented and verified status (2026-11-02)

- **v0.5.0 integration baseline (already merged to main):** read-only MCP (6 tools), `--print-config`, `--self-test`, Claude Code CLI and Codex engine protocol checks without a model call. Owner confirmed **Codex app GUI registration display only**. Codex GUI tool detail view, Claude Desktop Code-tab MCP use, restarts, and model-mediated invocations remain **NOT_TESTED**; see [PHASE1_GUI_VERIFICATION.md](PHASE1_GUI_VERIFICATION.md).
- **v0.6.0 Phase 0/1 (development branch, not released):** scope-limited history filters, evidence gaps / verification, passport continuation assessment, `doctor` registration diagnostics, `NO_FINAL_RECORD` lists, resume-preview status, and workspace identity labels. Dynamic MCP scope is **HOLD**, not implemented; see [DYNAMIC_SCOPE_DESIGN.md](DYNAMIC_SCOPE_DESIGN.md).
- **Safety boundary:** doctor does **not** invoke `claude mcp get` by default, because it may launch an arbitrary registered MCP server. `doctor --probe-registration` is an explicit opt-in and can start named registrations; use only after inspecting and trusting them. The built-in isolated MCP self-test does not invoke an agent.

## Roadmap

| Milestone | Status | Scope / remaining condition |
| --- | --- | --- |
| v0.5.0 native-GUI baseline | **Implemented, partially verified** | Manual Claude Desktop GUI recognition, Codex GUI tools and model-mediated calls remain unverified; no such test is authorized by this plan. |
| v0.6.0 Phase 0: single-agent reads | **Implemented on branch** | Evidence, history filtering and Passport read for *ORNELYON-recorded* tasks only; not automatic capture of native-GUI work. |
| v0.6.0 Phase 1: doctor and recovery | **Implemented on branch** | Diagnostic checks, NO_FINAL_RECORD and resume previews. A missing final record is not proof of interruption; no automatic restart. |
| Dynamic MCP task scope | **HOLD** | Workspace labels are neither authorization nor caller identity. Static scope and content-off default remain unchanged. |
| v0.7.0 read-only Hooks / Skills | **PLANNED** | Design and review prompt-injection boundaries before enabling hooks or packaging plugins. |
| v0.8.0+ MCP action tools | **PLANNED** | Require explicit per-call approval, authorization, audit, caps and a verified identity / trust model. |
| MCP 2026-07-28 and other clients | **PLANNED / NOT_TESTED** | Verify spec, transports and real GUI behavior before claims of compatibility. |
| Optional multi-agent | **Existing, partially verified** | Real Codex cross-agent paths and subscription automation terms remain unconfirmed. |

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

## Release boundary

All v0.6.0 features above are development work until separately merged and released. Keep the package version at 0.4.2 and do not create a tag or public Release merely because tests or a pull request pass. **Do not claim full native-GUI integration**: only Codex app registration display has been observed; Claude Desktop Code-tab behavior and tool invocations remain NOT_TESTED.
