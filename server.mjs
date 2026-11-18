#!/usr/bin/env node
/**
 * PiBrain for Claude — an MCP server exposing the same seven memory_* tools as
 * the pi extension (~/Documents/code/PiBrain/extensions/brain.ts).
 *
 * It is a second client of the same PostgREST API, not a fork of the store:
 * every rule that matters (ask-first rows hidden by the `memory_open` view,
 * search ranking, supersede/retract instead of delete) lives in the database,
 * so both clients inherit it. This file only shapes requests and renders text.
 *
 * No dependencies: MCP over stdio is newline-delimited JSON-RPC, and Node 18+
 * has fetch built in.
 *
 * Environment:
 *   BRAIN_API_KEY   the PostgREST key. If unset, it is read from ~/.zshenv,
 *                   because a GUI-launched app does not source the shell.
 *   PIBRAIN_ENDPOINTS  comma-separated API base URLs, tried in order. Unset
 *                   means the author's own endpoints (see ENDPOINTS below).
 *   PIBRAIN_MEMORY  "off" disables every tool; "readonly" disables the three
 *                   that write. Anything else (or unset) is fully on.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const VERSION = "0.3.0";

/**
 * Base URLs of the PostgREST API, tried in order; the first that answers is
 * kept for the rest of the session. PIBRAIN_ENDPOINTS (comma-separated)
 * replaces the defaults, which are the author's own: LAN first, because the
 * Cloudflare Tunnel adds a round trip, so it is the fallback.
 */
