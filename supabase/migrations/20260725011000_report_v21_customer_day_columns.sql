alter table public.v8_report_v21_customer_day_fact
  add column if not exists ad_id text,
  add column if not exists ad_name text,
  add column if not exists ad_account_id text,
  add column if not exists ad_account_name text,
  add column if not exists campaign_id text,
  add column if not exists campaign_name text,
  add column if not exists adset_id text,
  add column if not exists adset_name text,
  add column if not exists effective_status text,
  add column if not exists currency text,
  add column if not exists account_timezone text,
  add column if not exists payment_method_last4 text,
  add column if not exists attribution_source text not null default 'unattributed',
  add column if not exists attribution_confidence smallint not null default 0,
  add column if not exists referral_at timestamptz;

create index if not exists idx_v8_report_v21_customer_day_ad_filters
  on public.v8_report_v21_customer_day_fact(
    report_date,page_id,ad_account_id,campaign_id,adset_id,ad_id
  );
