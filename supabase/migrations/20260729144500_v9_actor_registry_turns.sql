-- V9 actor evidence registry and debounced customer turns.
-- No trigger, cron or outbound side effect is introduced.

create table if not exists public.v9_actor_registry (
  id uuid primary key default gen_random_uuid(),
  page_id text,
  app_id text,
  actor_type text not null check (actor_type in ('sale','admin','automation','bot')),
  provider text not null,
  display_name text,
  evidence jsonb not null default '{}'::jsonb,
  confidence numeric(5,4) not null default 1 check (confidence between 0 and 1),
  is_active boolean not null default true,
  verified_at timestamptz not null default now(),
  verified_by text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(page_id, app_id, actor_type)
);

create index if not exists idx_v9_actor_registry_lookup
  on public.v9_actor_registry(page_id, app_id)
  where is_active = true;

create table if not exists public.v9_conversation_turns (
  id uuid primary key default gen_random_uuid(),
  page_id text not null,
  sender_id text not null,
  first_event_at timestamptz not null,
  last_event_at timestamptz not null,
  source_event_ids uuid[] not null default '{}',
  message_count integer not null default 1 check (message_count > 0),
  combined_text text,
  attachments jsonb not null default '[]'::jsonb,
  actor_status text not null default 'customer_verified',
  human_takeover_verified boolean not null default false,
  suppression_reason text,
  context_snapshot jsonb not null default '{}'::jsonb,
  status text not null default 'context_ready' check (status in ('debouncing','context_ready','suppressed','decided','staged','sent','error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(page_id, sender_id, last_event_at)
);

create index if not exists idx_v9_turns_conversation_time
  on public.v9_conversation_turns(page_id, sender_id, last_event_at desc);
create index if not exists idx_v9_turns_status
  on public.v9_conversation_turns(status, updated_at desc);

alter table public.v9_actor_registry enable row level security;
alter table public.v9_conversation_turns enable row level security;
revoke all on table public.v9_actor_registry from anon, authenticated;
revoke all on table public.v9_conversation_turns from anon, authenticated;

comment on table public.v9_actor_registry is 'Evidence-backed identities only. Sale/Admin requires explicit verified evidence.';
comment on table public.v9_conversation_turns is 'Canonical debounced customer turns. Automation and page_unknown never count as human takeover.';
