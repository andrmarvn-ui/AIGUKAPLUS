-- Keep the stable V8 admin UI contract while moving all heavy report reads to
-- the V9 materialized Reporting read model. This view is projection-only: no
-- joins, raw messages, dynamic attribution, parity checks or Meta API calls.
create or replace view public.v9_report_compat_performance as
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
  coalesce(nullif(f.metadata->>'spend_before_tax','')::numeric,f.spend) as spend,
  coalesce(nullif(f.metadata->>'tax_amount','')::numeric,0) as tax_amount,
  f.spend as spend_with_tax,
  f.impressions,
  f.reach,
  f.clicks,
  coalesce(nullif(f.metadata->>'link_clicks','')::bigint,0) as link_clicks,
  coalesce(nullif(f.metadata->>'meta_conversations','')::bigint,0) as meta_conversations,
  f.conversations,
  f.contacts,
  coalesce(nullif(f.metadata->>'hot_leads','')::bigint,0) as hot_leads,
  coalesce(nullif(f.metadata->>'message_count','')::bigint,0) as message_count,
  coalesce(nullif(f.metadata->>'meta_leads','')::bigint,0) as meta_leads,
  coalesce(nullif(f.metadata->>'data_match_status',''),'unknown') as data_match_status,
  f.updated_at
from public.fact_daily_ad_performance f;

revoke all on public.v9_report_compat_performance from public, anon, authenticated;

drop function if exists public.v9_report_compat_filter(date,date,text,text,text,text,text,text);
create function public.v9_report_compat_filter(
  p_from date,
  p_to date,
  p_page_id text,
  p_ad_account_id text,
  p_campaign_id text,
  p_adset_id text,
  p_ad_id text,
  p_search text
) returns setof public.v9_report_compat_performance
language sql
stable
security definer
set search_path to 'public'
as $function$
  select r.*
  from public.v9_report_compat_performance r
  where r.report_date between coalesce(p_from,current_date) and coalesce(p_to,current_date)
    and (nullif(btrim(p_page_id),'') is null or r.page_id=p_page_id)
    and (nullif(btrim(p_ad_account_id),'') is null or r.ad_account_id=replace(p_ad_account_id,'act_',''))
    and (nullif(btrim(p_campaign_id),'') is null or r.campaign_id=p_campaign_id)
    and (nullif(btrim(p_adset_id),'') is null or r.adset_id=p_adset_id)
    and (nullif(btrim(p_ad_id),'') is null or r.ad_id=p_ad_id)
    and (
      nullif(btrim(p_search),'') is null
      or concat_ws(' ',r.page_name,r.ad_account_name,r.campaign_name,r.adset_name,r.ad_name,
                   r.page_id,r.ad_account_id,r.campaign_id,r.adset_id,r.ad_id)
         ilike '%'||btrim(p_search)||'%'
    );
$function$;
revoke all on function public.v9_report_compat_filter(date,date,text,text,text,text,text,text) from public, anon, authenticated;

