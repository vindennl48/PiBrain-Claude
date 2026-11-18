-- PiBrain backend schema — fresh install, single file.
--
-- This is everything server.mjs talks to, consolidated into its final shape.
-- Apply it ONCE to an EMPTY Postgres database (14 or newer), connected as the
-- role PostgREST will use, so that role owns every object:
--
--   psql -v ON_ERROR_STOP=1 -U <role> -d <database> -f schema.sql
--
-- It is not a migration: do not re-run it against a database that already
-- holds rows. The last statement reloads PostgREST's schema cache; without
-- that reload new tables and functions return 404.
--
-- Two things in here are yours to change, both marked EDIT:
--   1. the domain vocabulary (the `category` rows), and
--   2. the grants at the bottom, if PostgREST connects as a different role
--      from the one that applies this file.

begin;

-- ---------------------------------------------------------------------------
-- category — the fixed domain vocabulary.
--
-- `description` is what an agent reads to decide whether a domain is relevant,
-- so write it for an agent. Keep the list short: `domain` narrows the search
-- space before any row is read, and a long tail of one-off tags destroys that.
-- ---------------------------------------------------------------------------
create table category (
  id          bigint generated always as identity primary key,
  domain      text not null unique,
  description text not null,
  sort        int  not null default 0
);

-- EDIT: replace with your own domains. `memory.domain` is a foreign key to
-- this table, so a row can only be stored under a domain listed here. The same
-- list is repeated in server.mjs (DOMAINS and INSTRUCTIONS) — keep them in step.
insert into category (domain, description, sort) values
  ('infra',        'Home lab hardware, LAN addressing and SSH access: which machine owns which job.', 10),
  ('coding',       'Cross-project working conventions: branches, tests, quality gates, commit and deploy discipline.', 20),
  ('agent-memory', 'This knowledge base itself: how it works, its design rules, and what counts as a row worth storing.', 30);

-- ---------------------------------------------------------------------------
-- memory — one atomic claim per row.
--
-- Retrieval cost is per row, so row granularity IS the design. If a claim
-- needs two sentences, it is two rows.
--
-- Nothing is ever deleted. A stale row is SUPERSEDED (superseded_by points at
-- its replacement); a row that was never true is RETRACTED (retracted_at set).
-- Both stay in the table and both are reversible.
-- ---------------------------------------------------------------------------
create table memory (
  id            bigint generated always as identity primary key,
  domain        text not null references category(domain) on update cascade,
  kind          text not null check (kind in
                  ('fact','practical','gotcha','decision','procedure','history')),
  -- 'open' rows are searchable. 'ask-first' rows (credential locations,
  -- infrastructure identifiers) are hidden from search and browse.
  sensitivity   text not null default 'open'
                  check (sensitivity in ('open','ask-first')),
  claim         text not null,
  -- A safe, non-sensitive title. Required for ask-first rows, because their
  -- claim is withheld and this is all an agent sees of them.
  label         text,
  body          text not null default '',
  evidence      text,
  project       text,
  observed_at   timestamptz not null default now(),
  superseded_by bigint references memory(id),
  created_by    text,
  retracted_at     timestamptz,
  retracted_reason text,
  retracted_by     text,
  -- "A correction to this row is staged but not applied." Only set by a client
  -- that stages proposals for human review; server.mjs never sets it, it only
  -- displays it (as DISPUTED). Safe to leave unused.
  pending_change_at     timestamptz,
  pending_change_op     text check (pending_change_op is null or pending_change_op in ('replace','remove')),
  pending_change_reason text,
  pending_change_by     text,
  tsv           tsvector generated always as
                  (to_tsvector('english', claim || ' ' || body)) stored,
  constraint memory_askfirst_needs_label
    check (sensitivity <> 'ask-first' or label is not null)
);

create index memory_tsv_idx on memory using gin (tsv);
create index memory_domain_kind_idx on memory (domain, kind) where superseded_by is null;
create index memory_project_idx on memory (project) where superseded_by is null;
create index memory_recent_writes_idx on memory (observed_at desc)
  where retracted_at is null and superseded_by is null;
