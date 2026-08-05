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
set search_path='public'
as $function$
declare
  v_result jsonb;
  v_from date:=coalesce(p_from,current_date);
  v_to date:=coalesce(p_to,current_date);
begin
  perform public.v8_assert_admin_request();
  if v_from>v_to then raise exception 'date_from_after_date_to'; end if;
  if v_to-v_from>731 then raise exception 'date_range_too_large'; end if;
  perform set_config('statement_timeout','5000',true);
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
      bool_or(data_match_status in ('matched','runtime_only')) has_runtime_data,
      bool_or(data_match_status in ('matched','ads_only')) has_ads_data
    from src
    group by report_date,page_id,ad_account_id
  ), configured_accounts as (
    select
      aa.ad_account_id,
      aa.ad_account_name,
      aa.currency,
      coalesce(aa.reporting_timezone,aa.timezone_name,'Asia/Ho_Chi_Minh') as account_timezone,
      aa.payment_method_last4,
      link.page_id,
      coalesce(dp.page_name,'Page '||link.page_id) as page_name
    from public.v8_meta_ad_accounts aa
    join lateral (
      select l.page_id
      from public.v8_meta_page_ad_accounts l
      where l.ad_account_id=aa.ad_account_id
        and coalesce(l.purpose,'reporting')='reporting'
      order by l.is_primary desc,l.page_id
      limit 1
    ) link on true
    left join public.dim_pages dp on dp.page_id=link.page_id
    where aa.reporting_enabled=true
      and aa.is_active=true
      and (nullif(btrim(p_ad_account_id),'') is null or aa.ad_account_id=replace(p_ad_account_id,'act_',''))
      and (nullif(btrim(p_page_id),'') is null or link.page_id=p_page_id)
      and nullif(btrim(p_campaign_id),'') is null
      and nullif(btrim(p_adset_id),'') is null
      and nullif(btrim(p_ad_id),'') is null
      and (
        nullif(btrim(p_search),'') is null
        or concat_ws(' ',aa.ad_account_id,aa.ad_account_name,link.page_id,dp.page_name)
          ilike '%'||btrim(p_search)||'%'
      )
  ), account_days as (
    select gs::date as report_date,ca.*
    from generate_series(v_from,v_to,interval '1 day') gs
    cross join configured_accounts ca
  ), zero_delivery as (
    select
      ad.report_date,ad.page_id,ad.page_name,
      ad.ad_account_id,ad.ad_account_name,
      ad.currency,ad.account_timezone,ad.payment_method_last4,
      0::numeric as spend,0::numeric as tax_amount,0::numeric as spend_with_tax,
      0::bigint as impressions,0::bigint as reach,0::bigint as clicks,0::bigint as link_clicks,
      0::bigint as meta_conversations,0::bigint as conversations,0::bigint as contacts,
      0::bigint as hot_leads,0::bigint as message_count,0::bigint as meta_leads,
      false as has_runtime_data,true as has_ads_data
    from account_days ad
    where not exists (
      select 1 from agg a
      where a.report_date=ad.report_date
        and a.ad_account_id=ad.ad_account_id
    )
  ), completed as (
    select * from agg
    union all
    select * from zero_delivery
  ), final as (
    select completed.*,
      case when conversations>0 then round(contacts*100.0/conversations,2) else 0 end contact_rate,
      case when conversations>0 then round(spend_with_tax/conversations,2) else 0 end cost_per_conversation,
      case when contacts>0 then round(spend_with_tax/contacts,2) else 0 end cost_per_contact,
      case
        when has_ads_data and has_runtime_data then 'Meta Ads + hội thoại thực'
        when has_runtime_data then 'Hội thoại thực; chưa có Ads Insights tương ứng'
        when has_ads_data and spend_with_tax=0 and conversations=0 then 'Tài khoản hoạt động; Meta không ghi nhận phân phối trong ngày'
        when has_ads_data then 'Meta Ads; chưa ghi nhận hội thoại thực'
        else 'Chưa có dữ liệu đối chiếu'
      end as data_status
    from completed
  ), paged as (
    select * from final
    order by report_date desc,page_name,ad_account_name nulls last
    limit least(greatest(coalesce(p_limit,100),1),10000)
    offset greatest(coalesce(p_offset,0),0)
  )
  select jsonb_build_object(
    'ok',true,
    'data',coalesce((select jsonb_agg(to_jsonb(p) order by p.report_date desc,p.page_name,p.ad_account_name nulls last) from paged p),'[]'::jsonb),
    'count',(select count(*) from final),
    'warnings',case
      when exists(select 1 from src where data_match_status in ('matched','ads_only')) then '[]'::jsonb
      else '["ADS_INSIGHTS_NOT_SYNCED"]'::jsonb
    end,
    'range',jsonb_build_object('from',v_from,'to',v_to),
    'source','v10_live_reporting_unified'
  ) into v_result;
  return v_result;
end;
$function$;