create or replace function public.v8_report_summary_test(
  p_from date default current_date,
  p_to date default current_date,
  p_page_id text default null,
  p_ad_account_id text default null,
  p_campaign_id text default null,
  p_adset_id text default null,
  p_ad_id text default null,
  p_search text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_result jsonb;
  v_from date:=coalesce(p_from,current_date);
  v_to date:=coalesce(p_to,current_date);
begin
  perform public.v8_assert_admin_request();
  if v_from>v_to then raise exception 'date_from_after_date_to'; end if;
  if v_to-v_from>731 then raise exception 'date_range_too_large'; end if;
  perform set_config('statement_timeout','3000',true);
  with a as (
    select
      coalesce(sum(spend),0) spend,
      coalesce(sum(tax_amount),0) tax_amount,
      coalesce(sum(spend_with_tax),0) spend_with_tax,
      coalesce(sum(impressions),0) impressions,
      coalesce(sum(reach),0) reach,
      coalesce(sum(clicks),0) clicks,
      coalesce(sum(link_clicks),0) link_clicks,
      coalesce(sum(meta_conversations),0) meta_conversations,
      coalesce(sum(conversations),0) conversations,
      coalesce(sum(contacts),0) contacts,
      coalesce(sum(hot_leads),0) hot_leads,
      coalesce(sum(message_count),0) message_count,
      coalesce(sum(meta_leads),0) meta_leads
    from public.v9_report_compat_filter(v_from,v_to,p_page_id,p_ad_account_id,p_campaign_id,p_adset_id,p_ad_id,p_search)
  )
  select jsonb_build_object(
    'ok',true,
    'data',to_jsonb(a)||jsonb_build_object(
      'contact_rate',case when a.conversations>0 then round(a.contacts*100.0/a.conversations,2) else 0 end,
      'cost_per_conversation',case when a.conversations>0 then round(a.spend_with_tax/a.conversations,2) else 0 end,
      'cost_per_contact',case when a.contacts>0 then round(a.spend_with_tax/a.contacts,2) else 0 end
    ),
    'range',jsonb_build_object('from',v_from,'to',v_to),
    'source','v9_reporting_fact'
  ) into v_result from a;
  return v_result;
end;
$function$;

create or replace function public.v8_report_daily_test(
  p_from date default current_date,
  p_to date default current_date,
  p_page_id text default null,
  p_ad_account_id text default null,
  p_campaign_id text default null,
  p_adset_id text default null,
  p_ad_id text default null,
  p_search text default null,
  p_limit integer default 100,
  p_offset integer default 0
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_result jsonb;
  v_from date:=coalesce(p_from,current_date);
  v_to date:=coalesce(p_to,current_date);
begin
  perform public.v8_assert_admin_request();
  if v_from>v_to then raise exception 'date_from_after_date_to'; end if;
  if v_to-v_from>731 then raise exception 'date_range_too_large'; end if;
  perform set_config('statement_timeout','3000',true);
  with src as (
    select * from public.v9_report_compat_filter(v_from,v_to,p_page_id,p_ad_account_id,p_campaign_id,p_adset_id,p_ad_id,p_search)
  ), agg as (
    select
      report_date,page_id,max(page_name) page_name,
      ad_account_id,max(ad_account_name) ad_account_name,
      max(currency) currency,max(account_timezone) account_timezone,
      max(payment_method_last4) payment_method_last4,
      coalesce(sum(spend),0) spend,
      coalesce(sum(tax_amount),0) tax_amount,
      coalesce(sum(spend_with_tax),0) spend_with_tax,
      coalesce(sum(impressions),0) impressions,
      coalesce(sum(reach),0) reach,
      coalesce(sum(clicks),0) clicks,
      coalesce(sum(link_clicks),0) link_clicks,
      coalesce(sum(meta_conversations),0) meta_conversations,
      coalesce(sum(conversations),0) conversations,
      coalesce(sum(contacts),0) contacts,
      coalesce(sum(hot_leads),0) hot_leads,
      coalesce(sum(message_count),0) message_count,
      coalesce(sum(meta_leads),0) meta_leads,
      bool_or(data_match_status like 'runtime%') has_runtime_data,
      bool_or(data_match_status in ('matched','ads_only')) has_ads_data
    from src
    group by report_date,page_id,ad_account_id
  ), final as (
    select agg.*,
      case when conversations>0 then round(contacts*100.0/conversations,2) else 0 end contact_rate,
      case when conversations>0 then round(spend_with_tax/conversations,2) else 0 end cost_per_conversation,
      case when contacts>0 then round(spend_with_tax/contacts,2) else 0 end cost_per_contact,
      case when has_ads_data then 'Meta Ads + hội thoại thực' else 'Hội thoại thực; Ads Insights chưa đồng bộ' end data_status
    from agg
  ), paged as (
    select * from final
    order by report_date desc,page_name,ad_account_name
    limit least(greatest(coalesce(p_limit,100),1),10000)
    offset greatest(coalesce(p_offset,0),0)
  )
  select jsonb_build_object(
    'ok',true,
    'data',coalesce((select jsonb_agg(to_jsonb(p) order by p.report_date desc,p.page_name,p.ad_account_name) from paged p),'[]'::jsonb),
    'count',(select count(*) from final),
    'warnings',case when exists(select 1 from src where data_match_status in ('matched','ads_only')) then '[]'::jsonb else '["ADS_INSIGHTS_NOT_SYNCED"]'::jsonb end,
    'range',jsonb_build_object('from',v_from,'to',v_to),
    'source','v9_reporting_fact'
  ) into v_result;
  return v_result;
end;
$function$;

create or replace function public.v8_report_ads_test(
  p_from date default current_date,
  p_to date default current_date,
  p_page_id text default null,
  p_ad_account_id text default null,
  p_campaign_id text default null,
  p_adset_id text default null,
  p_ad_id text default null,
  p_search text default null,
  p_limit integer default 100,
  p_offset integer default 0
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_result jsonb;
  v_from date:=coalesce(p_from,current_date);
  v_to date:=coalesce(p_to,current_date);
begin
  perform public.v8_assert_admin_request();
  if v_from>v_to then raise exception 'date_from_after_date_to'; end if;
  if v_to-v_from>731 then raise exception 'date_range_too_large'; end if;
  perform set_config('statement_timeout','3000',true);
  with src as (
    select * from public.v9_report_compat_filter(v_from,v_to,p_page_id,p_ad_account_id,p_campaign_id,p_adset_id,p_ad_id,p_search)
  ), agg as (
    select
      page_id,max(page_name) page_name,
      ad_account_id,max(ad_account_name) ad_account_name,
      max(campaign_id) campaign_id,max(campaign_name) campaign_name,
      max(adset_id) adset_id,max(adset_name) adset_name,
      ad_id,max(ad_name) ad_name,max(effective_status) effective_status,
      max(currency) currency,max(payment_method_last4) payment_method_last4,max(data_match_status) data_match_status,
      coalesce(sum(spend),0) spend,
      coalesce(sum(tax_amount),0) tax_amount,
      coalesce(sum(spend_with_tax),0) spend_with_tax,
      coalesce(sum(impressions),0) impressions,
      coalesce(sum(reach),0) reach,
      coalesce(sum(clicks),0) clicks,
      coalesce(sum(link_clicks),0) link_clicks,
      coalesce(sum(meta_conversations),0) meta_conversations,
      coalesce(sum(conversations),0) conversations,
      coalesce(sum(contacts),0) contacts,
      coalesce(sum(hot_leads),0) hot_leads,
      coalesce(sum(message_count),0) message_count,
      coalesce(sum(meta_leads),0) meta_leads
    from src
    group by page_id,ad_account_id,ad_id
  ), final as (
    select agg.*,
      case when conversations>0 then round(contacts*100.0/conversations,2) else 0 end contact_rate,
      case when conversations>0 then round(spend_with_tax/conversations,2) else 0 end cost_per_conversation,
      case when contacts>0 then round(spend_with_tax/contacts,2) else 0 end cost_per_contact
    from agg
  ), paged as (
    select * from final
    order by spend_with_tax desc,conversations desc
    limit least(greatest(coalesce(p_limit,100),1),10000)
    offset greatest(coalesce(p_offset,0),0)
  )
  select jsonb_build_object(
    'ok',true,
    'data',coalesce((select jsonb_agg(to_jsonb(p) order by p.spend_with_tax desc,p.conversations desc) from paged p),'[]'::jsonb),
    'count',(select count(*) from final),
    'range',jsonb_build_object('from',v_from,'to',v_to),
    'source','v9_reporting_fact'
  ) into v_result;
  return v_result;
end;
$function$;

revoke all on function public.v8_report_summary_test(date,date,text,text,text,text,text,text) from public;
revoke all on function public.v8_report_daily_test(date,date,text,text,text,text,text,text,integer,integer) from public;
revoke all on function public.v8_report_ads_test(date,date,text,text,text,text,text,text,integer,integer) from public;
grant execute on function public.v8_report_summary_test(date,date,text,text,text,text,text,text) to anon,authenticated,service_role;
grant execute on function public.v8_report_daily_test(date,date,text,text,text,text,text,text,integer,integer) to anon,authenticated,service_role;
grant execute on function public.v8_report_ads_test(date,date,text,text,text,text,text,text,integer,integer) to anon,authenticated,service_role;