create index memory_disputed_idx on memory (pending_change_at)
  where pending_change_at is not null;

-- ---------------------------------------------------------------------------
-- proposal — the audit log of corrections.
--
-- memory_correct() writes one row here per correction and applies it in the
-- same transaction, because `memory` has nowhere to record WHY a row was
-- replaced or removed. A client that wants human approval can instead insert a
-- 'pending' row and call memory_apply_proposal() / memory_cancel_proposal().
-- ---------------------------------------------------------------------------
create table proposal (
  id           bigint generated always as identity primary key,
  proposed_at  timestamptz not null default now(),
  source       text not null,
  session_id   text,
  operation    text not null default 'add'
                 check (operation in ('add','replace','remove')),
  target_id    bigint references memory(id),
  domain       text not null,
  kind         text not null check (kind in
                 ('fact','practical','gotcha','decision','procedure','history')),
  sensitivity  text not null default 'open'
                 check (sensitivity in ('open','ask-first')),
  claim        text not null,
  label        text,
  body         text not null default '',
  evidence     text,
  rationale    text not null,
  project      text,
  status       text not null default 'pending'
                 check (status in ('pending','accepted','rejected')),
  reviewed_at  timestamptz,
  reviewed_by  text,
  constraint proposal_askfirst_needs_label
    check (sensitivity <> 'ask-first' or label is not null),
  constraint proposal_target_required check (
    (operation = 'add' and target_id is null) or
    (operation in ('replace','remove') and target_id is not null)
  )
);

create index proposal_status_idx on proposal (status, proposed_at desc);
create index proposal_target_idx on proposal (target_id, operation, status)
  where target_id is not null;

-- ---------------------------------------------------------------------------
-- session_summary — one line per agent session; what memory_recent returns.
--
-- memory_session_end upserts on `session_file`, so the unique constraint is
-- load-bearing. `source` separates rows an agent wrote ('agent') from rows a
-- script derived from transcripts ('transcript'); server.mjs writes 'agent'.
-- ---------------------------------------------------------------------------
create table session_summary (
  id             bigint generated always as identity primary key,
  session_file   text not null unique,
  project        text,
  started_at     timestamptz,
  ended_at       timestamptz,
  outcome        text not null,
  changed        jsonb not null default '[]'::jsonb,
  open_questions text[] not null default '{}',
  generated_at   timestamptz not null default now(),
  source         text not null default 'transcript'
                   check (source in ('transcript','agent'))
);

create index session_summary_project_idx
  on session_summary (project, ended_at desc nulls last);

-- ---------------------------------------------------------------------------
-- Views. The filtering is enforced here, in the database, so no client can
-- leak an ask-first row by forgetting a WHERE clause.
--
-- Any new view over `memory` must filter BOTH superseded_by and retracted_at.
-- ---------------------------------------------------------------------------

-- The domain index memory_list() shows when called with no arguments.
create view toc as
  select c.domain,
         c.description,
         c.sort,
         count(m.id) filter (where m.superseded_by is null and m.retracted_at is null) as n
    from category c
    left join memory m on m.domain = c.domain
   group by c.id, c.domain, c.description, c.sort;

-- The only surface agents browse: current, open rows.
create view memory_open as
  select id, domain, kind, claim, body, evidence, project, observed_at, tsv,
         pending_change_op, pending_change_reason
    from memory
   where sensitivity = 'open'
     and superseded_by is null
     and retracted_at is null;

-- Ask-first rows, visible only as safe labels. No claim, body or evidence.
create view memory_locked as
  select id, domain, kind, label, project, observed_at, pending_change_op
    from memory
   where sensitivity = 'ask-first'
     and superseded_by is null
     and retracted_at is null;

-- What has been withdrawn, so it can be inspected or restored.
create view memory_retracted as
  select id, domain, kind, claim, created_by, observed_at,
         retracted_at, retracted_by, retracted_reason
    from memory
   where retracted_at is not null
   order by retracted_at desc;

