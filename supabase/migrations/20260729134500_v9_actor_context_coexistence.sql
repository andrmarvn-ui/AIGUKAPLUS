alter table public.v9_runtime_config
  add column if not exists external_bot_mode text not null default 'AICAKE_ACTIVE',
  add column if not exists external_bot_policy text not null default 'OBSERVE_AND_SUPPRESS',
  add column if not exists actor_settle_seconds smallint not null default 20 check (actor_settle_seconds between 5 and 120),
  add column if not exists human_takeover_seconds integer not null default 600 check (human_takeover_seconds between 60 and 86400);

update public.v9_runtime_config
set external_bot_mode='AICAKE_ACTIVE',
    external_bot_policy='OBSERVE_AND_SUPPRESS',
    actor_settle_seconds=20,
    human_takeover_seconds=600,
    updated_at=now()
where id=1;

alter table public.v9_conversation_state
  add column if not exists human_takeover_until timestamptz;

insert into public.v9_worker_cursors(worker_name,cursor_created_at,cursor_id)
values
  ('aiguka-v9-shadow-meta', now(), null),
  ('aiguka-v9-shadow-outbound', now(), null)
on conflict(worker_name) do nothing;

create index if not exists idx_v8_messages_outbound_sent_id
  on public.v8_messages_raw(sent_at,id)
  where direction='outbound';

create table if not exists public.v9_turns (
  id uuid primary key default gen_random_uuid(),
  source_event_id uuid not null unique,
  page_id text not null,
  sender_id text not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  customer_event_ids uuid[] not null default '{}'::uuid[],
  combined_text text,
  contact_detection jsonb not null default '{}'::jsonb,
  sales_signals jsonb not null default '{}'::jsonb,
  response_evidence jsonb not null default '{}'::jsonb,
  action text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_v9_turns_conversation_time
  on public.v9_turns(page_id,sender_id,ended_at desc);
create index if not exists idx_v9_turns_action
  on public.v9_turns(action,created_at desc);

alter table public.v9_turns enable row level security;
revoke all on table public.v9_turns from anon,authenticated;

comment on table public.v9_turns is 'Debounced customer turns with actor-aware response evidence. AIcake and other automation never count as verified human takeover.';