const DEFAULT_ENDPOINTS = ["http://192.168.1.4:8080/brain", "https://api.mitchwoodbine.com/brain"];
const ENDPOINTS = (() => {
  const fromEnv = (process.env.PIBRAIN_ENDPOINTS ?? "")
    .split(",")
    .map((e) => e.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : DEFAULT_ENDPOINTS;
})();
const TIMEOUT_MS = 8000;
const PREVIEW_CHARS = 160;
const KINDS = ["fact", "practical", "gotcha", "decision", "procedure", "history"];
const DOMAINS =
  "infra, cloudflare, postgres, proxmox, tailscale, pi, mynotes, pimind, pedals, macapps, websites, excel, coding, agent-memory";

const MODE = (() => {
  const raw = (process.env.PIBRAIN_MEMORY ?? "").trim().toLowerCase();
  if (["off", "disabled", "0", "false", "no"].includes(raw)) return "off";
  if (["readonly", "read-only", "ro"].includes(raw)) return "readonly";
  return "on";
})();

/** One key per server process, which is one Claude session: upserts stay idempotent. */
const SESSION_KEY = `claude:${process.cwd()}:${new Date().toISOString()}:${process.pid}`;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

let cachedKey = null;
function apiKey() {
  if (cachedKey) return cachedKey;
  let key = process.env.BRAIN_API_KEY;
  if (!key) {
    try {
      const text = readFileSync(join(homedir(), ".zshenv"), "utf8");
      const m = text.match(/^\s*(?:export\s+)?BRAIN_API_KEY=(.*)$/m);
      if (m) key = m[1].trim().replace(/^(['"])(.*)\1$/, "$2");
    } catch {
      // No ~/.zshenv — fall through to the error below.
    }
  }
  if (!key) {
    throw new Error(
      "BRAIN_API_KEY is not set and was not found in ~/.zshenv. The value is in " +
        "/opt/postgres/projects/brain/credentials on docker.local.",
    );
  }
  return (cachedKey = key);
}

let preferred = null;
async function request(path, init = {}) {
  const key = apiKey();
  const order = preferred ? [preferred, ...ENDPOINTS.filter((e) => e !== preferred)] : [...ENDPOINTS];

  let lastError;
  for (const base of order) {
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        ...init,
        headers: { "X-API-Key": key, "Content-Type": "application/json", ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      lastError = err; // transport failure: try the next endpoint
      continue;
    }
    // A response means the endpoint works; an HTTP error is a real error.
    preferred = base;
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed?.message === "string") detail = parsed.message;
      } catch {
        // not JSON
      }
      throw new Error(`PiBrain HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  }
  throw new Error(`PiBrain unreachable. Tried ${order.join(", ")}. Last error: ${String(lastError)}`);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const clip = (s, n = PREVIEW_CHARS) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const age = (iso) => {
  if (!iso) return "undated";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return "today";
  if (days < 45) return `${days}d ago`;
  if (days < 180) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 30)}mo ago (verify before relying on it)`;
};

function formatStoredRow(row) {
  if (!row) return "(the server returned no row — check the row id and try again)";
  const lines = [
    `id:          ${row.id}`,
    `domain:      ${row.domain}`,
    `kind:        ${row.kind}`,
    `sensitivity: ${row.sensitivity}`,
    `project:     ${row.project ?? "—"}`,
    `observed_at: ${String(row.observed_at).slice(0, 10)} (${age(row.observed_at)})`,
    `created_by:  ${row.created_by ?? "—"}`,
  ];
  if (row.label) lines.push(`label:       ${row.label}`);
  lines.push("", `claim: ${row.claim}`);
  if (row.body) lines.push("", `body:\n${row.body}`);
  if (row.evidence) lines.push("", `evidence: ${row.evidence}`);
  return lines.join("\n");
}

const RESTORE_HINT = "the operator can restore it with pi's `/memory restore <id>` or `scripts/memory.py restore <id>`";

function lockedRows(domain) {
  return request(`/memory_locked?select=id,kind,label&domain=eq.${encodeURIComponent(domain)}&order=id`);
}

function checkSensitivity(args, needLabel) {
  const sensitivity = args.sensitivity ?? "open";
  if (sensitivity !== "open" && sensitivity !== "ask-first") {
    throw new Error(`Unknown sensitivity '${sensitivity}'. Expected 'open' or 'ask-first'.`);
  }
  if (needLabel && sensitivity === "ask-first" && !args.label?.trim()) {
    throw new Error(
      "A label is required for an ask-first row: a safe, non-sensitive title that future agents " +
        "can read in place of the withheld claim.",
    );
  }
  return sensitivity;
}

function checkKind(kind) {
  if (kind && !KINDS.includes(kind)) {
    throw new Error(`Unknown kind '${kind}'. Expected one of: ${KINDS.join(", ")}.`);
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });

const TOOLS = [
  {
    name: "memory_search",
    title: "Memory Search",
    write: false,
    description:
      "Search the PiBrain personal knowledge base for facts about this user's setup: the home network, " +
      "Cloudflare, the Postgres/PostgREST stack, Proxmox, Tailscale, pi itself, and the individual " +
      "projects. Use it FIRST — before a web search, and before guessing an IP address, host name, " +
      "tunnel ID or server path — whenever a task hits an error or an unknown, and when the user says " +
      "they have done this before. Use the web alongside it when memory is thin or old. Ranked by how much of the " +
      "query each row matches, not by date. Returns short previews; use memory_load to read one in full.",
    inputSchema: {
      type: "object",
      properties: {
        query: str(
          "What to look for. Natural phrases work. A partial word matches any word starting with it, so `proxm` finds `Proxmox`.",
        ),
        domain: str(`Narrow to one domain: ${DOMAINS}.`),
        kind: str(`Narrow by type: ${KINDS.join(", ")}.`),
        limit: num("Max hits, default 8."),
      },
      required: ["query"],
    },
    async run(a) {
      const limit = Math.min(Math.max(a.limit ?? 8, 1), 25);
      const rows = await request(`/rpc/memory_search`, {
        method: "POST",
        body: JSON.stringify({
          p_query: a.query,
          p_domain: a.domain ?? null,
          p_kind: a.kind ?? null,
          p_limit: limit,
        }),
      });

      const relaxed = rows.length > 0 && rows.every((r) => !r.strict_match);
      // Ask-first rows are never searchable, but an agent has to be able to
      // learn they exist. Only the safe label is exposed, never the claim.
      const locked = a.domain ? await lockedRows(a.domain) : [];
      const hiddenCount =
        !a.domain && (rows.length < 2 || relaxed) ? (await request(`/memory_locked?select=id`)).length : 0;

      const lockedNote =
        locked.length > 0
          ? `\n\n${locked.length} ask-first row${locked.length === 1 ? "" : "s"} also exist in this domain and are not searchable:\n` +
            locked.map((l) => `  [${l.id}] ${l.label}`).join("\n") +
            `\nRead one with memory_load(<id>, reveal: true) only if the task genuinely needs it.`
          : hiddenCount > 0
            ? `\n\n${hiddenCount} ask-first row${hiddenCount === 1 ? "" : "s"} exist and are never searchable.` +
              ` If one of those is what you need, repeat the search passing \`domain\` to see their labels` +
              `, then memory_load(<id>, reveal: true).`
            : "";

      if (rows.length === 0) {
        return (
          `No hits for "${a.query}"` +
          (a.domain ? ` in domain ${a.domain}` : "") +
          `.\nTry a broader query, or memory_list() to see the domains available.` +
          lockedNote
        );
      }

      const lines = rows.map(
        (r) =>
          `[${r.id}] ${r.domain}/${r.kind} · ${age(r.observed_at)}` +
          (r.pending_change_op ? `  ⚠ DISPUTED (${r.pending_change_op} proposed)` : "") +
          `\n    ${clip(r.claim)}`,
      );
      const disputed = rows.filter((r) => r.pending_change_op).length;
      const disputedNote =
        disputed > 0
          ? `\n\n${disputed} of these ${disputed === 1 ? "is" : "are"} disputed — carrying an old correction marker. ` +
            `Do not rely on a disputed row; memory_load(<id>) shows the case.`
          : "";

      return (
        `${rows.length} hit${rows.length === 1 ? "" : "s"} for "${a.query}":\n\n` +
        lines.join("\n") +
        (relaxed ? `\n\nNo row matched the whole query, so these are ranked by how much of it they match.` : "") +
        disputedNote +
        `\n\nRead one in full with memory_load(<id>).` +
        lockedNote
      );
    },
  },

  {
    name: "memory_list",
    title: "Memory List",
    write: false,
    description:
      "Browse the PiBrain knowledge base by domain rather than by search. With no arguments, lists the " +
      "domains and what each covers. With a domain, lists its rows. A kind may be given on its own " +
      "(every gotcha, across the whole store) or alongside a domain.",
    inputSchema: {
      type: "object",
      properties: {
        domain: str("Domain to list. Omit to list all domains."),
        kind: str(`Filter by kind: ${KINDS.join(", ")}.`),
        limit: num("Max rows, default 30."),
      },
    },
    async run(a) {
      if (!a.domain && !a.kind) {
        const cats = await request(`/toc?select=domain,description,n&order=sort`);
        return (
          "PiBrain domains (rows in brackets):\n\n" +
          cats.map((c) => `  ${c.domain} [${c.n}]\n    ${c.description}`).join("\n") +
          "\n\nUse memory_list(<domain>) to browse one, or memory_search(<query>) to find something specific."
        );
      }

      const limit = Math.min(Math.max(a.limit ?? 30, 1), 100);
      const filters = [];
      if (a.domain) filters.push(`domain=eq.${encodeURIComponent(a.domain)}`);
      if (a.kind) filters.push(`kind=eq.${encodeURIComponent(a.kind)}`);
      const scope = [a.domain ?? "all domains", a.kind ?? null].filter((p) => p !== null).join(" · ");

      const rows = await request(
        `/memory_open?select=id,kind,claim,observed_at,pending_change_op` +
          (filters.length > 0 ? `&${filters.join("&")}` : "") +
          `&order=kind,pending_change_op.asc.nullsfirst,observed_at.desc&limit=${limit}`,
      );
      // Fetched before the empty check: a domain whose rows are all ask-first
      // must not answer "Nothing stored".
      const locked = a.domain ? await lockedRows(a.domain) : [];
      const lockedNote =
        locked.length > 0
          ? `\n\nAsk-first rows in this domain (claim withheld; ${locked.length}):\n` +
            locked.map((l) => `  [${l.id}] ${l.kind} — ${l.label}`).join("\n")
          : "";

      if (rows.length === 0) return `Nothing stored for ${scope} yet.` + lockedNote;

      return (
        `${scope}: ${rows.length} row${rows.length === 1 ? "" : "s"}\n\n` +
        rows
          .map(
            (r) =>
              `[${r.id}] ${r.kind} · ${age(r.observed_at)}` +
              (r.pending_change_op ? `  ⚠ DISPUTED (${r.pending_change_op})` : "") +
              `\n    ${clip(r.claim)}`,
          )
          .join("\n") +
        lockedNote
      );
    },
  },

  {
    name: "memory_load",
    title: "Memory Load",
    write: false,
    description:
      "Read one PiBrain knowledge base row in full, including its body, evidence and whether it was " +
      "superseded or retracted. Rows marked ask-first are withheld unless reveal is set.",
    inputSchema: {
      type: "object",
      properties: {
        id: num("Row id from memory_search or memory_list."),
        reveal: {
          type: "boolean",
          description:
            "Set true to return an ask-first row (credentials locations, infrastructure identifiers). Only when the task genuinely needs it.",
        },
      },
      required: ["id"],
    },
    async run(a) {
      const id = Number(a.id);
      if (!Number.isInteger(id) || id <= 0) throw new Error("id must be a positive integer.");
      const rows = await request(`/memory?id=eq.${id}&select=*`);
      if (rows.length === 0) return `No row with id ${id}.`;
      const row = rows[0];

      if (row.sensitivity === "ask-first" && !a.reveal) {
        return (
          `Row [${row.id}] in ${row.domain} is marked ask-first and is withheld from search and browse.\n\n` +
          `Subject: ${row.label ?? "(unlabelled)"}\n\n` +
          `Call memory_load again with reveal: true if the task genuinely needs it.`
        );
      }

      // Follow the chain forward so a superseded row is never mistaken for current.
      const successor = row.superseded_by
        ? await request(`/memory?id=eq.${row.superseded_by}&select=id,claim,observed_at`)
        : [];

      // "Not current" notices go ABOVE the claim they warn about.
      const notices = [];
      if (row.retracted_at) {
        notices.push(
          `⚠ This row was RETRACTED on ${String(row.retracted_at).slice(0, 10)}` +
            ` by ${row.retracted_by ?? "unknown"} — ${row.retracted_reason ?? "(no reason recorded)"}.`,
          `Do not rely on it. It is gone from search and browse but still in the table; ${RESTORE_HINT}.`,
        );
      }
      if (successor.length > 0) {
        notices.push(`⚠ This row has been SUPERSEDED by [${successor[0].id}]: ${successor[0].claim}`);
      }

      const parts = [
        `[${row.id}] ${row.domain}/${row.kind}${row.sensitivity === "ask-first" ? " · ASK-FIRST" : ""}`,
        `Observed: ${row.observed_at} (${age(row.observed_at)})`,
        row.project ? `Project: ${row.project}` : null,
        row.label ? `Subject: ${row.label}` : null,
        row.created_by ? `Written by: ${row.created_by}` : null,
        ...(notices.length > 0 ? ["", ...notices] : []),
        "",
        row.claim,
      ];
      if (row.body) parts.push("", row.body);
      if (row.evidence) parts.push("", `Evidence: ${row.evidence}`);
      if (row.pending_change_op) {
        parts.push(
          "",
          `⚠ DISPUTED — ${row.pending_change_op} proposed by ${row.pending_change_by ?? "unknown"} ` +
            `on ${(row.pending_change_at ?? "").slice(0, 10)}.`,
          `The case: ${row.pending_change_reason ?? "(no reason recorded)"}`,
          `Do not rely on this row — the marker is older than the direct-write change.`,
        );
      }
      return parts.filter((p) => p !== null).join("\n");
    },
  },

  {
    name: "memory_recent",
    title: "Memory Recent",
    write: false,
    description:
      "Recent work history from PiBrain: one-line outcomes from past agent sessions (pi and Claude), " +
      "newest first. Useful for picking up a project after time away.",
    inputSchema: {
      type: "object",
      properties: {
        project: str("Limit to one project, e.g. mynotes."),
        days: num("Only sessions from the last N days. Default 30."),
        limit: num("Max entries, default 10."),
      },
    },
    async run(a) {
      const limit = Math.min(Math.max(a.limit ?? 10, 1), 40);
      const days = a.days ?? 30;
      const filters = [];
      if (a.project) filters.push(`project=eq.${encodeURIComponent(a.project)}`);
      filters.push(`ended_at=gte.${new Date(Date.now() - days * 86_400_000).toISOString()}`);

      const rows = await request(
        `/session_summary?select=project,outcome,ended_at,open_questions&${filters.join("&")}` +
          `&order=ended_at.desc.nullslast&limit=${limit}`,
      );
      if (rows.length === 0) {
        return `No session history in the last ${days} days` + (a.project ? ` for ${a.project}` : "") + `.`;
      }
      const lines = rows.map((r) => {
        const open = r.open_questions?.length > 0 ? `\n    open: ${r.open_questions.join("; ")}` : "";
        return `${r.ended_at?.slice(0, 10) ?? "?"} ${r.project ?? "-"}\n    ${r.outcome}${open}`;
      });
      return `Last ${days} days:\n\n${lines.join("\n")}`;
    },
  },

  {
    name: "memory_add",
    title: "Memory Add",
    write: true,
    description:
      "Store one fact in the PiBrain knowledge base immediately, without being asked. Use it the moment " +
      "a problem is resolved (the cause and the fix), something is learned that took a web search or would " +
      "need one again, or a decision is made whose reason would otherwise be lost. A row is worth storing " +
      "if it would save a future agent a search or a mistake. Skip what is obvious from the code or already " +
      "stored, and never store a credential value — store where it lives instead. The whole stored record is returned. " +
      "To correct or remove an existing row, use memory_correct instead.",
    inputSchema: {
      type: "object",
      properties: {
        claim: str("One sentence. A single atomic claim — if it takes two sentences, call memory_add twice."),
        domain: str(`One of the knowledge base domains: ${DOMAINS}.`),
        kind: str(`One of: ${KINDS.join(", ")}.`),
        body: str("Supporting detail, if the claim alone is not enough."),
        evidence: str("Where this came from: a file path, URL, commit or command."),
        project: str("Project slug, if this is project-specific."),
        sensitivity: str(
          "'open' (default) or 'ask-first' for credential locations and infrastructure identifiers. An ask-first row is hidden from search and requires a `label`.",
        ),
        label: str(
          "Required when sensitivity is ask-first: a safe, non-sensitive title. Never include the identifier itself.",
        ),
      },
      required: ["claim", "domain", "kind"],
    },
    async run(a) {
      checkKind(a.kind);
      const sensitivity = checkSensitivity(a, true);
      const created = await request(`/memory`, {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          domain: a.domain,
          kind: a.kind,
          sensitivity,
          label: a.label ?? null,
          claim: a.claim,
          body: a.body ?? "",
          evidence: a.evidence ?? null,
          project: a.project ?? null,
          // Same value the pi extension writes, so pi's `/memory undo` finds it.
          created_by: "agent",
        }),
      });
      const row = created?.[0];
      return `Stored [${row?.id}] in ${a.domain}/${a.kind}.\n\n${formatStoredRow(row)}`;
    },
  },

  {
    name: "memory_correct",
    title: "Memory Correct",
    write: true,
    description:
      "Correct or remove an existing PiBrain row, applying the change immediately. Two operations:\n" +
      "- replace: the row has GONE STALE. The corrected row supersedes it and the old one is kept.\n" +
      "- remove: the row was NEVER TRUE. It is retracted — hidden from search, kept in the table, and recoverable.\n" +
      "Most rows that look wrong are stale, not wrong, so prefer replace when the world changed. " +
      "Nothing is deleted, and the whole stored record comes back in the response. " +
      "On a replace, body, evidence and project are INHERITED from the row being replaced when you omit " +
      "them — pass an empty string to clear one deliberately. There is no approval step, so afterwards " +
      "state plainly in the conversation what you changed and why, naming the row ids.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["replace", "remove"], description: "'replace' (the row went stale) or 'remove' (the row was never true)." },
        target_id: num("The id of the row being corrected, from memory_search or memory_load."),
        rationale: str(
          "Required. For replace: what changed. For remove: why it was NEVER true — 'it is out of date' belongs in a replace.",
        ),
        domain: str("New domain. Required for replace."),
        kind: str(`New kind, one of: ${KINDS.join(", ")}. Required for replace.`),
        claim: str("The corrected claim, one sentence. Required for replace; ignored for remove."),
        body: str('Supporting detail. On a replace, omit it to keep the target row\'s body; pass "" to clear it.'),
        evidence: str('Where the claim came from. On a replace, omit it to keep the target row\'s evidence; pass "" to clear it.'),
        project: str('Project slug. On a replace, omit it to keep the target row\'s project; pass "" to clear it.'),
        sensitivity: str("'open' (default) or 'ask-first'. An ask-first row requires a `label`."),
        label: str(
          "Required when sensitivity is ask-first: a safe, non-sensitive title. Never include the identifier itself.",
        ),
      },
      required: ["operation", "target_id", "rationale"],
    },
    async run(a) {
      const operation = a.operation;
      if (operation !== "replace" && operation !== "remove") {
        throw new Error(`Unknown operation '${operation}'. Expected 'replace' or 'remove'.`);
      }
      if (!a.rationale?.trim()) throw new Error("rationale is required.");
      if (operation === "replace") {
        if (!a.claim?.trim()) throw new Error("claim is required for a replace — the corrected one-sentence claim.");
        if (!a.domain) throw new Error("domain is required for a replace.");
        if (!a.kind) throw new Error("kind is required for a replace.");
      }
      checkKind(a.kind);
      const sensitivity = checkSensitivity(a, operation === "replace");

      // One call, one transaction; the database validates the target and
      // raises before anything is written.
      const result = await request(`/rpc/memory_correct`, {
        method: "POST",
        body: JSON.stringify({
          p_operation: operation,
          p_target_id: a.target_id,
          p_rationale: a.rationale,
          p_domain: a.domain ?? null,
          p_kind: a.kind ?? null,
          p_claim: a.claim ?? null,
          p_body: a.body ?? null,
          p_evidence: a.evidence ?? null,
          p_project: a.project ?? null,
          p_sensitivity: sensitivity,
          p_label: a.label ?? null,
        }),
      });

      const was =
        result?.previous_claim && result.previous_claim !== result?.row?.claim
          ? `\n\nwas: ${result.previous_claim}`
          : "";
      const undo = operation === "remove" ? `\n\nRetracted, not deleted: ${RESTORE_HINT}.` : "";
      return `${result?.message}\n\n${formatStoredRow(result?.row)}${was}${undo}`;
    },
  },

  {
    name: "memory_session_end",
    title: "Memory Session End",
    write: true,
    description:
      "Record a one-line outcome for the current session in PiBrain so future sessions can see what was " +
      "worked on (it is what memory_recent returns). Calling it again in the same session updates the " +
      "same entry.",
    inputSchema: {
      type: "object",
      properties: {
        outcome: str("One sentence: what shipped, or what was decided. Not a list of steps."),
        project: str("Project slug."),
        open_questions: { type: "array", items: { type: "string" }, description: "Anything left unresolved." },
      },
      required: ["outcome"],
    },
    async run(a) {
      if (!a.outcome?.trim()) throw new Error("outcome is required.");
      await request(`/session_summary?on_conflict=session_file`, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          // The table is keyed on a pi session file. A Claude session has no
          // such file, so a per-process key stands in for it.
          session_file: SESSION_KEY,
          project: a.project ?? null,
          ended_at: new Date().toISOString(),
          outcome: a.outcome,
          open_questions: a.open_questions ?? [],
          // 'agent' rows are never rebuilt by scripts/summarize_sessions.py.
          source: "agent",
        }),
      });
      return "Session outcome recorded.";
    },
  },
];

