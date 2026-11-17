# PiBrain for Claude

The Claude counterpart of the pi extension at `~/Documents/code/PiBrain/extensions/brain.ts`:
an MCP server that gives Claude agents the same seven tools over the same PostgREST API.

| Tool | Job |
|---|---|
| `memory_search` | find facts; previews with ids |
| `memory_list` | browse by domain / kind |
| `memory_load` | one row in full (`reveal: true` for ask-first rows) |
| `memory_recent` | recent session outcomes |
| `memory_add` | store a new row |
| `memory_correct` | `replace` a stale row or `remove` one that was never true |
| `memory_session_end` | record a one-line session outcome |

Plus one prompt, `sweep` (the equivalent of pi's bare `/memory`), offered by Claude Code as a
slash command under the `pibrain` server.

## How agents learn about it

The server returns an `instructions` block when a session connects. Claude puts that text in
every session's context, so each agent knows what PiBrain is, when to search it and when to
write, without any per-project setup. Edit `INSTRUCTIONS` in `server.mjs` to change it
(keep it under about 2,000 characters).

## Install

Already registered at user scope (all projects) in `~/.claude.json`:

```bash
claude mcp add --scope user pibrain -- /opt/homebrew/bin/node "/Users/mitch/Documents/code/Claude Plugins/PiBrain/server.mjs"
```

Remove with `claude mcp remove pibrain -s user`. The path is absolute, so moving this folder
means re-registering.

## Configuration

- `BRAIN_API_KEY` — read from the environment, else from `~/.zshenv`. Never stored in Claude's config.
- `PIBRAIN_MEMORY` — `off` disables every tool, `readonly` disables the three that write.
  Set it with `--env PIBRAIN_MEMORY=readonly` when registering.

## Differences from the pi extension

- No `/mo` toggle or `/memory undo|retract|restore`: those are operator commands. Retracted
  rows are restored from pi or with `PiBrain/scripts/memory.py restore <id>`.
- `memory_session_end` has no pi session file to key on, so it uses one key per server
  process (`claude:<cwd>:<start time>:<pid>`).
- Rows are written with `created_by: "agent"`, the same as pi, so pi's `/memory undo` finds them.

No dependencies and no build step; needs Node 18+.
