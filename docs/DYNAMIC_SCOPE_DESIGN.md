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