const ACTIVE_TOOLS = MODE === "off" ? [] : MODE === "readonly" ? TOOLS.filter((t) => !t.write) : TOOLS;

// ---------------------------------------------------------------------------
// What every agent is told, whether or not it ever calls a tool.
// Kept short: clients cap server instructions at roughly 2 KB.
// ---------------------------------------------------------------------------

const INSTRUCTIONS =
  MODE === "off"
    ? "PiBrain (the user's personal knowledge base) is switched off for this session (PIBRAIN_MEMORY=off). Do not try to work around it."
    : [
        "PiBrain is the user's personal knowledge base: how their setup actually works. Domains: " +
          "infra (home network), cloudflare, postgres (the self-hosted Postgres/PostgREST stack), proxmox, " +
          "tailscale, pi, mynotes, pimind, pedals, macapps, websites, excel, coding, agent-memory.",
        "",
        "SEARCH FIRST: call memory_search unprompted before a web search or reading external docs, and " +
          "before guessing an IP, host name, tunnel ID, API path or server location. Do it whenever a task " +
          "touches those domains, hits an error or unknown, or the user says they've done this before. " +
          "A stored answer outranks a fresh web result for this setup; use the web alongside it when memory " +
          "is thin, old or silent. Search returns previews — memory_load(id) before relying on a row. " +
          "memory_list() shows the domains; memory_recent shows recent session outcomes. Rows older than " +
          "~6 months: re-verify infrastructure facts against the live system.",
        "",
        MODE === "readonly"
          ? "WRITE: disabled for this session (PIBRAIN_MEMORY=readonly). Say what needs recording and stop."
          : "SAVE as it happens, without being asked: memory_add whenever you resolve a problem (record the " +
            "cause and the fix), learn something you had to look up on the web or would otherwise look up " +
            "again, are corrected, or a decision is made whose reason isn't in the code. The test: would this " +
            "save a future agent a search or a mistake? One claim per row, with evidence (path, command, URL). " +
            "Skip what is obvious from the code and what is already stored; never a credential value (store " +
            "where it lives). memory_correct fixes a row: 'replace' if it went stale, 'remove' if it was never " +
            "true — it applies at once, nothing is deleted, so tell the user what you changed and the row ids. " +
            "memory_session_end records a one-line session outcome.",
        "",
        "Ask-first rows (credential locations, infrastructure identifiers) never appear in search; you see " +
          "only labels. Use memory_load(id, reveal: true) only when the task genuinely needs it, never speculatively.",
      ].join("\n");

