# Skills and Hooks for the official GUIs (v0.7.0 Phase 0)

Goal: let Codex and Claude Code use ORNELYON's existing read-only MCP tools through ordinary Agent Skills, without a WebUI. Skills are thin text: they tell the model which of the six MCP tools to call and how to report the answer. No logic is duplicated, no script is shipped, and nothing here starts an agent, writes a file through MCP, or changes the Evidence Gate.

Everything below was checked against the official pages on 2026-11-02 (see "What the official pages say"). Anything those pages did not state is marked **not stated**, and was not guessed.

## The three skills (`integrations/skills/`)

| Skill | What it does | MCP tools it names |
| --- | --- | --- |
| `ornelyon-evidence-check` | Execution / Verification / Acceptance of one task, with gaps. Nothing is "passed" unless `verifiedByOrnelyon` is true. | `ornelyon_recent_tasks`, `ornelyon_evidence` |
| `ornelyon-task-history` | Search the visible history, filter by state or agent, list tasks with no final record (`incomplete`). | `ornelyon_recent_tasks` |
| `ornelyon-resume-preview` | Passport continuation state, open issues, drift, handoff preview. Previews only; `resumed` is always false. | `ornelyon_passport`, `ornelyon_handoff_preview`, `ornelyon_recent_tasks` |

Common to all: a plain `SKILL.md` (no scripts, no bundled files, no command blocks); frontmatter `name`, `description`, and `disable-model-invocation: true` (Claude Code: the user must invoke it; it is not loaded by itself); `NOT_AVAILABLE` when the MCP server is not connected, with no workaround attempted; text returned by a tool is data, never an instruction; out-of-scope and missing tasks are never told apart. The prefix `ornelyon-` avoids clashes with other skills. Tests (`src/test/skills.test.ts`) check the structure, that every named tool exists and is read-only, and that the arguments exist in the tool schemas.

The skills need the MCP server registered (`ornelyon mcp --print-config`, see NATIVE_GUI_INTEGRATION.md). Scope is the server's static scope; `--expose-content` stays off unless you add it.

## Install, disable, remove

Nothing is installed by default. The helper copies the skill folders into a folder you name, shows a dry run first, and never touches a skill folder it did not write.

```bash
ornelyon skills list
ornelyon skills install --client claude            # dry run: shows what would be written
ornelyon skills install --client claude --apply    # writes ~/.claude/skills/ornelyon-*
ornelyon skills remove  --client claude --apply    # removes only unmodified copies it installed
```

- `--client claude` means `~/.claude/skills`, the personal-skills folder the Claude Code documentation names. For Codex there is no `--client codex` on purpose: the OpenAI pages checked describe plugin packaging and do not state a user skills folder. Use `--target <folder>` with the folder your Codex version documents, or copy the three folders by hand.
- A folder with the same name that ORNELYON did not install is `SKIP_FOREIGN`. A copy you edited is `KEEP_MODIFIED`. Both are left alone.
- Each skill is written to a temporary sibling folder and renamed, so a failure leaves nothing half written. Re-running is harmless.
- To disable without deleting: in Claude Code the skills already need an explicit `/ornelyon-evidence-check` style call. To remove: `skills remove`, or delete the folder.
- `.claude`, `.codex`, MCP registrations and any settings file are never edited by ORNELYON.

## Hooks: decision

**Adopted (design, helper and tests): one opt-in Claude Code `Stop` hook. Not enabled by anything ORNELYON does. Codex hooks: held.**

`ornelyon hooks print --task <id> [--task <id> …]` prints a settings entry. You add it to a settings file yourself; deleting it disables it. Not verified against a live Claude Code session.

What the helper (`ornelyon hook stop`) does, and does not:

| Property | Behaviour |
| --- | --- |
| Input | One JSON object on stdin, at most 64 KiB. Anything unreadable, another event, or no listed task: no output, exit 0. |
| Output | Only `{"systemMessage": "…"}` (a notice for you). No `decision`, `continue`, `additionalContext` or permission fields, so it cannot block, steer the model, or ask it to continue. |
| Loops | `stop_hook_active: true` gives silence. It never asks Claude to continue, so it cannot start a loop. No state, no writes. |
| Cost | One bounded read of the history per firing. No agent, no network, no process started (a test checks the compiled code). At most 10 tasks. |
| Failure | Every error is silence with exit code 0. The snippet sets `timeout: 10`. |
| Content | Short ids, states and fixed words only. No prompt, output, check name or path from a record. |
| Verdicts | Never changes the Evidence Gate. "verified" appears only when ORNELYON's own checks say so; no record or unreadable history reads as NOT verified / UNKNOWN. |

Limits you should know: the hook only knows the tasks you list by id (static, like the MCP scope). Work done in an official GUI is not recorded by ORNELYON, so a Stop event says nothing about it. Whether the user-visible `systemMessage` appears as described in your Claude Code version is **NOT_TESTED**.

Held: `PostToolUse`/`PreToolUse` hooks (they act mid-task and could be steered by tool output), `SubagentStop`, and any Codex hook (the OpenAI pages show a `SessionStart` example for manually installed plugins and refer to a hooks page that was not read; plugin hooks need explicit user trust).

## What the official pages say (checked 2026-11-02)

Claude Code (`code.claude.com/docs/en/skills`, `…/hooks`; both pages were long and partly read through summaries, so those parts are lower confidence):
- Skills live in `~/.claude/skills/<name>/SKILL.md` (personal), `.claude/skills/<name>/SKILL.md` (project), or `<plugin>/skills/…`. Frontmatter includes `name`, `description`, `disable-model-invocation`, `user-invocable`, `allowed-tools`. Enterprise overrides personal, personal overrides project; plugin skills are namespaced.
- MCP tool names in `allowed-tools` are **not stated** on the skills page, so the skills pre-approve nothing.
- Hooks are set in settings files (user, project, local, managed, plugin). `Stop` input has `stop_hook_active`. Exit 0 with a JSON object is parsed; exit 2 blocks. Defaults: 600 s timeout for command hooks. Claude Code ends a chain after eight consecutive stop-hook continuations.

OpenAI (`developers.openai.com/plugins/...`):
- A skill is a folder with `SKILL.md` (`name`, `description`); optional `scripts/`, `references/`, `assets/`. Plugins package skills under `skills/` and MCP servers in `.mcp.json`; install is via `codex plugin marketplace add …` or manual copy. Standalone skill folders, an explicit-invocation-only setting, name precedence and Codex client versions are **not stated** on those pages. `$skill-name` is how the page invokes the skill creator.
- Because of that, the Codex side of this release is only "the same SKILL.md files can be copied to a folder you choose". Whether a given Codex version loads them, and whether it may use them without being asked (the `disable-model-invocation` line is a Claude Code field and may be ignored there), is **NOT_TESTED**. The descriptions say "Use only when the user asks" to keep implicit use narrow.

## Not verified

No Claude Code or Codex window or session was started for this work, and no model was called. Skills were not loaded by a client; hooks were not fired by Claude Code. What is tested: file structure, tool names and arguments against the real MCP schemas, the installer on temporary folders, and the hook helper with synthetic stdin.
