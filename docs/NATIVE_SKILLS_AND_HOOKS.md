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

Nothing is installed by default. The helper copies the skill folders into a folder you name, shows a dry run first, and only replaces or deletes a folder that holds exactly its own `SKILL.md` and marker file, unchanged.

```bash
ornelyon skills list
ornelyon skills install --client claude            # dry run: shows what would be written
ornelyon skills install --client claude --apply    # writes ~/.claude/skills/ornelyon-*
ornelyon skills install --client codex --apply     # writes ~/.agents/skills/ornelyon-*
ornelyon skills remove  --client claude --apply    # removes only unmodified copies it installed
```

- `--client claude` means `~/.claude/skills` (Claude Code's personal-skills folder). `--client codex` means `$HOME/.agents/skills`, the user-level folder of the Codex skills page; for a project, use `--target <repo>/.agents/skills`. This reuses the same protection as the Claude install; there is no separate Codex installer.
- A folder with the same name that ORNELYON did not install is `SKIP_FOREIGN`. A copy you edited, or that has any extra file, is `KEEP_MODIFIED`. Both are left alone, so files you keep next to a skill are never deleted. (A folder someone built with a copied marker and identical contents would count as ours; that needs write access to your skills folder.)
- Each skill is written to a fresh temporary sibling folder and renamed; an update keeps the old copy until the new one is in place and restores it on failure. If a later skill fails, the earlier ones stay installed and the command says so. Re-running is harmless.
- To disable without deleting: in Claude Code the skills already need an explicit `/ornelyon-evidence-check` style call. In Codex, the official page documents `[[skills.config]]` entries (`path = "…/SKILL.md"`, `enabled = false`) in `~/.codex/config.toml`; ORNELYON does not edit that file. To remove: `skills remove`, or delete the folder.
- No settings file (`settings.json`, `config.toml`, `.claude.json`) and no MCP registration is edited by ORNELYON. With `--apply` it only adds `ornelyon-*` folders under the folder you named (for `--client claude`, inside `~/.claude/skills`).

## Hooks: decision

**Adopted (design, helper and tests): one opt-in Claude Code `Stop` hook. Not enabled by anything ORNELYON does. Codex hooks: held.**

`ornelyon hooks print --task <id> [--task <id> …]` prints a settings entry. You add it to a settings file yourself; deleting it disables it. Not verified against a live Claude Code session. The entry uses `command` plus an `args` array. The Claude Code hooks page documents this as the exec form: `command` is spawned directly with `args` as the argument vector, with no shell; on Windows `command` must be a real executable such as `node.exe` (the printed entry uses the Node that ran the command). Whether your installed Claude Code version behaves as documented is NOT_TESTED.

What the helper (`ornelyon hook stop`) does, and does not:

| Property | Behaviour |
| --- | --- |
| Input | One JSON object on stdin, at most 1 MiB. Nothing on a terminal; if the input does not finish within 5 s it gives up quietly. Anything unreadable, another event, or no listed task: no output, exit 0. |
| Output | Only `{"systemMessage": "…"}` (a notice for you). No `decision`, `continue`, `additionalContext` or permission fields, so it cannot block, steer the model, or ask it to continue. |
| Loops | `stop_hook_active: true` gives silence. It never asks Claude to continue, so it cannot start a loop. No state, no writes. |
| Cost | One read of the history file per firing (it grows with the history; the snippet sets a 10 s timeout). No agent, no network, no process started: the compiled `hook.js` and `skills.js` import no process or network module (tested), and the history code they reuse is read-only. At most 10 tasks. |
| Failure | Every error is silence with exit code 0. The snippet sets `timeout: 10`. |
| Content | Short ids, states and fixed words only. No prompt, output, check name or path from a record. |
| Verdicts | Never changes the Evidence Gate. "verified" appears only when ORNELYON's own checks say so; no record or unreadable history reads as NOT verified / UNKNOWN. |

Limits you should know: the hook only knows the tasks you list by id (static, like the MCP scope). Work done in an official GUI is not recorded by ORNELYON, so a Stop event says nothing about it. Whether the user-visible `systemMessage` appears as described in your Claude Code version is **NOT_TESTED**.

Codex hooks: the plugin page shows a `SessionStart` example for manually installed plugins; the hooks page it points to (`learn.chatgpt.com/docs/hooks`) was not read in either pass, so no Codex hook is offered.

Held: `PostToolUse`/`PreToolUse` hooks (they act mid-task and could be steered by tool output), `SubagentStop`, and any Codex hook (the OpenAI pages show a `SessionStart` example for manually installed plugins and refer to a hooks page that was not read; plugin hooks need explicit user trust).

## What the official pages say (checked 2026-11-02)

Claude Code (`code.claude.com/docs/en/skills`, `…/hooks`; the hooks details below were re-checked verbatim in a second pass; skills-page details not marked otherwise come from the first, partly summarised pass):
- Skills live in `~/.claude/skills/<name>/SKILL.md` (personal), `.claude/skills/<name>/SKILL.md` (project), or `<plugin>/skills/…`. Frontmatter includes `name`, `description`, `disable-model-invocation`, `user-invocable`, `allowed-tools`. Enterprise overrides personal, personal overrides project; plugin skills are namespaced.
- MCP tool names in `allowed-tools` are **not stated** on the skills page, so the skills pre-approve nothing.
- Hooks are set in settings files (user, project, local, managed, plugin). `Stop` input has `stop_hook_active`. Exit 0 with a JSON object is parsed; exit 2 blocks. Checked verbatim on the page (2026-11-02, second pass): `args` is a supported command-hook field (exec form); the `timeout` field is in seconds and defaults to 600 for command hooks (30 for `UserPromptSubmit`); `stop_hook_active` is true when Claude Code is already continuing because of a stop hook, and after eight consecutive continuations Claude Code overrides the next block and ends the turn (the count resets when Claude calls a tool; `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` raises it); `systemMessage` is a "warning message shown to the user" (some events discard it or deliver it elsewhere, each event's section says so; the `Stop` section was not checked for this). Output strings are capped at 10,000 characters.

OpenAI (`developers.openai.com/plugins/...`):
- Plugin pages: a skill is a folder with `SKILL.md` (`name`, `description`); plugins package skills under `skills/` and MCP servers in `.mcp.json`.
- Codex skills page (`developers.openai.com/codex/skills` redirects to `learn.chatgpt.com/docs/build-skills`; the cached copy shows no date or Codex version): Codex reads skills from repository, user, admin and system locations: `$CWD/.agents/skills`, `$CWD/../.agents/skills`, `$REPO_ROOT/.agents/skills`, user `$HOME/.agents/skills`, admin `/etc/codex/skills`. `SKILL.md` must include `name` and `description`. Skills with the same `name` are not merged; both can appear in selectors, and no precedence is stated. Symlinked skill folders are supported. Explicit use: `/skills` or typing `$`. Optional `agents/openai.yaml` has a `policy` section with `allow_implicit_invocation: false`, which stops implicit use while `$skill` still works. Disable without deleting: `[[skills.config]]` with `enabled = false` in `~/.codex/config.toml`.
- **`disable-model-invocation: true` is a Claude Code field.** The Codex page documents only `name` and `description` for `SKILL.md`, so Codex is not documented to honour it and it does not guarantee manual-only use in Codex. The bundled skills do not ship `agents/openai.yaml`; until they do, a Codex that matches the description may offer them on its own. The wording "Use only when the user asks" narrows that but is not a guarantee. This stays NOT_TESTED.
- So the Codex side is: the same `SKILL.md` files can be installed into `$HOME/.agents/skills` or a repo's `.agents/skills`. Whether a given Codex version loads them, and whether it uses them without being asked, is **NOT_TESTED**.

## Not verified

No Claude Code or Codex window or session was started for this work, and no model was called. Skills were not loaded by a client; hooks were not fired by Claude Code. What is tested: file structure, tool names and arguments against the real MCP schemas, the installer on temporary folders, and the hook helper with synthetic stdin.