create view memory_disputed as
  select id, domain, kind, claim, evidence,
         pending_change_op, pending_change_reason, pending_change_by, pending_change_at
    from memory
   where pending_change_at is not null
     and retracted_at is null
     and superseded_by is null;

-- ---------------------------------------------------------------------------
-- memory_apply_proposal — the single implementation of add / replace / remove.
-- One transaction: an insert, a supersede and an audit update all succeed or
-- none do.
-- ---------------------------------------------------------------------------
create function memory_apply_proposal(p_id bigint)
returns text
language plpgsql
as $$
declare
  pr      proposal%rowtype;
  v_new   bigint;
begin
  select * into pr from proposal where id = p_id;

  if not found then
    raise exception 'No proposal with id %.', p_id;
  end if;
  if pr.status <> 'pending' then
    raise exception 'Proposal % is already % — nothing to do.', p_id, pr.status;
  end if;

  if pr.operation = 'add' then
    insert into memory (domain, kind, sensitivity, label, claim, body,
                        evidence, project, created_by)
    values (pr.domain, pr.kind, pr.sensitivity, pr.label, pr.claim, pr.body,
            pr.evidence, pr.project, 'agent')
    returning id into v_new;

  elsif pr.operation = 'replace' then
    insert into memory (domain, kind, sensitivity, label, claim, body,
                        evidence, project, created_by)
    values (pr.domain, pr.kind, pr.sensitivity, pr.label, pr.claim, pr.body,
            pr.evidence, pr.project, 'agent')
    returning id into v_new;

    -- The old row stays, linked forward: "this used to be true" is often the
    -- only explanation for why something looks odd now.
    update memory
       set superseded_by         = v_new,
           pending_change_at     = null,
           pending_change_op     = null,
           pending_change_reason = null,
           pending_change_by     = null
     where id = pr.target_id;

    if not found then
      raise exception 'Proposal % targets row %, which does not exist.', p_id, pr.target_id;
    end if;

  elsif pr.operation = 'remove' then
    update memory
       set retracted_at          = now(),
           retracted_by          = 'agent-proposed',
           retracted_reason      = pr.rationale,
           pending_change_at     = null,
           pending_change_op     = null,
           pending_change_reason = null,
           pending_change_by     = null
     where id = pr.target_id
       and retracted_at is null;

    if not found then
      raise exception 'Row % does not exist or is already retracted.', pr.target_id;
    end if;

  else
    raise exception 'Unknown operation % on proposal %.', pr.operation, p_id;
  end if;

  update proposal
     set status = 'accepted', reviewed_at = now(), reviewed_by = 'operator'
   where id = p_id;

  if pr.operation = 'add' then
    return format('[%s] added to %s.', v_new, pr.domain);
  elsif pr.operation = 'replace' then
    return format('[%s] superseded by [%s].', pr.target_id, v_new);
  else
    return format('[%s] removed (recoverable with memory_restore_row(%s)).', pr.target_id, pr.target_id);
  end if;
end;
$$;

-- Decline a staged proposal and clear the dispute marker it raised.
create function memory_cancel_proposal(p_id bigint)
returns text
language plpgsql
as $$
declare
  pr proposal%rowtype;
