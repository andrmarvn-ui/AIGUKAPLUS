create or replace function public.v8_report_filters_v21()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.v8_assert_admin_request();
  return jsonb_build_object(
    'ok',true,'version','2.1-shadow',
    'data',jsonb_build_object(
      'pages',coalesce((select jsonb_agg(to_jsonb(x) order by x.page_name) from (
        select page_id,page_name,bot_mode,is_active from public.v8_meta_page_registry
      ) x),'[]'::jsonb),
      'ad_accounts',coalesce((select jsonb_agg(to_jsonb(x) order by x.ad_account_name) from (
        select ad_account_id,ad_account_name,account_status,currency,timezone_name
        from public.v8_meta_ad_account_registry
      ) x),'[]'::jsonb),
      'ads',coalesce((select jsonb_agg(to_jsonb(x) order by x.campaign_name,x.adset_name,x.ad_name) from (
        select ad_account_id,ad_account_name,campaign_id,campaign_name,
               adset_id,adset_name,ad_id,ad_name,effective_status
        from public.ad_mappings
      ) x),'[]'::jsonb)
    )
  );
end;
$function$;

create or replace function public.v8_report_summary_v21(
  p_from date default ((now() at time zone 'Asia/Ho_Chi_Minh')::date),
  p_to date default ((now() at time zone 'Asia/Ho_Chi_Minh')::date),
  p_page_id text default null,p_ad_account_id text default null,
  p_campaign_id text default null,p_adset_id text default null,
  p_ad_id text default null,p_search text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_result jsonb;
begin
  perform public.v8_assert_admin_request();
  with src as materialized (
    select * from public.v8_report_v21_ad_day_fact r
    where r.report_date between coalesce(p_from,(now() at time zone 'Asia/Ho_Chi_Minh')::date)
                            and coalesce(p_to,(now() at time zone 'Asia/Ho_Chi_Minh')::date)
      and (nullif(btrim(p_page_id),'') is null or r.page_id=p_page_id)
      and (nullif(btrim(p_ad_account_id),'') is null or r.ad_account_id=replace(p_ad_account_id,'act_',''))
      and (nullif(btrim(p_campaign_id),'') is null or r.campaign_id=p_campaign_id)
      and (nullif(btrim(p_adset_id),'') is null or r.adset_id=p_adset_id)
      and (nullif(btrim(p_ad_id),'') is null or r.ad_id=p_ad_id)
      and (nullif(btrim(p_search),'') is null or concat_ws(' ',r.ad_name,r.ad_id,r.campaign_name,r.adset_name,r.ad_account_name) ilike '%'||btrim(p_search)||'%')
  ), a as (
    select coalesce(sum(spend),0) spend,coalesce(sum(tax_amount),0) tax_amount,
      coalesce(sum(spend_with_tax),0) spend_with_tax,coalesce(sum(impressions),0) impressions,
      coalesce(sum(reach),0) reach,coalesce(sum(clicks),0) clicks,
      coalesce(sum(link_clicks),0) link_clicks,coalesce(sum(meta_conversations),0) meta_conversations,
      coalesce(sum(conversations),0) conversations,coalesce(sum(contacts),0) contacts,
      coalesce(sum(hot_leads),0) hot_leads,coalesce(sum(message_count),0) message_count,
      coalesce(sum(meta_leads),0) meta_leads
    from src
  )
  select jsonb_build_object(
    'ok',true,'version','2.1-shadow',
    'data',to_jsonb(a)||jsonb_build_object(
      'contact_rate',case when a.conversations>0 then round(a.contacts*100.0/a.conversations,2) else 0 end,
      'cost_per_conversation',case when a.conversations>0 then round(a.spend_with_tax/a.conversations,2) else 0 end,
      'cost_per_contact',case when a.contacts>0 then round(a.spend_with_tax/a.contacts,2) else 0 end
    ),
    'freshness',jsonb_build_object(
      'latest_fact_at',(select max(refreshed_at) from src),
      'pending_keys',(select count(*) from public.v8_report_v21_dirty_keys where status in ('pending','retry','processing'))
    ),
    'range',jsonb_build_object(
      'from',coalesce(p_from,(now() at time zone 'Asia/Ho_Chi_Minh')::date),
      'to',coalesce(p_to,(now() at time zone 'Asia/Ho_Chi_Minh')::date)
    )
  ) into v_result from a;
  return v_result;
end;
$function$;

create or replace function public.v8_report_daily_v21(
  p_from date default ((now() at time zone 'Asia/Ho_Chi_Minh')::date),
  p_to date default ((now() at time zone 'Asia/Ho_Chi_Minh')::date),
  p_page_id text default null,p_ad_account_id text default null,
  p_campaign_id text default null,p_adset_id text default null,
  p_ad_id text default null,p_search text default null,
  p_limit integer default 100,p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_result jsonb;
begin
  perform public.v8_assert_admin_request();
  with src as materialized (
    select * from public.v8_report_v21_ad_day_fact r
    where r.report_date between coalesce(p_from,(now() at time zone 'Asia/Ho_Chi_Minh')::date)
                            and coalesce(p_to,(now() at time zone 'Asia/Ho_Chi_Minh')::date)
      and (nullif(btrim(p_page_id),'') is null or r.page_id=p_page_id)
      and (nullif(btrim(p_ad_account_id),'') is null or r.ad_account_id=replace(p_ad_account_id,'act_',''))
      and (nullif(btrim(p_campaign_id),'') is null or r.campaign_id=p_campaign_id)
      and (nullif(btrim(p_adset_id),'') is null or r.adset_id=p_adset_id)
      and (nullif(btrim(p_ad_id),'') is null or r.ad_id=p_ad_id)
      and (nullif(btrim(p_search),'') is null or concat_ws(' ',r.page_name,r.ad_name,r.ad_id,r.campaign_name,r.adset_name,r.ad_account_name) ilike '%'||btrim(p_search)||'%')
  ), agg as (
    select report_date,page_id,max(page_name) page_name,
      ad_account_id,max(ad_account_name) ad_account_name,
      max(currency) currency,max(account_timezone) account_timezone,
      max(payment_method_last4) payment_method_last4,
      coalesce(sum(spend),0) spend,coalesce(sum(tax_amount),0) tax_amount,
      coalesce(sum(spend_with_tax),0) spend_with_tax,coalesce(sum(impressions),0) impressions,
      coalesce(sum(reach),0) reach,coalesce(sum(clicks),0) clicks,
      coalesce(sum(link_clicks),0) link_clicks,coalesce(sum(meta_conversations),0) meta_conversations,
      coalesce(sum(conversations),0) conversations,coalesce(sum(contacts),0) contacts,
      coalesce(sum(hot_leads),0) hot_leads,coalesce(sum(message_count),0) message_count,
      coalesce(sum(meta_leads),0) meta_leads,
      bool_or(data_match_status in ('matched','ads_only')) has_ads_data,
      max(refreshed_at) refreshed_at
    from src group by report_date,page_id,ad_account_id
  ), final as (
    select agg.*,
      case when conversations>0 then round(contacts*100.0/conversations,2) else 0 end contact_rate,
      case when conversations>0 then round(spend_with_tax/conversations,2) else 0 end cost_per_conversation,
      case when contacts>0 then round(spend_with_tax/contacts,2) else 0 end cost_per_contact,
      case when has_ads_data then 'Meta Ads + hội thoại thực' else 'Hội thoại thực; Ads Insights chưa đồng bộ' end data_status
    from agg
  ), paged as (
    select * from final order by report_date desc,page_name,ad_account_name
    limit least(greatest(coalesce(p_limit,100),1),10000)
    offset greatest(coalesce(p_offset,0),0)
  )
  select jsonb_build_object(
    'ok',true,'version','2.1-shadow',
    'data',coalesce((select jsonb_agg(to_jsonb(p) order by p.report_date desc,p.page_name,p.ad_account_name) from paged p),'[]'::jsonb),
    'count',(select count(*) from final),
    'warnings',case when exists(select 1 from src where data_match_status in ('matched','ads_only')) then '[]'::jsonb else '["ADS_INSIGHTS_NOT_SYNCED"]'::jsonb end,
    'range',jsonb_build_object(
      'from',coalesce(p_from,(now() at time zone 'Asia/Ho_Chi_Minh')::date),
      'to',coalesce(p_to,(now() at time zone 'Asia/Ho_Chi_Minh')::date)
    )
  ) into v_result;
  return v_result;
end;
$function$;

create or replace function public.v8_report_ads_v21(
  p_from date default ((now() at time zone 'Asia/Ho_Chi_Minh')::date),
  p_to date default ((now() at time zone 'Asia/Ho_Chi_Minh')::date),
  p_page_id text default null,p_ad_account_id text default null,
  p_campaign_id text default null,p_adset_id text default null,
  p_ad_id text default null,p_search text default null,
  p_limit integer default 100,p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_result jsonb;
begin
  perform public.v8_assert_admin_request();
  with src as materialized (
    select * from public.v8_report_v21_ad_day_fact r
    where r.report_date between coalesce(p_from,(now() at time zone 'Asia/Ho_Chi_Minh')::date)
                            and coalesce(p_to,(now() at time zone 'Asia/Ho_Chi_Minh')::date)
      and (nullif(btrim(p_page_id),'') is null or r.page_id=p_page_id)
      and (nullif(btrim(p_ad_account_id),'') is null or r.ad_account_id=replace(p_ad_account_id,'act_',''))
      and (nullif(btrim(p_campaign_id),'') is null or r.campaign_id=p_campaign_id)
      and (nullif(btrim(p_adset_id),'') is null or r.adset_id=p_adset_id)
      and (nullif(btrim(p_ad_id),'') is null or r.ad_id=p_ad_id)
      and (nullif(btrim(p_search),'') is null or concat_ws(' ',r.ad_name,r.ad_id,r.campaign_name,r.adset_name,r.ad_account_name) ilike '%'||btrim(p_search)||'%')
  ), agg as (
    select page_id,max(page_name) page_name,
      ad_account_id,max(ad_account_name) ad_account_name,
      max(campaign_id) campaign_id,max(campaign_name) campaign_name,
      max(adset_id) adset_id,max(adset_name) adset_name,
      ad_id,max(ad_name) ad_name,max(effective_status) effective_status,
      max(currency) currency,max(payment_method_last4) payment_method_last4,
      max(data_match_status) data_match_status,
      coalesce(sum(spend),0) spend,coalesce(sum(tax_amount),0) tax_amount,
      coalesce(sum(spend_with_tax),0) spend_with_tax,coalesce(sum(impressions),0) impressions,
      coalesce(sum(reach),0) reach,coalesce(sum(clicks),0) clicks,
      coalesce(sum(link_clicks),0) link_clicks,coalesce(sum(meta_conversations),0) meta_conversations,
      coalesce(sum(conversations),0) conversations,coalesce(sum(contacts),0) contacts,
      coalesce(sum(hot_leads),0) hot_leads,coalesce(sum(message_count),0) message_count,
      coalesce(sum(meta_leads),0) meta_leads,max(refreshed_at) refreshed_at
    from src group by page_id,ad_account_id,ad_id
  ), final as (
    select agg.*,
      case when conversations>0 then round(contacts*100.0/conversations,2) else 0 end contact_rate,
      case when conversations>0 then round(spend_with_tax/conversations,2) else 0 end cost_per_conversation,
      case when contacts>0 then round(spend_with_tax/contacts,2) else 0 end cost_per_contact
    from agg
  ), paged as (
    select * from final order by spend_with_tax desc,conversations desc
    limit least(greatest(coalesce(p_limit,100),1),10000)
    offset greatest(coalesce(p_offset,0),0)
  )
  select jsonb_build_object(
    'ok',true,'version','2.1-shadow',
    'data',coalesce((select jsonb_agg(to_jsonb(p) order by p.spend_with_tax desc,p.conversations desc) from paged p),'[]'::jsonb),
    'count',(select count(*) from final),
    'range',jsonb_build_object(
      'from',coalesce(p_from,(now() at time zone 'Asia/Ho_Chi_Minh')::date),
      'to',coalesce(p_to,(now() at time zone 'Asia/Ho_Chi_Minh')::date)
    )
  ) into v_result;
  return v_result;
end;
$function$;

create or replace function public.v8_report_leads_v21(
  p_from date default ((now() at time zone 'Asia/Ho_Chi_Minh')::date),
  p_to date default ((now() at time zone 'Asia/Ho_Chi_Minh')::date),
  p_page_id text default null,p_ad_account_id text default null,
  p_campaign_id text default null,p_adset_id text default null,
  p_ad_id text default null,p_search text default null,
  p_limit integer default 100,p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_result jsonb;
begin
  perform public.v8_assert_admin_request();
  with resolved as materialized (
    select f.*,
      coalesce(f.ad_account_id,pa.ad_account_id) resolved_ad_account_id,
      coalesce(f.ad_account_name,aa.ad_account_name,
        case when coalesce(f.ad_account_id,pa.ad_account_id) is null then 'Chưa xác định tài khoản QC' end) resolved_ad_account_name,
      coalesce(f.currency,aa.currency,'VND') resolved_currency,
      coalesce(f.account_timezone,aa.reporting_timezone,aa.timezone_name,'Asia/Ho_Chi_Minh') resolved_timezone,
      coalesce(f.payment_method_last4,aa.payment_method_last4) resolved_payment_method
    from public.v8_report_v21_customer_day_fact f
    left join lateral (
      select l.ad_account_id from public.v8_meta_page_ad_accounts l
      where l.page_id=f.page_id order by l.is_primary desc,l.updated_at desc limit 1
    ) pa on true
    left join public.v8_meta_ad_accounts aa on aa.ad_account_id=coalesce(f.ad_account_id,pa.ad_account_id)
    where f.report_date between coalesce(p_from,(now() at time zone 'Asia/Ho_Chi_Minh')::date)
                            and coalesce(p_to,(now() at time zone 'Asia/Ho_Chi_Minh')::date)
      and (nullif(btrim(p_page_id),'') is null or f.page_id=p_page_id)
      and (nullif(btrim(p_campaign_id),'') is null or f.campaign_id=p_campaign_id)
      and (nullif(btrim(p_adset_id),'') is null or f.adset_id=p_adset_id)
      and (nullif(btrim(p_ad_id),'') is null or f.ad_id=p_ad_id)
      and (nullif(btrim(p_search),'') is null or concat_ws(' ',f.customer_name,f.phone,f.zalo,f.sender_id,f.ad_name,f.last_snippet) ilike '%'||btrim(p_search)||'%')
  ), filtered as (
    select
      f.report_date,f.report_date conversation_date_vn,
      'customer-day:'||f.report_date::text||':'||f.page_id||':'||f.sender_id conversation_id,
      f.sender_id,f.customer_id,f.customer_name,f.page_id,f.page_name,
      'raw_customer_day' source_channel,f.first_conversation_at conversation_started_at,
      f.message_count,f.ad_id,f.ad_name,
      f.resolved_ad_account_id ad_account_id,f.resolved_ad_account_name ad_account_name,
      f.campaign_id,f.campaign_name,f.adset_id,f.adset_name,f.effective_status ad_status,
      f.phone,f.zalo,f.has_contact,f.is_hot_lead,
      null::numeric lead_score,null::smallint lead_level,
      case when jsonb_array_length(f.product_groups)>0 then f.product_groups->>0 end product_group,
      case when jsonb_array_length(f.product_groups)>0 then f.product_groups->>0 end product_label,
      null::text lead_status,f.pancake_tags,f.pancake_employee,f.pancake_status,
      f.last_snippet,f.attribution_source identity_source,f.referral_at,
      f.attribution_confidence,f.resolved_currency currency,
      f.resolved_timezone account_timezone,f.resolved_payment_method payment_method_last4,
      f.refreshed_at updated_at,f.refreshed_at created_at
    from resolved f
    where nullif(btrim(p_ad_account_id),'') is null
       or f.resolved_ad_account_id=replace(p_ad_account_id,'act_','')
  ), paged as (
    select * from filtered order by conversation_started_at desc nulls last
    limit least(greatest(coalesce(p_limit,100),1),10000)
    offset greatest(coalesce(p_offset,0),0)
  )
  select jsonb_build_object(
    'ok',true,'version','2.1-shadow','grain','customer_per_page_per_vietnam_day',
    'data',coalesce((select jsonb_agg(to_jsonb(p) order by p.conversation_started_at desc nulls last) from paged p),'[]'::jsonb),
    'count',(select count(*) from filtered),
    'range',jsonb_build_object(
      'from',coalesce(p_from,(now() at time zone 'Asia/Ho_Chi_Minh')::date),
      'to',coalesce(p_to,(now() at time zone 'Asia/Ho_Chi_Minh')::date)
    )
  ) into v_result;
  return v_result;
end;
$function$;

create or replace function public.v8_report_v21_parity(
  p_from date default ((now() at time zone 'Asia/Ho_Chi_Minh')::date-7),
  p_to date default ((now() at time zone 'Asia/Ho_Chi_Minh')::date)
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_from date:=coalesce(p_from,(now() at time zone 'Asia/Ho_Chi_Minh')::date-7);
  v_to date:=coalesce(p_to,(now() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_result jsonb;
begin
  perform public.v8_assert_admin_request();
  with old as (
    select report_date,page_id,coalesce(ad_account_id,'') ad_account_id,
      coalesce(campaign_id,'') campaign_id,coalesce(adset_id,'') adset_id,
      coalesce(ad_id,'') ad_id,sum(conversations)::bigint conversations,
      sum(contacts)::bigint contacts,sum(hot_leads)::bigint hot_leads,
      sum(message_count)::bigint message_count
    from public.v8_report_ad_performance_daily
    where report_date between v_from and v_to
    group by report_date,page_id,coalesce(ad_account_id,''),coalesce(campaign_id,''),coalesce(adset_id,''),coalesce(ad_id,'')
  ), new as (
    select report_date,page_id,ad_account_id,campaign_id,adset_id,ad_id,
      sum(conversations)::bigint conversations,sum(contacts)::bigint contacts,
      sum(hot_leads)::bigint hot_leads,sum(message_count)::bigint message_count
    from public.v8_report_v21_ad_day_fact
    where report_date between v_from and v_to
    group by report_date,page_id,ad_account_id,campaign_id,adset_id,ad_id
  ), joined as (
    select coalesce(o.report_date,n.report_date) report_date,
      coalesce(o.page_id,n.page_id) page_id,coalesce(o.ad_account_id,n.ad_account_id) ad_account_id,
      coalesce(o.campaign_id,n.campaign_id) campaign_id,coalesce(o.adset_id,n.adset_id) adset_id,
      coalesce(o.ad_id,n.ad_id) ad_id,o.report_date is not null old_exists,n.report_date is not null new_exists,
      coalesce(o.conversations,0) old_conversations,coalesce(n.conversations,0) new_conversations,
      coalesce(o.contacts,0) old_contacts,coalesce(n.contacts,0) new_contacts,
      coalesce(o.hot_leads,0) old_hot_leads,coalesce(n.hot_leads,0) new_hot_leads,
      coalesce(o.message_count,0) old_message_count,coalesce(n.message_count,0) new_message_count
    from old o full join new n using(report_date,page_id,ad_account_id,campaign_id,adset_id,ad_id)
  ), mismatches as (
    select * from joined
    where old_exists is distinct from new_exists
       or old_conversations<>new_conversations or old_contacts<>new_contacts
       or old_hot_leads<>new_hot_leads or old_message_count<>new_message_count
  )
  select jsonb_build_object(
    'ok',true,'from',v_from,'to',v_to,'total_keys',(select count(*) from joined),
    'mismatch_count',(select count(*) from mismatches),'matched',(select count(*)=0 from mismatches),
    'mismatches',coalesce((select jsonb_agg(to_jsonb(m) order by report_date desc,page_id,ad_account_id,ad_id) from (select * from mismatches limit 100) m),'[]'::jsonb),
    'v21_status',public.v8_report_v21_status()
  ) into v_result;
  return v_result;
end;
$function$;

create or replace function public.v8_report_v21_status_admin()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.v8_assert_admin_request();
  return public.v8_report_v21_status();
end;
$function$;

grant execute on function public.v8_report_filters_v21() to anon,authenticated,service_role;
grant execute on function public.v8_report_summary_v21(date,date,text,text,text,text,text,text) to anon,authenticated,service_role;
grant execute on function public.v8_report_daily_v21(date,date,text,text,text,text,text,text,integer,integer) to anon,authenticated,service_role;
grant execute on function public.v8_report_ads_v21(date,date,text,text,text,text,text,text,integer,integer) to anon,authenticated,service_role;
grant execute on function public.v8_report_leads_v21(date,date,text,text,text,text,text,text,integer,integer) to anon,authenticated,service_role;
grant execute on function public.v8_report_v21_parity(date,date) to anon,authenticated,service_role;
grant execute on function public.v8_report_v21_status_admin() to anon,authenticated,service_role;
