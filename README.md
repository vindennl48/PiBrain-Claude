# PiBrain for Claude

A personal knowledge base that Claude agents search before they guess and write to
when they learn something. It is an MCP server (one file, no dependencies) in front
of a Postgres database reached over [PostgREST](https://postgrest.org).

The point: facts about *your* setup that have no other home — how the network is
wired, what broke last time and why, what was decided — live in one place that every
Claude session can query on demand instead of carrying in its context.

```
Claude (Code tab / Chat / Cowork)
   │  MCP over stdio (newline-delimited JSON-RPC)
   ▼
server.mjs            ← this repo. Shapes requests, renders text. No state.
   │  HTTPS/HTTP + X-API-Key header
   ▼
reverse proxy         ← checks the key, strips the path prefix   (yours to provide)
   ▼
PostgREST             ← turns tables, views and functions into REST (yours to provide)
   ▼
Postgres              ← schema.sql. Every rule that matters lives here.
```

**This repo ships the top box and the schema for the bottom one.** The proxy,
PostgREST and Postgres are infrastructure you run yourself; the sections below say
exactly what they need to do.

> **Adapting this for your own setup?** Read [Setup](#setup) and then
> [What to change for your setup](#what-to-change-for-your-setup). The defaults in
> `server.mjs` (endpoints, domain list, wording) are the author's and will not work
> for anyone else as-is.

## What is in the repo

| File | What it is |
|---|---|
| `server.mjs` | The MCP server. Plain Node, no dependencies, no build step. |
| `schema.sql` | The whole database: tables, views, functions. Apply once to an empty database. |
| `manifest.json` | Desktop-extension manifest, used to build `pibrain.mcpb` for the Claude desktop app. |
| `.mcpbignore` | Files left out of the extension bundle. |

## Requirements

- Node 18 or newer (built-in `fetch`), on the machine where Claude runs.
- Postgres 14 or newer.
- PostgREST 11 or newer.
- Something in front of PostgREST that checks an API key (Caddy, nginx, Traefik…).

## Setup

### 1. Database

Create an empty database and a role that owns it, then apply the schema **as that
role**:

```bash
psql -v ON_ERROR_STOP=1 -U brain -d brain -f schema.sql
```

Before applying, edit the `insert into category` block in `schema.sql` to your own
domains (see [Domains](#domains)). You can also add domains later with a plain
`insert into category`.

### 2. PostgREST

Point PostgREST at that database. The server sends **no JWT**, so every request runs
as PostgREST's anonymous role — set that to the role that owns the schema:

```bash
PGRST_DB_URI=postgres://brain:<db-password>@postgres:5432/brain
PGRST_DB_SCHEMAS=public
PGRST_DB_ANON_ROLE=brain
```

Because the anonymous role can write, **PostgREST must not be reachable directly** —
only through the proxy in the next step. Keep it on an internal network.

After any schema change, reload PostgREST's cache or new objects return 404:

```sql
notify pgrst, 'reload schema';
```

(`schema.sql` already ends with this.)

### 3. Reverse proxy with an API key

The server authenticates with one header, `X-API-Key`. PostgREST ignores that header,
so the proxy is what enforces it. It must:

1. reject any request whose `X-API-Key` does not match, with `401`;
2. strip the path prefix, so `GET /brain/memory` reaches PostgREST as `GET /memory`;
3. pass everything else through untouched (PostgREST sets its own CORS headers).

A Caddy sketch of that (an illustration, not copied from a live config):

```
:8080 {
	handle_path /brain/* {
		@nokey not header X-API-Key {$BRAIN_API_KEY}
		respond @nokey 401
		reverse_proxy postgrest:3000
	}
}
```

The resulting base URL — here `http://<host>:8080/brain` — is what goes in
`PIBRAIN_ENDPOINTS`.

Prefer real PostgREST JWT auth instead? Change the `headers` object in `request()` in
`server.mjs` to send `Authorization: Bearer <token>` and give the JWT role the grants
listed at the bottom of `schema.sql`. Nothing else depends on the key.

### 4. Check the API by hand

```bash
export BASE=http://<host>:8080/brain
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/toc"
```

That must print `401`. With the key it must return your domains:

```bash
curl -s -H "X-API-Key: $BRAIN_API_KEY" "$BASE/toc?select=domain,n&order=sort"
```

And search must answer (an empty array `[]` is correct on an empty database):

```bash
curl -s -X POST -H "X-API-Key: $BRAIN_API_KEY" -H 'Content-Type: application/json' -d '{"p_query":"test"}' "$BASE/rpc/memory_search"
```

### 5. Give the server its key and endpoints

| Variable | Meaning |
|---|---|
| `BRAIN_API_KEY` | The API key. Read from the environment; if unset, from a `BRAIN_API_KEY=...` or `export BRAIN_API_KEY=...` line in `~/.zshenv`. The fallback exists because a GUI-launched app does not source the shell. Never stored in Claude's config or in this repo. |
| `PIBRAIN_ENDPOINTS` | Comma-separated base URLs, tried in order, e.g. `http://192.168.0.10:8080/brain,https://api.example.com/brain`. The first one that answers is kept for the session; a connection failure or 8-second timeout moves on to the next. An HTTP error is *not* retried elsewhere. **Unset means the author's endpoints**, which you cannot reach. |
| `PIBRAIN_MEMORY` | `off` disables every tool. `readonly` disables the three that write. Anything else, or unset, is fully on. |

Listing a LAN address first and a public one second gives fast access at home and
working access away from it.

### 6. Register with Claude Code (CLI and the desktop app's Code tab)

```bash
claude mcp add --scope user --env PIBRAIN_ENDPOINTS=http://<host>:8080/brain pibrain -- node /absolute/path/to/server.mjs
```

`--scope user` makes it available in every project. The path is absolute, so moving
the folder means re-registering. Remove it with:

```bash
claude mcp remove pibrain -s user
```

Smoke-test the server without Claude — this must print a JSON line listing seven
tools:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node server.mjs
```

### 7. Desktop extension (Chat and Cowork tabs)

The Code tab uses the registration above. The rest of the desktop app needs the
extension bundle. Set your endpoints in `manifest.json` first:

```json
"mcp_config": {
  "command": "node",
  "args": ["${__dirname}/server.mjs"],
  "env": { "PIBRAIN_ENDPOINTS": "http://<host>:8080/brain" }
}
```

Then build it:

```bash
npx -y @anthropic-ai/mcpb pack . pibrain.mcpb
```

Open `pibrain.mcpb` with Claude, or use Settings → Extensions → Advanced settings →
Install Extension. The installed extension is a **copy**: rebuild and reinstall after
changing `server.mjs` or `manifest.json`.

The key still comes from `BRAIN_API_KEY` or `~/.zshenv`. `manifest.json` declares
`"platforms": ["darwin"]` because that fallback is macOS/zsh-shaped; on another
platform, add your platform there and supply the key through the environment the
app is launched with. Do not put the key in `manifest.json` if the file is committed.

## What to change for your setup

Everything setup-specific is in these places. An agent retrofitting this should work
through the list top to bottom.

| # | Where | What | Required? |
|---|---|---|---|
| 1 | `PIBRAIN_ENDPOINTS` (env) | Your API base URL(s). Or edit `DEFAULT_ENDPOINTS` in `server.mjs`. | Yes |
| 2 | `BRAIN_API_KEY` (env or `~/.zshenv`) | Your key. | Yes |
| 3 | `schema.sql`, `insert into category` | Your domain vocabulary. | Yes |
| 4 | `server.mjs`, `DOMAINS` constant | The same domain list, comma-separated. It is quoted in tool parameter descriptions. | Yes |
| 5 | `server.mjs`, `INSTRUCTIONS` | First paragraph names the domains and what they cover; the "SEARCH FIRST" paragraph names the kinds of thing to look up (IPs, host names, tunnel IDs). Rewrite for your setup. Keep the whole block under about 2,000 characters — clients truncate longer ones. | Yes |
| 6 | `server.mjs`, `memory_search` tool `description` | Names the author's stack (Cloudflare, Proxmox, Tailscale, pi…). | Yes |
| 7 | `server.mjs`, error text in `apiKey()` | Says where the author's key is stored. | Cosmetic |
| 8 | `manifest.json` | `description`, `long_description`, `author`, and `env` (step 7 above). | If you build the extension |
| 9 | `server.mjs`, `RESTORE_HINT` | Mentions the author's operator tools (`/memory restore`, `scripts/memory.py`), which are not in this repo. Point it at `POST /rpc/memory_restore_row` instead. | Cosmetic |

Items 3–6 must agree with each other: `memory.domain` is a foreign key to `category`,
so an agent told about a domain that is not in the table gets an HTTP 409 when it
tries to store a row there.

Renaming the project (server name `pibrain`, tool prefix `memory_`) is optional and
purely textual: `serverInfo.name` in `server.mjs`, `name` in `manifest.json`, and the
name you pass to `claude mcp add`.

## How agents learn about it

On connect, the server returns an `instructions` string (`INSTRUCTIONS` in
`server.mjs`). Claude places that text in every session's context, so each agent knows
what the knowledge base is, when to search it and when to write to it, with no
per-project configuration. This block is the main lever on agent behaviour — more so
than the tool descriptions — which is why item 5 above matters.

It tells agents to:

- **search first** — before a web search, and before guessing an address, host name
  or path;
- **save as it happens** — when a problem is resolved, when something had to be
  looked up, when a decision is made whose reason is not in the code;
- never store a credential value, only where it lives.

## Tools

| Tool | Writes? | Job |
|---|---|---|
| `memory_search(query, domain?, kind?, limit?)` | no | Ranked hits as one-line previews with ids. |
| `memory_list(domain?, kind?, limit?)` | no | No arguments: the domain index. Otherwise the rows of a domain and/or kind. |
| `memory_load(id, reveal?)` | no | One row in full. Ask-first rows need `reveal: true`. Flags superseded and retracted rows. |
| `memory_recent(project?, days?, limit?)` | no | Recent session outcomes, newest first. |
| `memory_add(claim, domain, kind, body?, evidence?, project?, sensitivity?, label?)` | yes | Store one row. |
| `memory_correct(operation, target_id, rationale, …)` | yes | `replace` a stale row or `remove` one that was never true. |
| `memory_session_end(outcome, project?, open_questions?)` | yes | Record a one-line outcome for the session. Calling it again updates the same entry. |

Plus one MCP prompt, `sweep`: "review this session and record anything worth keeping".
Claude Code offers it as a slash command under the `pibrain` server.

## Data model

One claim per row. The vocabulary is small and fixed so rows can be filtered before
they are read into context.

| Column | Meaning |
|---|---|
| `domain` | Which area this belongs to. Must exist in `category`. |
| `kind` | `fact`, `practical`, `gotcha`, `decision`, `procedure` or `history`. |
| `claim` | One sentence. The thing search previews show. |
| `body` | Optional supporting detail. Searched along with the claim. |
| `evidence` | Where it came from: a path, command, URL, commit. |
| `project` | Optional project slug. |
| `sensitivity` | `open` (default) or `ask-first`. |
| `label` | Safe title for an ask-first row. Required for those, enforced by a constraint. |
| `observed_at` | When it was recorded. Rows older than about six months are shown with a "verify" note. |
| `superseded_by` | Set when a `replace` created a newer row. |
| `retracted_at/_by/_reason` | Set when a `remove` withdrew the row. |
| `created_by` | The server writes `agent`. |

The rules, all enforced in the database rather than in `server.mjs`:

- **Nothing is deleted.** `replace` inserts a new row and points the old one at it;
  `remove` sets `retracted_at`. Both rows stay in the table. Undo a removal with
  `POST /rpc/memory_restore_row {"p_id": <id>}`.
- **Ask-first rows are invisible to search and browse.** The `memory_open` view and
  the `memory_search` function exclude them in SQL. Agents see only `label`, via the
  `memory_locked` view, and must call `memory_load(id, reveal: true)` to read one.
  Use this for credential *locations* and infrastructure identifiers. Never store a
  credential value at all.
- **Search ranks by match, not date.** Each word also matches as a prefix (`proxm`
  finds `Proxmox`). A row matching the whole query outranks one matching part of it.
- **Corrections are audited.** Every `memory_correct` writes a `proposal` row
  recording the rationale, in the same transaction as the change.

### Domains

A domain is a row in `category`: a short name, a description written for an agent
deciding whether the domain is relevant, and a sort order. Aim for ten to twenty. To
add one later:

```sql
insert into category (domain, description, sort) values ('printers', '3D printer profiles, firmware and failure notes.', 40);
```

then add it to `DOMAINS` and `INSTRUCTIONS` in `server.mjs`.

## API contract

Every request `server.mjs` makes. Paths are relative to an endpoint base URL. All
carry `X-API-Key` and `Content-Type: application/json`. If you replace PostgREST with
something else, this table is the interface to reproduce.

| Tool | Request | Notes |
|---|---|---|
| `memory_search` | `POST /rpc/memory_search` body `{p_query, p_domain, p_kind, p_limit}` | Returns `[{id, domain, kind, claim, observed_at, pending_change_op, score, strict_match}]`. |
| | `GET /memory_locked?select=id,kind,label&domain=eq.<d>&order=id` | Only when a domain was given: lists ask-first labels. |
| | `GET /memory_locked?select=id` | Only when no domain was given and results were thin: a count. |
| `memory_list` | `GET /toc?select=domain,description,n&order=sort` | No arguments. |
| | `GET /memory_open?select=id,kind,claim,observed_at,pending_change_op&domain=eq.<d>&kind=eq.<k>&order=kind,pending_change_op.asc.nullsfirst,observed_at.desc&limit=<n>` | With a domain and/or kind. |
| `memory_load` | `GET /memory?id=eq.<id>&select=*` | The base table, so ask-first rows are reachable; the server withholds them unless `reveal` is set. |
| | `GET /memory?id=eq.<superseded_by>&select=id,claim,observed_at` | Follows a supersede link. |
| `memory_recent` | `GET /session_summary?select=project,outcome,ended_at,open_questions&project=eq.<p>&ended_at=gte.<iso>&order=ended_at.desc.nullslast&limit=<n>` | |
| `memory_add` | `POST /memory` with `Prefer: return=representation`, body `{domain, kind, sensitivity, label, claim, body, evidence, project, created_by: "agent"}` | Returns the stored row in an array. |
| `memory_correct` | `POST /rpc/memory_correct` body `{p_operation, p_target_id, p_rationale, p_domain, p_kind, p_claim, p_body, p_evidence, p_project, p_sensitivity, p_label}` | Returns `{message, previous_claim, row, …}`. On a replace, a `null` body/evidence/project keeps the old value; `""` clears it. |
| `memory_session_end` | `POST /session_summary?on_conflict=session_file` with `Prefer: resolution=merge-duplicates,return=minimal`, body `{session_file, project, ended_at, outcome, open_questions, source: "agent"}` | An upsert. `session_file` is `claude:<cwd>:<start time>:<pid>` — one key per server process, which is one Claude session. |

Error handling: a non-2xx response is returned to the agent as a tool error carrying
PostgREST's `message` field, so database `raise exception` text (for example "Row 12
was already superseded by [15]") reaches the agent verbatim.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `PiBrain unreachable. Tried …` | No endpoint answered within 8 seconds. Check `PIBRAIN_ENDPOINTS`; the message lists what was tried. |
| `BRAIN_API_KEY is not set …` | Not in the environment and no matching line in `~/.zshenv`. Desktop apps do not inherit your shell's environment. |
| `PiBrain HTTP 401` | The proxy rejected the key. |
| `PiBrain HTTP 404` on a tool that used to work, or right after applying the schema | PostgREST's schema cache is stale: `notify pgrst, 'reload schema';` |
| `PiBrain HTTP 409` from `memory_add` | The domain is not in `category`. |
| `PiBrain HTTP 400` from `memory_add` | A check constraint: unknown `kind`, or an ask-first row with no `label`. |
| Tools missing in the desktop app's Chat tab but present in the Code tab | They are separate installs: the Code tab uses `claude mcp add`, the rest uses the `.mcpb` extension. |
| Edited `server.mjs` but the desktop app behaves the same | The installed extension is a copy. Rebuild and reinstall it. |
| Agents do not search unprompted | `INSTRUCTIONS` does not describe your setup, or exceeds roughly 2,000 characters and was truncated. |

## Background

This is the Claude counterpart of a private extension the author wrote for the pi
coding agent; both are clients of the same database, which is why the rules live in
SQL rather than in either client. A few traces of that remain and are harmless:

- The author's database was built up through a series of migrations. `schema.sql` is
  a consolidated copy of their final state, tested on a clean database.
- The `pending_change_*` columns and the `proposal` table's `pending` status support
  a human-approval queue that this server does not use. It only displays a `DISPUTED`
  marker if another client sets one.
- `session_summary.source` distinguishes `agent` rows (written by
  `memory_session_end`) from `transcript` rows (derived by a script that is not part
  of this repo).

No dependencies, no build step, no telemetry.
