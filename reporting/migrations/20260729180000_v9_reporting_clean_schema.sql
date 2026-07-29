create extension if not exists pgcrypto;

create table public.reporting_runtime_config (
  id smallint primary key default 1 check (id=1),
  mode text not null default 'SHADOW' check (mode in ('OFF','SHADOW','ACTIVE')),
  retention_days integer not null default 730 check (retention_days between 30 and 3650),
  timezone text not null default 'Asia/Bangkok',
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.reporting_runtime_config(id) values(1) on conflict(id) do nothing;

create table public.reporting_ingest_events (
  event_key text primary key,
  source_type text not null,
  occurred_at timestamptz not null,
  payload jsonb not null,
  payload_checksum text not null,
  ingested_at timestamptz not null default now()
);

create table public.dim_pages (
  page_id text primary key,
  page_name text,
  timezone text not null default 'Asia/Bangkok',
  operating_mode text,
  is_active boolean not null default true,
  attributes jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.dim_customers (
  page_id text not null,
  customer_id text not null,
  display_name text,
  gender text,
  preferred_salutation text,
  attributes jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key(page_id,customer_id)
);

create table public.dim_ads (
  ad_id text primary key,
  page_id text,
  ad_account_id text,
  ad_account_name text,
  campaign_id text,
  campaign_name text,
  adset_id text,
  adset_name text,
  ad_name text,
  effective_status text,
  catalog_keys text[] not null default '{}'::text[],
  attributes jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.dim_staff (
  staff_key text primary key,
  display_name text,
  role text,
  provider text,
  is_active boolean not null default true,
  attributes jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.fact_messages (
  source_event_id text primary key,
  page_id text,
  customer_id text,
  occurred_at timestamptz not null,
  actor_type text,
  event_type text,
  message_length integer not null default 0,
  attachment_count integer not null default 0,
  has_referral boolean not null default false,
  ad_id text,
  attributes jsonb not null default '{}'::jsonb,
  ingested_at timestamptz not null default now()
);

create table public.fact_contacts (
  source_contact_id text primary key,
  page_id text not null,
  customer_id text not null,
  contact_type text not null,
  contact_hash text,
  confidence numeric(5,4),
  captured_at timestamptz not null,
  attributes jsonb not null default '{}'::jsonb,
  ingested_at timestamptz not null default now()
);

create table public.fact_ai_decisions (
  source_decision_id text primary key,
  source_event_id text,
  page_id text not null,
  customer_id text not null,
  occurred_at timestamptz not null,
  mode text,
  status text,
  action text,
  confidence numeric(5,4),
  model text,
  knowledge_version text,
  should_request_contact boolean,
  needs_slides boolean,
  risk_flags jsonb not null default '[]'::jsonb,
  latency_ms integer,
  attributes jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.fact_deliveries (
  source_bundle_id text primary key,
  source_decision_id text,
  page_id text not null,
  customer_id text not null,
  created_at timestamptz not null,
  status text,
  text_length integer not null default 0,
  asset_count integer not null default 0,
  sent_at timestamptz,
  attempt_count integer not null default 0,
  last_error text,
  attributes jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.fact_sla (
  source_sla_id text primary key,
  source_event_id text,
  page_id text not null,
  customer_id text not null,
  deadline_at timestamptz not null,
  status text not null,
  resolution text,
  resolved_at timestamptz,
  response_ms integer,
  attributes jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.fact_daily_ad_performance (
  report_date date not null,
  page_id text not null default '*',
  ad_account_id text not null default '*',
  campaign_id text not null default '*',
  adset_id text not null default '*',
  ad_id text not null default '*',
  spend numeric(18,4) not null default 0,
  impressions bigint not null default 0,
  reach bigint not null default 0,
  clicks bigint not null default 0,
  conversations bigint not null default 0,
  customers bigint not null default 0,
  contacts bigint not null default 0,
  deliveries bigint not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key(report_date,page_id,ad_account_id,campaign_id,adset_id,ad_id)
);

create table public.reporting_worker_heartbeats (
  worker_name text primary key,
  worker_version text not null,
  status text not null,
  details jsonb not null default '{}'::jsonb,
  last_error text,
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_reporting_ingest_time on public.reporting_ingest_events(occurred_at desc);
create index idx_dim_customers_last_seen on public.dim_customers(page_id,last_seen_at desc);
create index idx_fact_messages_page_time on public.fact_messages(page_id,occurred_at desc);
create index idx_fact_messages_ad_time on public.fact_messages(ad_id,occurred_at desc) where ad_id is not null;
create index idx_fact_contacts_page_time on public.fact_contacts(page_id,captured_at desc);
create index idx_fact_decisions_page_time on public.fact_ai_decisions(page_id,occurred_at desc);
create index idx_fact_deliveries_page_time on public.fact_deliveries(page_id,created_at desc);
create index idx_fact_sla_status_deadline on public.fact_sla(status,deadline_at desc);
create index idx_fact_ad_performance_date on public.fact_daily_ad_performance(report_date desc,ad_account_id);

alter table public.reporting_runtime_config enable row level security;
alter table public.reporting_ingest_events enable row level security;
alter table public.dim_pages enable row level security;
alter table public.dim_customers enable row level security;
alter table public.dim_ads enable row level security;
alter table public.dim_staff enable row level security;
alter table public.fact_messages enable row level security;
alter table public.fact_contacts enable row level security;
alter table public.fact_ai_decisions enable row level security;
alter table public.fact_deliveries enable row level security;
alter table public.fact_sla enable row level security;
alter table public.fact_daily_ad_performance enable row level security;
alter table public.reporting_worker_heartbeats enable row level security;

revoke all on all tables in schema public from public,anon,authenticated;
revoke all on all sequences in schema public from public,anon,authenticated;

comment on schema public is 'AIGUKA V9 Reporting only. No chatbot state, AI knowledge, raw message text, phone or Zalo values.';