const SWEEP_PROMPT = [
  "Review THIS session and record PiBrain knowledge-base entries for anything worth keeping: memory_add for a new row, memory_correct to replace a stale one or remove one that was never true.",
  "",
  "The bar:",
  "- Record a row only if a future agent would ACT DIFFERENTLY knowing it.",
  "- Reject anything discoverable by reading the code, and anything a linter, test or hook already enforces.",
  "- Never store a credential value. Store where it lives instead.",
  "- One claim per row. If it takes two sentences, record two rows.",
  "- For a row that should be withheld from search, set sensitivity 'ask-first' and supply a safe `label` that does not itself contain the identifier.",
  "- Recording NOTHING is the correct outcome for most sessions. Do not pad.",
  "",
  "Then call memory_session_end once with a single-sentence outcome for the session.",
  "",
  "Finish with one line: how many rows you recorded, or that you recorded none and why.",
].join("\n");

const PROMPTS =
  MODE === "on"
    ? [{ name: "sweep", title: "Memory sweep", description: "Sweep this session for knowledge-base rows worth recording in PiBrain." }]
    : [];

// ---------------------------------------------------------------------------
// MCP over stdio
// ---------------------------------------------------------------------------

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

async function handle(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: "pibrain", title: "PiBrain", version: VERSION },
        instructions: INSTRUCTIONS,
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: ACTIVE_TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: {
            title: t.title,
            readOnlyHint: !t.write,
            destructiveHint: false, // nothing is ever deleted: supersede or retract
            openWorldHint: false,
          },
        })),
      };
    case "tools/call": {
      const tool = ACTIVE_TOOLS.find((t) => t.name === params?.name);
      if (!tool) {
        const known = TOOLS.some((t) => t.name === params?.name);
        const why = known
          ? `${params.name} is disabled for this session (PIBRAIN_MEMORY=${MODE}). Say what needs recording and stop.`
          : `Unknown tool: ${params?.name}`;
        return { content: [{ type: "text", text: why }], isError: true };
      }
      try {
        const text = await tool.run(params.arguments ?? {});
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: err?.message ?? String(err) }], isError: true };
      }
    }
    case "prompts/list":
      return { prompts: PROMPTS };
    case "prompts/get":
      if (!PROMPTS.some((p) => p.name === params?.name)) {
        throw Object.assign(new Error(`Unknown prompt: ${params?.name}`), { code: -32602 });
      }
      return { messages: [{ role: "user", content: { type: "text", text: SWEEP_PROMPT } }] };
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (msg.id === undefined || msg.id === null) return; // notification
  if (typeof msg.method !== "string") return; // a response to us; we send no requests
  try {
    send({ jsonrpc: "2.0", id: msg.id, result: await handle(msg.method, msg.params) });
  } catch (err) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: err?.code ?? -32603, message: err?.message ?? String(err) } });
  }
});
