create extension if not exists pgcrypto;

create table public.v9_runtime_config (
  id smallint primary key default 1 check (id = 1),
  mode text not null default 'SHADOW' check (mode in ('OFF','SHADOW','CANARY','ACTIVE')),
  debounce_seconds smallint not null default 20 check (debounce_seconds between 5 and 120),
  response_sla_seconds smallint not null default 90 check (response_sla_seconds between 15 and 600),
  event_batch_size smallint not null default 10 check (event_batch_size between 1 and 100),
  external_bot_mode text not null default 'AICAKE_ACTIVE',
  external_bot_policy text not null default 'OBSERVE_AND_SUPPRESS',
  actor_settle_seconds smallint not null default 20 check (actor_settle_seconds between 5 and 120),
  human_takeover_seconds integer not null default 600 check (human_takeover_seconds between 60 and 86400),
  dashboard_isolated boolean not null default true,
  contact_goal text not null default 'capture_phone_or_zalo',
  updated_at timestamptz not null default now()
);
insert into public.v9_runtime_config(id) values (1) on conflict (id) do nothing;

create table public.v9_pages (
  page_id text primary key,
  page_name text,
  operating_mode text not null default 'OFF' check (operating_mode in ('OFF','SUPPORT','SHADOW','CANARY','ACTIVE')),
  timezone text not null default 'Asia/Bangkok',
  coexistence_mode text not null default 'AICAKE_ACTIVE',
  canary_percent smallint not null default 0 check (canary_percent between 0 and 100),
  settings jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.v9_customers (
  id uuid primary key default gen_random_uuid(),
  page_id text not null references public.v9_pages(page_id) on delete cascade,
  customer_id text not null,
  display_name text,
  gender text,
  preferred_salutation text,
  profile jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(page_id, customer_id)
);

create table public.v9_contacts (
  id uuid primary key default gen_random_uuid(),
  page_id text not null,
  customer_id text not null,
  contact_type text not null check (contact_type in ('phone','zalo')),
  contact_value text not null,
  normalized_value text not null,
  source_event_id text,
  confidence numeric(5,4) not null default 1 check (confidence between 0 and 1),
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(page_id, customer_id, contact_type, normalized_value),
  foreign key(page_id, customer_id) references public.v9_customers(page_id, customer_id) on delete cascade
);

create table public.v9_actor_registry (
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

create table public.v9_events (
  id uuid primary key default gen_random_uuid(),
  source_system text not null,
  source_event_id text not null,
  page_id text,
  sender_id text,
  customer_id text,
  recipient_id text,
  message_id text,
  actor_type text not null check (actor_type in ('customer','sale','admin','automation','bot','page_unknown','unknown')),
  actor_evidence jsonb not null default '{}'::jsonb,
  event_type text not null,
  message_text text,
  attachments jsonb not null default '[]'::jsonb,
  referral jsonb,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(source_system, source_event_id)
);

create table public.v9_conversation_state (
  id uuid primary key default gen_random_uuid(),
  page_id text not null,
  sender_id text not null,
  state text not null default 'IDLE',
  version integer not null default 1,
  contact_status text not null default 'missing',
  phone text,
  zalo text,
  human_takeover boolean not null default false,
  human_takeover_until timestamptz,
  last_customer_event_at timestamptz,
  last_page_event_at timestamptz,
  response_deadline_at timestamptz,
  last_source_event_id text,
  context_version text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(page_id, sender_id)
);

create table public.v9_turns (
  id uuid primary key default gen_random_uuid(),
  source_event_id text not null unique,
  page_id text not null,
  sender_id text not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  customer_event_ids text[] not null default '{}'::text[],
  combined_text text,
  contact_detection jsonb not null default '{}'::jsonb,
  sales_signals jsonb not null default '{}'::jsonb,
  response_evidence jsonb not null default '{}'::jsonb,
  action text not null,
  status text not null default 'context_ready',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.v9_jobs (
  id uuid primary key default gen_random_uuid(),
  source_event_id text,
  event_id uuid references public.v9_events(id) on delete set null,
  job_type text not null,
  dedupe_key text,
  page_id text,
  sender_id text,
  status text not null default 'queued' check (status in ('queued','processing','completed','cancelled','dead_letter')),
  run_after timestamptz not null default now(),
  attempts smallint not null default 0,
  locked_by text,
  locked_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_event_id, job_type),
  unique(job_type, dedupe_key)
);

create table public.v9_decisions (
  id uuid primary key default gen_random_uuid(),
  source_event_id text not null unique,
  turn_id uuid references public.v9_turns(id) on delete set null,
  page_id text not null,
  sender_id text not null,
  mode text not null default 'SHADOW',
  status text not null,
  goal text not null default 'capture_phone_or_zalo',
  action text,
  confidence numeric(5,4),
  knowledge_version text,
  input_snapshot jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  risk_flags jsonb not null default '[]'::jsonb,
  latency_ms integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.v9_delivery_bundles (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid references public.v9_decisions(id) on delete restrict,
  page_id text not null,
  sender_id text not null,
  text_body text,
  asset_refs jsonb not null default '[]'::jsonb,
  status text not null default 'staged' check (status in ('staged','authorized','sending','sent','cancelled','failed')),
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.v9_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references public.v9_delivery_bundles(id) on delete cascade,
  attempt_no smallint not null,
  transport text not null default 'meta_messenger',
  status text not null check (status in ('sending','sent','failed','cancelled')),
  provider_message_id text,
  provider_response jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(bundle_id, attempt_no)
);

create table public.v9_reporting_outbox (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  event_type text not null,
  occurred_at timestamptz not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','processing','delivered','dead_letter')),
  attempts smallint not null default 0,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.v9_worker_cursors (
  worker_name text primary key,
  cursor_created_at timestamptz not null default now(),
  cursor_id text,
  updated_at timestamptz not null default now()
);

create table public.v9_worker_heartbeats (
  worker_name text primary key,
  worker_version text not null,
  status text not null,
  mode text not null,
  details jsonb not null default '{}'::jsonb,
  last_error text,
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.v9_shadow_observations (
  id uuid primary key default gen_random_uuid(),
  source_event_id text not null unique,
  page_id text,
  sender_id text,
  actor_type text,
  event_type text,
  contact_detection jsonb not null default '{}'::jsonb,
  state_after text,
  goal text,
  created_at timestamptz not null default now()
);

create table public.v9_sla_events (
  id uuid primary key default gen_random_uuid(),
  source_event_id text not null unique,
  page_id text not null,
  sender_id text not null,
  deadline_at timestamptz not null,
  status text not null default 'open' check (status in ('open','resolved','breached','cancelled')),
  resolution text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_v9_events_conversation_time on public.v9_events(page_id, customer_id, occurred_at desc);
create index idx_v9_events_actor_time on public.v9_events(actor_type, occurred_at desc);
create index idx_v9_jobs_due on public.v9_jobs(status, run_after) where status='queued';
create index idx_v9_turns_conversation_time on public.v9_turns(page_id, sender_id, ended_at desc);
create index idx_v9_decisions_status on public.v9_decisions(status, created_at);
create index idx_v9_delivery_status on public.v9_delivery_bundles(status, created_at);
create index idx_v9_reporting_due on public.v9_reporting_outbox(status, run_after) where status in ('pending','processing');
create index idx_v9_sla_open on public.v9_sla_events(status, deadline_at) where status='open';
create index idx_v9_actor_registry_lookup on public.v9_actor_registry(page_id, app_id) where is_active=true;

create or replace function public.v9_claim_jobs(p_worker text, p_job_type text, p_limit integer default 10)
returns setof public.v9_jobs
language plpgsql
security definer
set search_path=public
as $$
begin
  return query
  with picked as (
    select id from public.v9_jobs
    where status='queued' and job_type=p_job_type and run_after<=now()
    order by run_after,id
    for update skip locked
    limit greatest(1,least(coalesce(p_limit,10),50))
  )
  update public.v9_jobs j
  set status='processing', locked_by=p_worker, locked_at=now(), attempts=j.attempts+1, updated_at=now()
  from picked
  where j.id=picked.id
  returning j.*;
end;
$$;

alter table public.v9_runtime_config enable row level security;
alter table public.v9_pages enable row level security;
alter table public.v9_customers enable row level security;
alter table public.v9_contacts enable row level security;
alter table public.v9_actor_registry enable row level security;
alter table public.v9_events enable row level security;
alter table public.v9_conversation_state enable row level security;
alter table public.v9_turns enable row level security;
alter table public.v9_jobs enable row level security;
alter table public.v9_decisions enable row level security;
alter table public.v9_delivery_bundles enable row level security;
alter table public.v9_delivery_attempts enable row level security;
alter table public.v9_reporting_outbox enable row level security;
alter table public.v9_worker_cursors enable row level security;
alter table public.v9_worker_heartbeats enable row level security;
alter table public.v9_shadow_observations enable row level security;
alter table public.v9_sla_events enable row level security;

revoke all on all tables in schema public from anon,authenticated;
revoke all on function public.v9_claim_jobs(text,text,integer) from public,anon,authenticated;
grant execute on function public.v9_claim_jobs(text,text,integer) to service_role;

comment on schema public is 'AIGUKA V9 Core only: realtime events, state, jobs, decisions, delivery and reporting outbox. No AI knowledge or dashboard facts.';
