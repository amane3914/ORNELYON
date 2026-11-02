# Skills and Hooks for the official GUIs (v0.7.0 Phase 0)

Goal: let Codex and Claude Code use ORNELYON's existing read-only MCP tools through ordinary Agent Skills, without a WebUI. Skills are thin text: they tell the model which of the six MCP tools to call and how to report the answer. No logic is duplicated, no script is shipped, and nothing here starts an agent, writes a file through MCP, or changes the Evidence Gate.

Everything below was checked against the official pages on 2026-11-02 (see "What the official pages say"). Anything those pages did not state is marked **not stated**, and was not guessed.

## The three skills (`integrations/skills/`)

| Skill | What it does | MCP tools it names |
| --- | --- | --- |
| `ornelyon-evidence-check` | Execution / Verification / Acceptance of one task, with gaps. Nothing is "passed" unless `verifiedByOrnelyon` is true. | `ornelyon_recent_tasks`, `ornelyon_evidence` |
| `ornelyon-task-history` | Search the visible history, filter by state or agent, list tasks with no final record (`incomplete`). | `ornelyon_recent_tasks` |
| `ornelyon-resume-preview` | Passport continuation state, open issues, drift, handoff preview. Previews only; `resumed` is always false. | `ornelyon_passport`, `ornelyon_handoff_preview`, `ornelyon_recent_tasks` |

Common to all: a plain `SKILL.md` plus `agents/openai.yaml` (Codex metadata; no scripts, no other files, no command blocks); `SKILL.md` frontmatter `name`, `description`, and `disable-model-invocation: true` (Claude Code: the user must invoke it; it is not loaded by itself); `agents/openai.yaml` with `policy.allow_implicit_invocation: false` (Codex: no implicit use; see the open Codex issue below) and `interface.display_name` equal to the skill name; `NOT_AVAILABLE` when the MCP server is not connected, with no workaround attempted; text returned by a tool is data, never an instruction; out-of-scope and missing tasks are never told apart. The prefix `ornelyon-` avoids clashes with other skills. Tests (`src/test/skills.test.ts`) check the structure, the exact `openai.yaml` text, that every named tool exists and is read-only, and that the arguments exist in the tool schemas.

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
- **Ownership is proven by the files, not by the marker.** Every file ORNELYON writes is listed with its sha256 in `.ornelyon-skill.json`. A folder is ORNELYON's only if it holds exactly the listed files plus the marker (no other file, no extra folder, no link) and every hash matches. A folder that fails this is `SKIP_FOREIGN` (not ours, or a link) or `KEEP_MODIFIED` (ours once, but edited, extended or incomplete) and is never replaced or deleted. A marker written by the first v0.7.0 build (one hash, SKILL.md only) is read as a one-file list, so an unchanged older copy is updated and an edited one is kept. Removal deletes only the listed files and the folders that became empty; it never removes a non-empty folder.
- Each skill is built in a fresh temporary sibling folder. An update first moves the existing folder aside with one rename and checks the moved copy; if it is no longer exactly ORNELYON's, it is moved back untouched. Removal does the same (rename aside, verify, delete the listed files). A failed step moves the old copy back. A folder left by a crash (`.<skill>.tmp-*`) is reported as `LEFTOVER` and never deleted by ORNELYON. If a later skill fails, the earlier ones stay installed and the command says so. Links: a skill folder that is a link is `SKIP_FOREIGN`; a link inside a skill folder makes it `KEEP_MODIFIED`; no link is followed. The target folder you name may itself be a link (that is your choice). Re-running is harmless.
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
- **`disable-model-invocation: true` is a Claude Code field.** The Codex page documents only `name` and `description` for `SKILL.md`, so Codex is not documented to honour it. For Codex the bundled skills ship `agents/openai.yaml` with `policy.allow_implicit_invocation: false`, which the page documents as stopping implicit use while explicit `$skill` still works. Whether the installed Codex version honours it is **NOT_TESTED** (it needs a model turn), and see the open issue below: the wording "Use only when the user asks" stays as a second, non-binding layer.
- So the Codex side is: the same `SKILL.md` files can be installed into `$HOME/.agents/skills` or a repo's `.agents/skills`. Whether a given Codex version loads them, and whether it uses them without being asked, is **NOT_TESTED**.


