-- Adamanteum hosted: one Neon database, one vault per company.
-- Every table carries the company's vault id. Two locks keep companies apart:
--   1. every query the program writes names the vault (WHERE vault = ...);
--   2. Postgres row-level security, forced, so even a query that forgot the vault sees only the vault
--      named for its transaction (set_config('adm.vault', ...)). The program connects as adm_app, which
--      owns nothing and cannot bypass these rules.
create table if not exists vaults(
  vault text primary key check (vault ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
  company text not null default '',
  created_at timestamptz not null default now(),
  created_by text not null default ''
);
create table if not exists docs(
  vault text not null references vaults(vault),
  path text not null,
  title text not null default '',
  folder text not null default '',
  body text not null,
  properties jsonb not null default '{}'::jsonb,
  tags text[] not null default '{}',
  sha256 text not null,
  bytes integer not null,
  revision integer not null default 1,
  mtime timestamptz not null default now(),
  created_by text not null default '',
  updated_by text not null default '',
  tsv tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(title, '') || ' ' || replace(replace(path, '/', ' '), '-', ' ')), 'A') ||
    setweight(to_tsvector('english', body), 'B')) stored,
  primary key (vault, path)
);
create index if not exists docs_tsv on docs using gin (tsv);
create index if not exists docs_mtime on docs (vault, mtime desc);
create table if not exists links(
  vault text not null references vaults(vault),
  source text not null,
  target text not null,
  primary key (vault, source, target)
);
create index if not exists links_target on links (vault, target);
create table if not exists tokens(
  id text primary key,
  vault text not null references vaults(vault),
  actor text not null,
  scope text not null check (scope in ('read', 'write')),
  hash text not null,
  created_at timestamptz not null default now(),
  created_by text not null default '',
  revoked_at timestamptz,
  revoked_by text,
  last_used_at timestamptz,
  expires_at timestamptz
);
-- Short-lived keys (a home app asking for Assistant's key to one company) carry an end time.
alter table tokens add column if not exists expires_at timestamptz;
create table if not exists receipts(
  receipt_id uuid primary key,
  vault text not null references vaults(vault),
  at timestamptz not null default now(),
  actor text,
  kind text not null,
  data jsonb not null default '{}'::jsonb
);
create index if not exists receipts_vault_at on receipts (vault, at desc);
create table if not exists code_graphs(
  vault text primary key references vaults(vault),
  name text not null default '',
  graph jsonb not null,
  uploaded_at timestamptz not null default now(),
  uploaded_by text not null default ''
);
create table if not exists models(
  vault text not null references vaults(vault),
  id text not null,
  name text not null,
  model text not null,
  endpoint text not null,
  key_enc text not null default '',
  attached_at timestamptz not null default now(),
  primary key (vault, id)
);
create table if not exists sessions(
  id text primary key,
  vault text not null references vaults(vault),
  username text not null,
  role text not null default '',
  company text not null default '',
  display_name text not null default '',
  assistant_url text not null default '',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

do $$
declare t text;
begin
  foreach t in array array['vaults','docs','links','tokens','receipts','code_graphs','models','sessions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists one_vault on %I', t);
    execute format($p$create policy one_vault on %I using (vault = current_setting('adm.vault', true)) with check (vault = current_setting('adm.vault', true))$p$, t);
  end loop;
end $$;

-- The only two lookups that cross vaults, and what they return: which vault a bearer token or a browser
-- session belongs to. Nothing else. They run as the owner (who may bypass row security) and return one row.
drop function if exists adm_token(text);
create function adm_token(token_id text)
returns table(vault text, actor text, scope text, hash text, revoked_at timestamptz, expires_at timestamptz)
language sql security definer set search_path = public stable as $$
  select vault, actor, scope, hash, revoked_at, expires_at from tokens where id = token_id
$$;
create or replace function adm_session(session_id text)
returns table(vault text, username text, role text, company text, display_name text, assistant_url text, expires_at timestamptz)
language sql security definer set search_path = public stable as $$
  select vault, username, role, company, display_name, assistant_url, expires_at from sessions where id = session_id
$$;
-- A vault is created the first time its company opens Adamanteum from its home app.
create or replace function adm_open_vault(v text, company_name text, who text)
returns void language sql security definer set search_path = public as $$
  insert into vaults(vault, company, created_by) values (v, company_name, who)
  on conflict (vault) do update set company = case when excluded.company <> '' then excluded.company else vaults.company end
$$;
revoke all on function adm_token(text), adm_session(text), adm_open_vault(text, text, text) from public;
