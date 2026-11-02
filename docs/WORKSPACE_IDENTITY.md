# Workspace identity (v0.6.0 Phase 1)

A task summary record can carry `workspace`: a short label of the folder the task ran in. It exists to **associate and search** tasks. It is **not a permission**: a matching label never makes a task visible to anyone, and no server may use it as the only condition for showing a task.

## How the label is made (`src/core/workspace-id.ts`)

1. The configured workspace folder is resolved with `realpath` (symbolic links and junctions are followed; the file system's own letter case is used). `\` becomes `/`, a trailing `/` is dropped, and a Windows drive letter is written in capitals.
2. The text is hashed with HMAC-SHA256. The key is 32 random bytes in `<data folder>/workspace-id.key` (file mode 600 where the OS supports it), created the first time a task record is written.
3. The first 16 hex characters are kept: `ws1:0123456789abcdef`.

| Question | Answer |
| --- | --- |
| Windows, macOS, Linux paths | One canonical text per real folder, whatever way the path was typed (`C:\x`, `c:/x/`, `x/../x`, a link). Tested on Windows in CI together with macOS and Linux. |
| Letter case | The file system's real case is used, so a case-insensitive volume gives one label. On a case-sensitive volume `A` and `a` are different folders and get different labels. |
| Folder moved or renamed | A new label. Old tasks keep the old one and read as `OTHER`. Nothing tracks moves. |
| Folder cannot be resolved | No label (UNKNOWN). |
| Old history | No `workspace` field. It reads as `UNKNOWN` and is **never filled in afterwards**, even when the current folder looks the same. |
| Format change | The field is optional. v0.4.x / v0.5.x readers ignore it; history written before is read unchanged. |
| Can the label reveal the path? | Not by guessing: without the key a guess such as `C:/Users/<name>/project` cannot be checked against it. Anyone who has the key file and the label can test guesses, so the key stays in the data folder and is not copied into reports. The label is cut to 64 bits and is no fingerprint of the key. |
| Can two folders collide? | Possible in theory (64 bits), which is one more reason it cannot grant access. |

## Where it is used

- The MCP `ornelyon_recent_tasks` rows show `workspace: SAME | OTHER | UNKNOWN`, compared with the folder the server is configured for. The label itself is never sent. A read-only caller never creates the key; without a key the answer is `UNKNOWN`.
- Nothing else reads it. In particular it is not part of the MCP scope check (see DYNAMIC_SCOPE_DESIGN.md).

## What it does not do

- It does not prove who started a task or which client asked. Any process of the same OS user can run a task in the same folder.
- It does not verify that files in the folder are unchanged; passports and Evidence Gate do that.
- It is not removed or rewritten when a folder is renamed.