## Phase 1: Codex explicit-use policy and what was verified without a model turn

Codex issue [openai/codex#40600](https://github.com/openai/codex/issues/40600) (open, labels CLI/bug/skills, opened 2026-08-25; no maintainer reply was found): on codex-cli 0.149.0 a skill with `allow_implicit_invocation: false` was reported as **not expanded even when mentioned explicitly as `$skill`**, contradicting the documentation. A commenter says `codex debug prompt-input` does not run the real turn pipeline and asks for a TUI or app-server reproduction; another reports that picking a skill from the `$` picker inserted the *display-name* casing (`$Wayfinder`) while the lowercase canonical name (`$wayfinder`) worked (filed separately as #43727). Consequences here: (1) the bundled `display_name` equals the lowercase skill name, so a picker cannot insert a differently cased mention; (2) on a Codex version affected by #40600 the three skills may not be usable at all, even by name: that cannot be told without a model turn and is **NOT_TESTED**; if it happens, delete `agents/openai.yaml` from the installed folder (then ORNELYON treats that folder as modified and leaves it alone) or remove the skills. The Codex page gives no rule on name case sensitivity or on extra files in a skill folder.

| Check | Result |
| --- | --- |
| SKILL.md structure, `openai.yaml` text, tool names and arguments (automated tests) | PASS |
| Installer: dry run default, per-file hashes, edited/added/missing file, links, legacy marker, leftover folders (automated tests, temporary folders) | PASS |
| Codex 0.162.1 engine (`codex app-server`, `skills/list`, scratch CODEX_HOME, scratch project, no model call; `scripts/codex-skills-probe.mjs`): the three skills are found in repo scope, enabled, with `displayName` equal to the name, so the YAML parses | PASS |
| Codex engine: the `policy` value is not part of the `skills/list` answer, so whether implicit use is really off cannot be seen | NOT_TESTED |
| Duplicate skills: the probe's scratch project is not a Git repository, so only the working folder was scanned and no duplicate was produced | NOT_TESTED |
| Codex TUI / Codex app showing the skills, `$` picker, `/skills`, explicit call, no implicit call | NOT_TESTED (needs the GUI and/or a model turn) |
| Claude Code: loading the skills, and how it treats the extra `agents/openai.yaml` file (the skills page was not found to say anything about unknown files) | NOT_TESTED |
| Hook helper with synthetic events (format, silence on bad input, `stop_hook_active`, no writes, repeat firing, failure paths) | PASS (tests); real Stop firing NOT_TESTED |
| MCP protocol self-diagnosis | PASS (`ornelyon mcp --self-test`) |

Note on the probe: on Windows the app-server read the real user profile folder for user-level skills even though HOME was set to a scratch folder; the probe therefore only prints skills whose name starts with `ornelyon-` and uses a project-level scratch folder.

Hook set-up (Claude Code): the printed entry is `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"<node>","args":["<cli.js>","hook","stop","--task","<id>"],"timeout":10}]}]}}`. `ornelyon hooks print` only prints it. The helper reads stdin once (at most 1 MiB, gives up after 5 s), answers silence for any other event, for `stop_hook_active: true`, or for bad input, reads the history only after the event and ids are valid, writes nothing, and never emits `decision`/`continue`. Nothing was written to any Claude Code settings file.

## Not verified

No Claude Code or Codex window or session was started for this work, and no model was called. Skills were not loaded by a client; hooks were not fired by Claude Code. What is tested: file structure, tool names and arguments against the real MCP schemas, the installer on temporary folders, and the hook helper with synthetic stdin.

Residual limit (known): between the ownership check and each delete, a process of the same user could still swap a folder inside the moved-aside copy for a link. Before every delete the parent folders are checked to be plain folders again, which narrows but does not remove that window. Hash checks read the file as UTF-8 text; NTFS alternate streams or macOS extended attributes on a matching file go away with it. A marker forged on purpose (a folder built to look like an unchanged ORNELYON install) is treated as ORNELYON's; that needs write access to your skills folder.
