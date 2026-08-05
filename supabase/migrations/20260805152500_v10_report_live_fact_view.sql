create or replace view public.v9_report_compat_performance as
with ads_base as (
  select
    f.report_date,
    f.page_id,
    coalesce(nullif(f.metadata->>'page_name',''),f.page_id) as page_name,
    f.ad_account_id,
    coalesce(nullif(f.metadata->>'ad_account_name',''),f.ad_account_id) as ad_account_name,
    f.campaign_id,
    coalesce(nullif(f.metadata->>'campaign_name',''),f.campaign_id) as campaign_name,
    f.adset_id,
    coalesce(nullif(f.metadata->>'adset_name',''),f.adset_id) as adset_name,
    f.ad_id,
    coalesce(nullif(f.metadata->>'ad_name',''),f.ad_id) as ad_name,
    coalesce(nullif(f.metadata->>'effective_status',''),'UNKNOWN') as effective_status,
    coalesce(nullif(f.metadata->>'currency',''),'VND') as currency,
    coalesce(nullif(f.metadata->>'account_timezone',''),'Asia/Ho_Chi_Minh') as account_timezone,
    nullif(f.metadata->>'payment_method_last4','') as payment_method_last4,
    coalesce(
      nullif(f.metadata->>'spend_before_tax','')::numeric,
      case when f.spend>0 then round(f.spend/1.05,2) else 0::numeric end
    ) as spend,
    round(coalesce(
      nullif(f.metadata->>'spend_before_tax','')::numeric,
      case when f.spend>0 then round(f.spend/1.05,2) else 0::numeric end
    )*0.05,2) as tax_amount,
    round(coalesce(
      nullif(f.metadata->>'spend_before_tax','')::numeric,
      case when f.spend>0 then round(f.spend/1.05,2) else 0::numeric end
    )*1.05,2)::numeric(18,4) as spend_with_tax,
    f.impressions::bigint as impressions,
    f.reach::bigint as reach,
    f.clicks::bigint as clicks,
    coalesce(nullif(f.metadata->>'link_clicks','')::bigint,0::bigint) as link_clicks,
    coalesce(nullif(f.metadata->>'meta_conversations','')::bigint,0::bigint) as meta_conversations,
    coalesce(nullif(f.metadata->>'meta_leads','')::bigint,0::bigint) as meta_leads,
    f.updated_at
  from public.fact_daily_ad_performance f
), message_base as (
  select
    (m.occurred_at at time zone 'Asia/Ho_Chi_Minh')::date as report_date,
    m.page_id,
    m.customer_id,
    m.occurred_at,
    nullif(btrim(m.ad_id),'') as ad_id
  from public.fact_messages m
  where m.actor_type='customer'
    and m.event_type in ('customer_message','customer_postback')
    and nullif(btrim(m.page_id),'') is not null
    and nullif(btrim(m.customer_id),'') is not null
    and m.customer_id <> m.page_id
), customer_day as (
  select
    mb.report_date,
    mb.page_id,
    mb.customer_id,
    max(mb.occurred_at) as last_at,
    count(*)::bigint as message_count,
    (array_agg(mb.ad_id order by mb.occurred_at) filter(where mb.ad_id is not null))[1] as ad_id
  from message_base mb
  group by mb.report_date,mb.page_id,mb.customer_id
), contact_rollup as (
  select c.page_id,c.customer_id,min(c.captured_at) as contact_at
  from public.fact_contacts c
  group by c.page_id,c.customer_id
), runtime_by_ad as (
  select
    cd.report_date,
    cd.page_id,
    cd.ad_id,
    count(*)::bigint as conversations,
    count(*) filter(
      where cr.contact_at is not null
        and cr.contact_at <= cd.last_at + interval '1 day'
    )::bigint as contacts,
    count(*) filter(
      where cr.contact_at is not null
        and cr.contact_at <= cd.last_at + interval '1 day'
    )::bigint as hot_leads,
    sum(cd.message_count)::bigint as message_count,
    max(cd.last_at) as updated_at
  from customer_day cd
  left join contact_rollup cr
    on cr.page_id=cd.page_id and cr.customer_id=cd.customer_id
  group by cd.report_date,cd.page_id,cd.ad_id
), matched_and_ads_only as (
  select
    a.report_date,
    a.page_id,
    a.page_name,
    a.ad_account_id,
    a.ad_account_name,
    a.campaign_id,
    a.campaign_name,
    a.adset_id,
    a.adset_name,
    a.ad_id,
    a.ad_name,
    a.effective_status,
    a.currency,
    a.account_timezone,
    a.payment_method_last4,
    a.spend,
    a.tax_amount,
    a.spend_with_tax,
    a.impressions,
    a.reach,
    a.clicks,
    a.link_clicks,
    a.meta_conversations,
    coalesce(r.conversations,0::bigint)::bigint as conversations,
    coalesce(r.contacts,0::bigint)::bigint as contacts,
    coalesce(r.hot_leads,0::bigint)::bigint as hot_leads,
    coalesce(r.message_count,0::bigint)::bigint as message_count,
    a.meta_leads,
    case when r.page_id is not null then 'matched' else 'ads_only' end::text as data_match_status,
    greatest(a.updated_at,coalesce(r.updated_at,a.updated_at)) as updated_at
  from ads_base a
  left join runtime_by_ad r
    on r.report_date=a.report_date
   and r.page_id=a.page_id
   and r.ad_id=a.ad_id
), runtime_only as (
  select
    r.report_date,
    r.page_id,
    coalesce(dp.page_name,'Page '||r.page_id) as page_name,
    da.ad_account_id,
    da.ad_account_name,
    da.campaign_id,
    da.campaign_name,
    da.adset_id,
    da.adset_name,
    r.ad_id,
    coalesce(da.ad_name,case when r.ad_id is null then 'Tự nhiên / chưa xác định' else r.ad_id end) as ad_name,
    coalesce(da.effective_status,case when r.ad_id is null then 'ORGANIC' else 'UNKNOWN' end) as effective_status,
    coalesce(aa.currency,'VND') as currency,
    coalesce(aa.reporting_timezone,aa.timezone_name,'Asia/Ho_Chi_Minh') as account_timezone,
    aa.payment_method_last4,
    0::numeric as spend,
    0::numeric as tax_amount,
    0::numeric(18,4) as spend_with_tax,
    0::bigint as impressions,
    0::bigint as reach,
    0::bigint as clicks,
    0::bigint as link_clicks,
    0::bigint as meta_conversations,
    r.conversations::bigint,
    r.contacts::bigint,
    r.hot_leads::bigint,
    r.message_count::bigint,
    0::bigint as meta_leads,
    'runtime_only'::text as data_match_status,
    r.updated_at
  from runtime_by_ad r
  left join public.dim_pages dp on dp.page_id=r.page_id
  left join public.dim_ads da on da.ad_id=r.ad_id
  left join public.v8_meta_ad_accounts aa on aa.ad_account_id=da.ad_account_id
  where not exists (
    select 1
    from ads_base a
    where a.report_date=r.report_date
      and a.page_id=r.page_id
      and a.ad_id is not distinct from r.ad_id
  )
)
select * from matched_and_ads_only
union all
select * from runtime_only;
