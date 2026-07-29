-- AIGUKA V9 foundation: isolated SHADOW runtime.
-- This migration adds canonical events, one conversation state, explicit jobs,
-- decisions and SLA tracking. It does not alter V8 tables, triggers or outbound.

create extension if not exists pgcrypto;

create table if not exists public.v9_runtime_config (
  id smallint primary key default 1 check (id = 1),
  mode text not null default 'SHADOW' check (mode in ('OFF','SHADOW','ACTIVE')),
  debounce_seconds smallint not null default 20 check (debounce_seconds between 5 and 60),
  response_sla_seconds smallint not null default 90 check (response_sla_seconds between 30 and 300),
  event_batch_size smallint not null default 10 check (event_batch_size between 1 and 50),
  dashboard_isolated boolean not null default true,
  contact_goal text not null default 'capture_phone_or_zalo',
  updated_at timestamptz not null default now()
);

insert into public.v9_runtime_config(id, mode, debounce_seconds, response_sla_seconds, event_batch_size, dashboard_isolated, contact_goal)
values (1, 'SHADOW', 20, 90, 10, true, 'capture_phone_or_zalo')
on conflict (id) do update set
  dashboard_isolated = true,
  contact_goal = excluded.contact_goal,
  updated_at = now();

create table if not exists public.v9_worker_cursors (
  worker_name text primary key,
  cursor_created_at timestamptz not null,
  cursor_id uuid,
  updated_at timestamptz not null default now()
);

insert into public.v9_worker_cursors(worker_name, cursor_created_at, cursor_id)
values ('aiguka-v9-shadow', now(), null)
on conflict (worker_name) do nothing;

create table if not exists public.v9_events (
  id uuid primary key default gen_random_uuid(),
  source_system text not null,
  source_event_id uuid not null unique,
  page_id text,
  sender_id text,
  recipient_id text,
  message_id text,
  actor_type text not null check (actor_type in ('customer','page_unknown','sale','admin','automation','bot','unknown')),
  actor_evidence jsonb not null default '{}'::jsonb,
  event_type text not null,
  message_text text,
  attachments jsonb not null default '[]'::jsonb,
  referral jsonb,
  occurred_at timestamptz not null,
  received_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_v9_events_conversation_time
  on public.v9_events(page_id, sender_id, occurred_at desc);
create index if not exists idx_v9_events_received
  on public.v9_events(received_at desc);
create index if not exists idx_v9_events_actor_type
  on public.v9_events(actor_type, event_type, occurred_at desc);

create table if not exists public.v9_conversation_state (
  page_id text not null,
  sender_id text not null,
  state text not null check (state in (
    'RECEIVED','DEBOUNCING','CONTACT_CAPTURED','CONTEXT_READY','DECIDED','STAGED','SENT',
    'ANSWERED_BY_HUMAN','SUPERSEDED_BY_NEW_MESSAGE','RETRYABLE_ERROR','DEAD_LETTER'
  )),
  version bigint not null default 1 check (version > 0),
  contact_status text not null default 'missing' check (contact_status in ('missing','captured','verified')),
  phone text,
  zalo text,
  human_takeover boolean not null default false,
  last_customer_event_at timestamptz,
  last_page_event_at timestamptz,
  response_deadline_at timestamptz,
  last_source_event_id uuid,
  updated_at timestamptz not null default now(),
  primary key(page_id, sender_id)
);

create index if not exists idx_v9_conversation_deadline
  on public.v9_conversation_state(response_deadline_at)
  where response_deadline_at is not null;
create index if not exists idx_v9_conversation_state_updated
  on public.v9_conversation_state(state, updated_at desc);

create table if not exists public.v9_jobs (
  id uuid primary key default gen_random_uuid(),
  source_event_id uuid not null,
  event_id uuid references public.v9_events(id) on delete cascade,
  job_type text not null,
  page_id text not null,
  sender_id text not null,
  status text not null default 'queued' check (status in ('queued','processing','completed','error','dead_letter','cancelled')),
  run_after timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  locked_by text,
  locked_at timestamptz,
  completed_at timestamptz,
  last_error text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_event_id, job_type)
);

create index if not exists idx_v9_jobs_claim
  on public.v9_jobs(status, run_after, created_at)
  where status = 'queued';
create index if not exists idx_v9_jobs_conversation
  on public.v9_jobs(page_id, sender_id, created_at desc);

create table if not exists public.v9_shadow_observations (
  id uuid primary key default gen_random_uuid(),
  source_event_id uuid not null unique,
  page_id text not null,
  sender_id text not null,
  actor_type text not null,
  event_type text not null,
  contact_detection jsonb not null default '{}'::jsonb,
  state_after text not null,
  goal text not null default 'capture_phone_or_zalo',
  created_at timestamptz not null default now()
);

create table if not exists public.v9_decisions (
  id uuid primary key default gen_random_uuid(),
  source_event_id uuid not null unique,
  page_id text not null,
  sender_id text not null,
  mode text not null check (mode in ('SHADOW','ACTIVE')),
  status text not null,
  goal text not null default 'capture_phone_or_zalo',
  action text not null,
  confidence numeric(5,4) not null default 0 check (confidence between 0 and 1),
  input_snapshot jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_v9_decisions_conversation
  on public.v9_decisions(page_id, sender_id, created_at desc);
create index if not exists idx_v9_decisions_status
  on public.v9_decisions(status, created_at desc);

create table if not exists public.v9_sla_events (
  id uuid primary key default gen_random_uuid(),
  source_event_id uuid not null unique,
  page_id text not null,
  sender_id text not null,
  deadline_at timestamptz not null,
  status text not null default 'open' check (status in ('open','resolved','breached','cancelled')),
  resolution text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_v9_sla_open_deadline
  on public.v9_sla_events(deadline_at)
  where status = 'open';
create index if not exists idx_v9_sla_conversation
  on public.v9_sla_events(page_id, sender_id, created_at desc);

create table if not exists public.v9_worker_heartbeats (
  worker_name text primary key,
  worker_version text not null,
  status text not null,
  mode text,
  details jsonb not null default '{}'::jsonb,
  last_error text,
  last_seen_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.v9_runtime_config enable row level security;
alter table public.v9_worker_cursors enable row level security;
alter table public.v9_events enable row level security;
alter table public.v9_conversation_state enable row level security;
alter table public.v9_jobs enable row level security;
alter table public.v9_shadow_observations enable row level security;
alter table public.v9_decisions enable row level security;
alter table public.v9_sla_events enable row level security;
alter table public.v9_worker_heartbeats enable row level security;

revoke all on table public.v9_runtime_config from anon, authenticated;
revoke all on table public.v9_worker_cursors from anon, authenticated;
revoke all on table public.v9_events from anon, authenticated;
revoke all on table public.v9_conversation_state from anon, authenticated;
revoke all on table public.v9_jobs from anon, authenticated;
revoke all on table public.v9_shadow_observations from anon, authenticated;
revoke all on table public.v9_decisions from anon, authenticated;
revoke all on table public.v9_sla_events from anon, authenticated;
revoke all on table public.v9_worker_heartbeats from anon, authenticated;

comment on table public.v9_events is 'Canonical immutable event log for AIGUKA V9. No business trigger is allowed.';
comment on table public.v9_conversation_state is 'Single V9 state row per Page/customer conversation.';
comment on table public.v9_jobs is 'Explicit V9 work queue. Shadow foundation does not send customer messages.';
comment on table public.v9_decisions is 'V9 decision snapshots. SHADOW rows must have output.should_send=false.';
