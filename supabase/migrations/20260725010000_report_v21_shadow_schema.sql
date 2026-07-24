-- Report V2.1 shadow schema.
-- Additive only: no existing view, RPC, worker, trigger or dashboard route is replaced.

create table if not exists public.v8_report_v21_referral_fact (
  event_id uuid primary key,
  page_id text not null,
  sender_id text,
  customer_id uuid,
  conversation_id text,
  message_id text,
  referral_at timestamptz not null,
  ad_id text not null,
  ad_title text,
  post_id text,
  referral_source text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  source_payload jsonb not null default '{}'::jsonb
);

create index if not exists idx_v8_report_v21_referral_sender
  on public.v8_report_v21_referral_fact(page_id,sender_id,referral_at desc);
create index if not exists idx_v8_report_v21_referral_customer
  on public.v8_report_v21_referral_fact(page_id,customer_id,referral_at desc)
  where customer_id is not null;
create index if not exists idx_v8_report_v21_referral_ad
  on public.v8_report_v21_referral_fact(ad_id,referral_at desc);

create table if not exists public.v8_report_v21_conversation_fact (
  source_channel text not null default 'unknown',
  conversation_id text not null,
  tenant_id uuid,
  page_id text not null,
  page_name text,
  sender_id text not null,
  customer_id text,
  customer_name text,
  conversation_started_at timestamptz not null,
  conversation_date_vn date not null,
  message_count integer not null default 0,

  ad_id text,
  ad_name_at_start text,
  ad_name_current text,
  ad_account_id text,
  ad_account_name text,
  campaign_id text,
  campaign_name text,
  adset_id text,
  adset_name text,
  ad_status_at_start text,
  ad_status_current text,

  attribution_source text not null default 'unattributed',
  attribution_confidence smallint not null default 0,
  attribution_reason text,
  referral_at timestamptz,

  phone text,
  zalo text,
  has_contact boolean not null default false,
  is_hot_lead boolean not null default false,
  lead_score numeric,
  lead_level smallint,
  product_group text,
  product_label text,
  lead_status text,
  pancake_tags jsonb not null default '[]'::jsonb,
  pancake_employee text,
  pancake_status text,
  last_snippet text,
  identity_source text,

  source_created_at timestamptz,
  source_updated_at timestamptz,
  fact_version integer not null default 21,
  refreshed_at timestamptz not null default now(),

  primary key(source_channel,conversation_id)
);

create index if not exists idx_v8_report_v21_conversation_date_filters
  on public.v8_report_v21_conversation_fact(
    conversation_date_vn,page_id,ad_account_id,campaign_id,adset_id,ad_id
  );
create index if not exists idx_v8_report_v21_conversation_sender
  on public.v8_report_v21_conversation_fact(page_id,sender_id,conversation_started_at desc);
create index if not exists idx_v8_report_v21_conversation_contact
  on public.v8_report_v21_conversation_fact(conversation_date_vn,has_contact);
create index if not exists idx_v8_report_v21_conversation_started
  on public.v8_report_v21_conversation_fact(conversation_started_at desc);
create index if not exists idx_v8_report_v21_conversation_search
  on public.v8_report_v21_conversation_fact
  using gin(to_tsvector('simple',
    coalesce(customer_name,'')||' '||coalesce(phone,'')||' '||
    coalesce(zalo,'')||' '||coalesce(ad_name_current,'')||' '||
    coalesce(last_snippet,'')
  ));

create table if not exists public.v8_report_v21_customer_day_fact (
  report_date date not null,
  page_id text not null,
  sender_id text not null,
  page_name text,
  customer_id text,
  customer_name text,
  first_conversation_at timestamptz,
  last_conversation_at timestamptz,
  conversation_count integer not null default 0,
  message_count integer not null default 0,
  has_contact boolean not null default false,
  is_hot_lead boolean not null default false,
  phone text,
  zalo text,
  primary_ad_id text,
  ad_ids jsonb not null default '[]'::jsonb,
  ad_count integer not null default 0,
  product_groups jsonb not null default '[]'::jsonb,
  pancake_tags jsonb not null default '[]'::jsonb,
  pancake_employee text,
  pancake_status text,
  last_snippet text,
  fact_version integer not null default 21,
  refreshed_at timestamptz not null default now(),
  primary key(report_date,page_id,sender_id)
);

