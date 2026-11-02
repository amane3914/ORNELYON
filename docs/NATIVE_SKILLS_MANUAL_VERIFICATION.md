# Manual verification of the Skills in Codex and Claude Code (v0.7.0)

Steps marked **[MODEL TURN]** send a prompt to a model and use your subscription or quota. ORNELYON's own tests never do that. Do those steps only when you decide to. Everything else here makes no model call.

## 0. Build the isolated test bed

The helper scripts (`scripts/skills-testbed.mjs`, `codex-skills-probe.mjs`, `codex-mcp-probe.mjs`) are in the Git repository and are not part of the distribution ZIP.

```bash
npm run build
node scripts/skills-testbed.mjs <new-empty-folder>
```

It creates, inside that folder only: a throw-away Git repository (`repo/`), a throw-away ORNELYON data folder (`ornelyon-home/`) holding **one synthetic task** (Execution SUCCESS, Verification UNVERIFIED, Acceptance PENDING) and its passport, the three Skills in `repo/.agents/skills` (Codex) and `repo/.claude/skills` (Claude Code), `repo/.mcp.json` (Claude Code) and `repo/.codex/config.toml` (Codex), each exposing only that one task (no `--all-tasks`, no `--expose-content`). It prints the task id. Nothing under your home folder is read or changed, and no client is started.

Clean up: delete the folder you gave it. Nothing else was written. (If you approve the project MCP server in Claude Code, or trust the project in Codex, the client records that choice in its own settings; see "Undo" below.)

## 1. Checks without a model turn (already done for the maintainer's machine; repeat on yours if you like)

| Check | Command | Expected |
| --- | --- | --- |
| Codex finds the Skills | `node scripts/codex-skills-probe.mjs <path-to-codex> <scratch-home> <scratch-codex-home> <repo>` | 3 lines, `scope: repo`, `enabled: true`, `displayName` equal to the name |
| Codex starts the MCP server and sees 6 read-only tools | copy `repo/.codex/config.toml` to `<scratch-codex-home>/config.toml`, then `node scripts/codex-mcp-probe.mjs <path-to-codex> <scratch-codex-home>` | `ornelyon-testbed: OK 6 tool(s), all read-only: true` |
| Claude Code sees the project server | in `repo/`: `claude mcp get ornelyon-testbed` | shows the command; `Pending approval` until you approve it once in an interactive `claude` session |
| MCP protocol self-test, same scope | `ORNELYON_HOME=<folder>/ornelyon-home node dist/interface/cli.js mcp --self-test --allow-task <id>` | `SELF-TEST PASS` |
| Hook helper, synthetic Stop event | `echo '{"hook_event_name":"Stop"}' \| ORNELYON_HOME=<folder>/ornelyon-home node dist/interface/cli.js hook stop --task <id>` | one JSON line with only `systemMessage`, saying NOT verified; exit 0 |

## 2. Claude Code **[MODEL TURN]**

Open `repo/` in Claude Code (CLI or the Code tab) and, when asked, approve the project MCP server `ornelyon-testbed`. Do not add the Stop hook yet.

| # | Do | Expect | Result |
| --- | --- | --- | --- |
| C1 | Type `/` and look at the list | the three `ornelyon-*` Skills appear (no model needed to open the list) | |
| C2 | Ask any unrelated question, e.g. "what files are in this repo?" | the Skills are not used by themselves | |
| C3 | `/ornelyon-evidence-check <task id>` | Execution SUCCESS, Verification UNVERIFIED, Acceptance PENDING reported separately; says it is **not** verified; no "passed" wording | |
| C4 | `/ornelyon-evidence-check 00000000-0000-4000-8000-000000000000` | "not available" wording; does not say whether the task exists | |
| C5 | `/ornelyon-task-history` | lists the one task; says only one task is in scope | |
| C6 | `/ornelyon-task-history` with `incomplete` asked for | no task listed (the synthetic task is finished) | |
| C7 | `/ornelyon-resume-preview <task id>` | a state (CAUTION expected: verification not passed, decision pending), reasons, "nothing was resumed"; content shown as withheld | |
| C8 | In a repo without the MCP server, `/ornelyon-evidence-check <id>` | answers `NOT_AVAILABLE`; runs no command and reads no data folder | |

## 3. Codex (app, CLI, IDE) **[MODEL TURN]**

Open `repo/` in Codex and trust the project when asked (needed for `.codex/config.toml`). Note the Codex version first (`codex --version`; the maintainer's was 0.162.1).

| # | Do | Expect | Result |
| --- | --- | --- | --- |
| X1 | `/skills` (CLI/IDE) or the Skills page (app) | the three Skills are listed once each | |
| X2 | Type `$` and look at the picker; note whether the inserted text is lower case | `$ornelyon-evidence-check` in lower case | |
| X3 | Ask an unrelated question | the Skills are not used by themselves (the policy `allow_implicit_invocation: false`) | |
| X4 | Type `$ornelyon-evidence-check <task id>` by hand, in lower case | the Skill loads and reports as in C3. **If it does not load, that is the case reported in openai/codex#40600** | |
| X5 | Only if X4 failed: delete `repo/.agents/skills/ornelyon-evidence-check/agents/openai.yaml` and repeat X4 | the Skill loads (so the policy line was the cause on this Codex version) | |
| X6 | Same checks in the Codex app after X1 to X4 pass in the CLI/IDE | same results; note any difference between surfaces | |

Record the Codex version, the surface (app, CLI or IDE) and PASS/FAIL for each row in the table of `docs/NATIVE_SKILLS_AND_HOOKS.md`. A failed X4 is a finding to report, not something to hide: it decides whether the `openai.yaml` files stay in the bundle.

## 4. Stop hook (later, optional) **[MODEL TURN]**

Only after sections 2 and 3: put the entry printed by `ornelyon hooks print --task <id>` into `repo/.claude/settings.local.json` (inside the test bed, not your personal settings), end a turn, and check that one warning appears, nothing repeats, and the turn is not blocked. Delete the entry to disable it.

## Undo

- Test bed: delete the folder.
- Claude Code project-server approval: `claude mcp reset-project-choices` (run inside `repo/`), or remove `ornelyon-testbed` from the Claude Code project settings entry for that path.
- Codex project trust: remove the `[projects."<repo path>"]` entry from `~/.codex/config.toml` if you want it gone.
- Your own Skills, Hooks and MCP registrations were never touched by any step in this file.
