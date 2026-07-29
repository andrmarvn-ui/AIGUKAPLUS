create table if not exists public.v9_integrations (
  integration_key text primary key,
  integration_type text not null check (integration_type in ('meta_oauth','knowledge_database','reporting_database')),
  display_name text,
  status text not null default 'disabled' check (status in ('disabled','ready','degraded','revoked')),
  encrypted_payload jsonb not null default '{}'::jsonb,
  public_config jsonb not null default '{}'::jsonb,
  secret_version integer not null default 1 check (secret_version > 0),
  last_verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.v9_integrations enable row level security;
revoke all on table public.v9_integrations from anon, authenticated;

comment on table public.v9_integrations is
  'Minimal operational integrations for V9 Core. AI knowledge, catalog, Drive and reporting data are stored outside Core.';