begin
  select * into pr from proposal where id = p_id;

  if not found then
    raise exception 'No proposal with id %.', p_id;
  end if;
  if pr.status <> 'pending' then
    raise exception 'Proposal % is already % — nothing to do.', p_id, pr.status;
  end if;

  if pr.target_id is not null then
    update memory
       set pending_change_at     = null,
           pending_change_op     = null,
           pending_change_reason = null,
           pending_change_by     = null
     where id = pr.target_id;
  end if;

  update proposal
     set status = 'rejected', reviewed_at = now(), reviewed_by = 'operator'
   where id = p_id;

  if pr.target_id is not null then
    return format('[%s] cancelled — [%s] is undisputed again.', p_id, pr.target_id);
  end if;
  return format('[%s] discarded.', p_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Operator levers. server.mjs does not call these; they are how a human undoes
-- what an agent wrote:
--   POST /rpc/memory_retract_row  {"p_id": 12, "p_reason": "wrong"}
--   POST /rpc/memory_restore_row  {"p_id": 12}
-- ---------------------------------------------------------------------------
create function memory_retract_row(p_id bigint, p_reason text default null)
returns text
language plpgsql
as $$
begin
  perform 1 from memory where id = p_id;
  if not found then
    raise exception 'No row with id %.', p_id;
  end if;

  update memory
     set retracted_at     = now(),
         retracted_by     = 'operator',
         retracted_reason = coalesce(p_reason, 'operator retraction')
   where id = p_id
     and retracted_at is null;

  if not found then
    return format('[%s] is already retracted.', p_id);
  end if;

  return format('[%s] retracted — gone from search, kept in the table.', p_id);
end;
$$;

create function memory_restore_row(p_id bigint)
returns text
language plpgsql
as $$
begin
  perform 1 from memory where id = p_id;
  if not found then
    raise exception 'No row with id %.', p_id;
  end if;

  update memory
     set retracted_at     = null,
         retracted_by     = null,
         retracted_reason = null
   where id = p_id
     and retracted_at is not null;

  if not found then
    return format('[%s] is not retracted.', p_id);
  end if;

  return format('[%s] restored — searchable again.', p_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- memory_correct — what the memory_correct tool calls. Applies a replace or a
-- remove now and returns the stored row.
--
-- On a replace, a NULL body / evidence / project means "keep the target's
-- value"; an explicit empty string means "clear it".
-- ---------------------------------------------------------------------------
create function memory_correct(
  p_operation   text,
  p_target_id   bigint,
  p_rationale   text,
  p_domain      text default null,
  p_kind        text default null,
  p_claim       text default null,
  p_body        text default null,
  p_evidence    text default null,
  p_project     text default null,
  p_sensitivity text default 'open',
  p_label       text default null
) returns jsonb
language plpgsql
as $$
declare
  v_old     memory%rowtype;
  v_new_id  bigint;
  v_pid     bigint;
  v_message text;
  v_row     memory%rowtype;
begin
  if p_operation not in ('replace','remove') then
    raise exception 'memory_correct handles replace and remove; % is not one.', p_operation;
  end if;

  select * into v_old from memory where id = p_target_id;
  if not found then
    raise exception 'No row with id %.', p_target_id;
  end if;
  if v_old.retracted_at is not null then
    raise exception 'Row % is already retracted — nothing to correct.', p_target_id;
  end if;
  if v_old.superseded_by is not null then
    raise exception 'Row % was already superseded by [%]. Correct that row instead.',
      p_target_id, v_old.superseded_by;
  end if;

  if p_operation = 'replace' and (p_claim is null or btrim(p_claim) = '') then
    raise exception 'A replace needs a new claim.';
  end if;
  if p_operation = 'replace' and coalesce(p_sensitivity, 'open') = 'ask-first'
     and p_label is null then
    raise exception 'An ask-first row needs a label: a safe title that does not contain the identifier.';
  end if;

  insert into proposal (
    source, operation, target_id, domain, kind, sensitivity, claim, label,
    body, evidence, rationale, project, status
  ) values (
    'agent', p_operation, p_target_id,
    coalesce(p_domain, v_old.domain),
    coalesce(p_kind,   v_old.kind),
    -- A remove takes no new content: it reuses the row being withdrawn, so the
    -- audit row records exactly what was removed.
    case when p_operation = 'remove' then v_old.sensitivity
         else coalesce(p_sensitivity, 'open') end,
    case when p_operation = 'remove' then v_old.claim else p_claim end,
    case when p_operation = 'remove' then v_old.label else p_label end,
    case when p_operation = 'remove' then v_old.body
         else coalesce(p_body, v_old.body) end,
    case when p_operation = 'remove' then v_old.evidence
         else coalesce(p_evidence, v_old.evidence) end,
    p_rationale,
    case when p_operation = 'remove' then v_old.project
         else coalesce(p_project, v_old.project) end,
    'pending'
  ) returning id into v_pid;

  v_message := memory_apply_proposal(v_pid);
  -- apply_proposal stamps 'operator'; this call was the agent's.
  update proposal set reviewed_by = 'agent' where id = v_pid;
  if p_operation = 'remove' then
    update memory set retracted_by = 'agent' where id = p_target_id;
  end if;

  if p_operation = 'replace' then
    select superseded_by into v_new_id from memory where id = p_target_id;
    select * into v_row from memory where id = v_new_id;
  else
    select * into v_row from memory where id = p_target_id;
  end if;

  return jsonb_build_object(
    'proposal_id',    v_pid,
    'operation',      p_operation,
    'target_id',      p_target_id,
    'message',        v_message,
    'previous_claim', v_old.claim,
    -- tsv is a search artifact, not data worth echoing back to a caller.
    'row',            to_jsonb(v_row) - 'tsv'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- memory_search — what the memory_search tool calls. Matching and ranking.
--
-- Two arms: the whole query as an English full-text query (stemming, phrases),
-- and each word as a PREFIX in the `simple` config, so `proxm` finds `Proxmox`
-- without `thing` matching "nothing".
--
-- Score: +10 if the whole query matched, +1 per word matched by prefix,
-- +0.1 x ts_rank as a tiebreak. Then newest first. A row matching every term
-- outranks one matching some; `strict_match` says which kind a row is.
--
-- Ask-first, superseded and retracted rows are excluded here, in SQL.
-- ---------------------------------------------------------------------------
create function memory_search(
  p_query  text,
  p_domain text default null,
  p_kind   text default null,
  p_limit  int  default 8
) returns table (
  id                bigint,
  domain            text,
  kind              text,
  claim             text,
  observed_at       timestamptz,
  pending_change_op text,
  score             real,
  strict_match      boolean
)
language sql
stable
as $$
  with parsed as (
    select
      websearch_to_tsquery('english', coalesce(p_query, '')) as strict,
      -- One sanitised word per term. Stripping everything but [a-z0-9_] is what
      -- makes the to_tsquery() below un-injectable.
      (select array_agg(distinct regexp_replace(lower(x), '[^a-z0-9_]', '', 'g'))
         from unnest(regexp_split_to_array(btrim(coalesce(p_query, '')), '\s+')) as x
        where length(regexp_replace(lower(x), '[^a-z0-9_]', '', 'g')) > 1) as words
  ),
  ready as (
    select strict, words,
           case when words is not null
                then to_tsquery('simple', (select string_agg(w || ':*', ' | ') from unnest(words) as w))
                else null end as pfx
      from parsed
  )
  select
    m.id, m.domain, m.kind, m.claim, m.observed_at, m.pending_change_op,
    (
      (case when m.tsv @@ r.strict then 10 else 0 end)
      + (select count(*) from unnest(r.words) as w where m.tsv @@ to_tsquery('simple', w || ':*'))
      + 0.1 * coalesce(ts_rank(m.tsv, coalesce(r.pfx, r.strict)), 0)
    )::real as score,
    (m.tsv @@ r.strict) as strict_match
  from memory m, ready r
  where m.sensitivity = 'open'
    and m.superseded_by is null
    and m.retracted_at is null
    and (p_domain is null or m.domain = p_domain)
    and (p_kind is null or m.kind = p_kind)
    and (m.tsv @@ r.strict or (r.pfx is not null and m.tsv @@ r.pfx))
  order by (m.pending_change_op is null) desc, score desc, m.observed_at desc
  limit least(greatest(coalesce(p_limit, 8), 1), 50);
$$;

-- ---------------------------------------------------------------------------
-- EDIT: grants. Nothing is needed when PostgREST connects as the role that
-- applied this file (it owns everything). If PostgREST uses a separate role,
-- uncomment and name it:
--
--   grant usage on schema public to <api_role>;
--   grant select, insert, update on all tables in schema public to <api_role>;
--   grant usage on all sequences in schema public to <api_role>;
--   grant execute on all functions in schema public to <api_role>;
--
-- No DELETE is granted on purpose: nothing in this design deletes a row.
-- ---------------------------------------------------------------------------

commit;

notify pgrst, 'reload schema';
