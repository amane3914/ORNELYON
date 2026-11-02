# MCP scope that follows new tasks: design review (v0.6.0 Phase 0)

Decision: **HOLD. The static scope stays. Nothing was implemented.** This file records why, and what would have to exist first.

## The problem

`--recent N` is a snapshot taken when the server starts. In a GUI the server lives for one session, so a task started afterwards cannot be looked at until the session is restarted.

## What the code offers today (checked 2026-11-02)

- `McpOptions.tasks` is a list of task ids or `'all'`, fixed at start. Every per-task tool checks it in the server; `ornelyon_recent_tasks` applies it before the limit.
- A history record (`RunRecord`) holds: time, role, task group id, mode, kind, prompt, result, evidence, handoff meta, adapter provenance, contract. **It does not record which workspace, which client or which session started the task.** `workspaceRoot` is one global setting.
- Task ids are random UUIDs made by ORNELYON. The id says nothing about who may see it.
- stdio gives the server no identity of the client.

## Options considered

| Option | What it would expose | Verdict |
| --- | --- | --- |
| A. `--since-start`: every task recorded after the server started | Every future task of this ORNELYON data folder, whoever or whatever started it (CLI, WebUI, another client, a handoff) | **Rejected.** The operator named no task; the set is decided by other people's future actions. Widening by default is not acceptable. |
| B. Re-read `--recent N` on each call | The N newest tasks at call time | **Rejected.** Same problem as A, and it makes the scope change silently between two calls of one session. |
| C. Scope by workspace: tasks whose recorded workspace equals the server's | Only tasks of one folder | **Not possible yet.** Records carry no workspace. It needs a Core change (record a workspace identity at task creation) and applies only to tasks created after that change. |
| D. Operator lists a *rule* in a file (`--scope-file`) that ORNELYON re-reads | Whatever the file says, edited while the session runs | Possible, but it moves the access decision to a file that a model with file tools may be able to edit. Needs a protection design first. **Not chosen.** |
| E. Task ids handed over by the operator one at a time (`--allow-task`), restart to add | Exactly the named tasks | **Kept.** It is today's behaviour. |

## What would make a dynamic scope acceptable (for v0.6.0 Phase 1 or later)

1. Core records a **workspace identity** (a hash of the real path, never the path) on the summary record of every new task. Old tasks have none and stay invisible to a workspace scope.
2. A scope option names that workspace explicitly (`--workspace-tasks`, never the default) and implies `--since-start` plus the identity match. It is refused together with `--expose-content` unless the operator also names the task ids.
3. The rule is fixed at start. Only new tasks matching it appear; the rule itself cannot be changed over MCP or by editing a file the model can reach.
4. Tests, written before the code: a new task of the same workspace appears; a new task of another workspace, an old task, a task without identity and a damaged record do not; counts and filters never reveal the hidden ones; `--expose-content` behaviour is unchanged; ids still need exact UUIDs.
5. The limit that remains must be stated: any process of the same OS user can start a task in that workspace, so this scope means "tasks of this folder", not "tasks of this client".

## What was done instead

- A regression test now checks that a task recorded after the server started is neither listed nor readable (`scope stays static`).
- Search filters were added inside the existing scope (see the report). They can only narrow what the scope already allows.

## Phase 1 re-evaluation (v0.6.0 Phase 1): still HOLD

Prerequisite 1 now exists: new task summaries carry a workspace label (docs/WORKSPACE_IDENTITY.md). The question was whether `--workspace-tasks` (new tasks whose label equals the server's) is a safe boundary. It is not, for these reasons:

1. **The label does not discriminate.** ORNELYON has one global `workspaceRoot`. Every task started from that installation gets the same label, whichever client, window or person started it. "Same workspace and newer than the server" therefore equals option A (all future tasks of the data folder) in practice. A second label only appears if the operator changes the setting, which is not a security boundary.
2. **The label has no integrity protection.** `history.jsonl` is a plain append file and the key sits in the same user's data folder, so any same-user process can write a record carrying a matching label without going through ORNELYON at all.
2b. **The label is not an identity of the requester.** It is computed from the configuration at record time. It says where the task ran, not who asked, and not which MCP session the operator had in mind.
3. **Any same-user process can create matching tasks.** The CLI, the WebUI, a handoff or another MCP client can all produce a record that matches, and the operator would not have named it. With content off the exposure is ids, states, agent and kind; with content on (`--expose-content`) it would include prompts and reports of tasks nobody chose. Content mode would have to be refused together with the rule, and that leaves a rule whose benefit (see new task states without restart) is small compared with the widening.
4. **Old and damaged records.** Old history has no label (UNKNOWN, never filled in). A rule that depends on the label silently excludes it, so the same server would show a different set the day after an upgrade, which is the silent change option B was rejected for.
5. **Three paths must agree.** Search, Evidence and Passport each need the identical test, applied before counts and limits, and the tests must prove that hidden tasks never change `matched`. This is doable, but it is complexity bought for a rule that fails points 1 to 3.

**Decision: the static scope stays.** What Phase 1 added instead, with no widening of scope:

- `ornelyon_recent_tasks` with `incomplete=true` lists tasks of the **existing** scope (so under the default `--recent` scope, which holds finished tasks only, it finds nothing until the id is added with `--allow-task` or `--all-tasks` is used) that have call records but no final record.
- The operator can restart the server with the new task id (`ornelyon mcp --print-config --allow-task <id>`).

Unresolved, in the order they would have to be settled before a dynamic scope is reopened:

1. A way to name a *session* or *client* (not a folder) that the server can verify. stdio offers none; a client-provided header or token would be a credential and is out of scope.
2. A fixed rule that does not depend on the single global `workspaceRoot` (for example several named workspaces in configuration).
3. A protected place for the rule that a model with file tools cannot edit.
4. Tests first, as listed above.

Until then, "allow the task I just started" stays an explicit operator step.