create index if not exists idx_v8_report_v21_customer_day_filters
  on public.v8_report_v21_customer_day_fact(report_date,page_id,primary_ad_id);
create index if not exists idx_v8_report_v21_customer_day_contact
  on public.v8_report_v21_customer_day_fact(report_date,has_contact);
create index if not exists idx_v8_report_v21_customer_day_last
  on public.v8_report_v21_customer_day_fact(last_conversation_at desc);

create table if not exists public.v8_report_v21_ad_day_fact (
  report_date date not null,
  page_id text not null default '',
  page_name text,
  ad_account_id text not null default '',
  ad_account_name text,
  campaign_id text not null default '',
  campaign_name text,
  adset_id text not null default '',
  adset_name text,
  ad_id text not null default '',
  ad_name text,
  effective_status text,
  currency text,
  account_timezone text,
  payment_method_last4 text,

  spend numeric not null default 0,
  tax_amount numeric not null default 0,
  spend_with_tax numeric not null default 0,
  impressions bigint not null default 0,
  reach bigint not null default 0,
  clicks bigint not null default 0,
  link_clicks bigint not null default 0,
  meta_conversations bigint not null default 0,
  meta_leads bigint not null default 0,

  conversations bigint not null default 0,
  customers bigint not null default 0,
  contacts bigint not null default 0,
  hot_leads bigint not null default 0,
  message_count bigint not null default 0,

  data_match_status text not null default 'runtime_only',
  latest_source_at timestamptz,
  fact_version integer not null default 21,
  refreshed_at timestamptz not null default now(),

  primary key(report_date,page_id,ad_account_id,campaign_id,adset_id,ad_id)
);

create index if not exists idx_v8_report_v21_ad_day_filters
  on public.v8_report_v21_ad_day_fact(
    report_date,page_id,ad_account_id,campaign_id,adset_id,ad_id
  );
create index if not exists idx_v8_report_v21_ad_day_spend
  on public.v8_report_v21_ad_day_fact(report_date,spend_with_tax desc);
create index if not exists idx_v8_report_v21_ad_day_status
  on public.v8_report_v21_ad_day_fact(report_date,effective_status);

create table if not exists public.v8_report_v21_dirty_keys (
  report_date date not null,
  page_id text not null,
  reason text not null default 'source_changed',
  priority smallint not null default 50,
  status text not null default 'pending',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(report_date,page_id),
  check(status in ('pending','processing','retry','completed','dead_letter'))
);

create index if not exists idx_v8_report_v21_dirty_claim
  on public.v8_report_v21_dirty_keys(priority,available_at,created_at)
  where status in ('pending','retry');
create index if not exists idx_v8_report_v21_dirty_stale
  on public.v8_report_v21_dirty_keys(locked_at)
  where status='processing';

create table if not exists public.v8_report_v21_state (
  state_key text primary key,
  state_value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.v8_report_v21_metrics (
  id bigint generated always as identity primary key,
  operation text not null,
  report_date date,
  page_id text,
  started_at timestamptz not null,
  completed_at timestamptz not null default now(),
  duration_ms numeric not null default 0,
  rows_affected integer not null default 0,
  status text not null,
  details jsonb not null default '{}'::jsonb
);

create index if not exists idx_v8_report_v21_metrics_time
  on public.v8_report_v21_metrics(completed_at desc);
create index if not exists idx_v8_report_v21_metrics_operation
  on public.v8_report_v21_metrics(operation,completed_at desc);

alter table public.v8_report_v21_referral_fact enable row level security;
alter table public.v8_report_v21_conversation_fact enable row level security;
alter table public.v8_report_v21_customer_day_fact enable row level security;
alter table public.v8_report_v21_ad_day_fact enable row level security;
alter table public.v8_report_v21_dirty_keys enable row level security;
alter table public.v8_report_v21_state enable row level security;
alter table public.v8_report_v21_metrics enable row level security;

revoke all on table public.v8_report_v21_referral_fact from anon,authenticated;
revoke all on table public.v8_report_v21_conversation_fact from anon,authenticated;
revoke all on table public.v8_report_v21_customer_day_fact from anon,authenticated;
revoke all on table public.v8_report_v21_ad_day_fact from anon,authenticated;
revoke all on table public.v8_report_v21_dirty_keys from anon,authenticated;
revoke all on table public.v8_report_v21_state from anon,authenticated;
revoke all on table public.v8_report_v21_metrics from anon,authenticated;
