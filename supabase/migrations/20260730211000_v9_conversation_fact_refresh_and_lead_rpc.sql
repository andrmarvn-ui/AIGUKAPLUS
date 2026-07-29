-- Initial idempotent backfill. Runtime requests never query the dynamic attribution view.
insert into public.v8_report_v21_conversation_fact(
  source_channel,conversation_id,tenant_id,page_id,page_name,sender_id,customer_id,customer_name,
  conversation_started_at,conversation_date_vn,message_count,
  ad_id,ad_name_at_start,ad_name_current,ad_account_id,ad_account_name,
  campaign_id,campaign_name,adset_id,adset_name,ad_status_at_start,ad_status_current,
  attribution_source,attribution_confidence,attribution_reason,referral_at,
  phone,zalo,has_contact,is_hot_lead,lead_score,lead_level,product_group,product_label,lead_status,
  pancake_tags,pancake_employee,pancake_status,last_snippet,identity_source,
  source_created_at,source_updated_at,fact_version,refreshed_at
)
select
  coalesce(nullif(r.source_channel,''),'pancake'),r.conversation_id,r.tenant_id,r.page_id,r.page_name,
  r.sender_id,r.customer_id,r.customer_name,r.conversation_started_at,r.conversation_date_vn,
  coalesce(r.message_count,0),r.ad_id,r.ad_name,r.ad_name,r.ad_account_id,r.ad_account_name,
  r.campaign_id,r.campaign_name,r.adset_id,r.adset_name,r.ad_status,r.ad_status,
  case when r.ad_id is not null then 'legacy_attribution_materialized' else 'organic_or_unknown' end,
  case when r.ad_id is not null then 100 else 0 end::smallint,
  case when r.ad_id is not null then 'materialized_from_v8_report_conversation_attribution' else 'no_ad_evidence' end,
  null::timestamptz,
  r.phone,r.zalo,coalesce(r.has_contact,false),coalesce(r.is_hot_lead,false),r.lead_score,r.lead_level,
  r.product_group,r.product_label,r.lead_status,coalesce(r.pancake_tags,'[]'::jsonb),
  r.pancake_employee,r.pancake_status,r.last_snippet,r.identity_source,r.created_at,r.updated_at,21,now()
from public.v8_report_conversation_attribution r
where r.conversation_id is not null and btrim(r.conversation_id)<>''
on conflict(source_channel,conversation_id) do update set
  tenant_id=excluded.tenant_id,page_id=excluded.page_id,page_name=excluded.page_name,
  sender_id=excluded.sender_id,customer_id=excluded.customer_id,customer_name=excluded.customer_name,
  conversation_started_at=excluded.conversation_started_at,conversation_date_vn=excluded.conversation_date_vn,
  message_count=excluded.message_count,ad_id=excluded.ad_id,
  ad_name_at_start=excluded.ad_name_at_start,ad_name_current=excluded.ad_name_current,
  ad_account_id=excluded.ad_account_id,ad_account_name=excluded.ad_account_name,
  campaign_id=excluded.campaign_id,campaign_name=excluded.campaign_name,
  adset_id=excluded.adset_id,adset_name=excluded.adset_name,
  ad_status_at_start=excluded.ad_status_at_start,ad_status_current=excluded.ad_status_current,
  attribution_source=excluded.attribution_source,attribution_confidence=excluded.attribution_confidence,
  attribution_reason=excluded.attribution_reason,phone=excluded.phone,zalo=excluded.zalo,
  has_contact=excluded.has_contact,is_hot_lead=excluded.is_hot_lead,lead_score=excluded.lead_score,
  lead_level=excluded.lead_level,product_group=excluded.product_group,product_label=excluded.product_label,
  lead_status=excluded.lead_status,pancake_tags=excluded.pancake_tags,
  pancake_employee=excluded.pancake_employee,pancake_status=excluded.pancake_status,
  last_snippet=excluded.last_snippet,identity_source=excluded.identity_source,
  source_created_at=excluded.source_created_at,source_updated_at=excluded.source_updated_at,
  fact_version=21,refreshed_at=now();

create or replace function public.v9_refresh_conversation_fact(
  p_since timestamptz default (now()-interval '3 days')
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_since timestamptz:=coalesce(p_since,now()-interval '3 days');
  v_rows integer:=0;
  v_started timestamptz:=clock_timestamp();
begin
  perform set_config('statement_timeout','15000',true);
  perform set_config('lock_timeout','1000',true);

  insert into public.v8_report_v21_conversation_fact(
    source_channel,conversation_id,tenant_id,page_id,page_name,sender_id,customer_id,customer_name,
    conversation_started_at,conversation_date_vn,message_count,
    ad_id,ad_name_at_start,ad_name_current,ad_account_id,ad_account_name,
    campaign_id,campaign_name,adset_id,adset_name,ad_status_at_start,ad_status_current,
    attribution_source,attribution_confidence,attribution_reason,referral_at,
    phone,zalo,has_contact,is_hot_lead,lead_score,lead_level,product_group,product_label,lead_status,
    pancake_tags,pancake_employee,pancake_status,last_snippet,identity_source,
    source_created_at,source_updated_at,fact_version,refreshed_at
  )
  select
    coalesce(nullif(r.source_channel,''),'pancake'),r.conversation_id,r.tenant_id,r.page_id,r.page_name,
    r.sender_id,r.customer_id,r.customer_name,r.conversation_started_at,r.conversation_date_vn,
    coalesce(r.message_count,0),r.ad_id,r.ad_name,r.ad_name,r.ad_account_id,r.ad_account_name,
    r.campaign_id,r.campaign_name,r.adset_id,r.adset_name,r.ad_status,r.ad_status,
    case when r.ad_id is not null then 'legacy_attribution_materialized' else 'organic_or_unknown' end,
    case when r.ad_id is not null then 100 else 0 end::smallint,
    case when r.ad_id is not null then 'materialized_from_v8_report_conversation_attribution' else 'no_ad_evidence' end,
    null::timestamptz,
    r.phone,r.zalo,coalesce(r.has_contact,false),coalesce(r.is_hot_lead,false),r.lead_score,r.lead_level,
    r.product_group,r.product_label,r.lead_status,coalesce(r.pancake_tags,'[]'::jsonb),
    r.pancake_employee,r.pancake_status,r.last_snippet,r.identity_source,r.created_at,r.updated_at,21,now()
  from public.v8_report_conversation_attribution r
  where r.conversation_id is not null and btrim(r.conversation_id)<>''
    and greatest(
      coalesce(r.updated_at,'epoch'::timestamptz),
      coalesce(r.created_at,'epoch'::timestamptz),
      coalesce(r.conversation_started_at,'epoch'::timestamptz)
    ) >= v_since
  on conflict(source_channel,conversation_id) do update set
    tenant_id=excluded.tenant_id,page_id=excluded.page_id,page_name=excluded.page_name,
    sender_id=excluded.sender_id,customer_id=excluded.customer_id,customer_name=excluded.customer_name,
    conversation_started_at=excluded.conversation_started_at,conversation_date_vn=excluded.conversation_date_vn,
    message_count=excluded.message_count,ad_id=excluded.ad_id,
    ad_name_at_start=excluded.ad_name_at_start,ad_name_current=excluded.ad_name_current,
    ad_account_id=excluded.ad_account_id,ad_account_name=excluded.ad_account_name,
    campaign_id=excluded.campaign_id,campaign_name=excluded.campaign_name,
    adset_id=excluded.adset_id,adset_name=excluded.adset_name,
    ad_status_at_start=excluded.ad_status_at_start,ad_status_current=excluded.ad_status_current,
    attribution_source=excluded.attribution_source,attribution_confidence=excluded.attribution_confidence,
    attribution_reason=excluded.attribution_reason,phone=excluded.phone,zalo=excluded.zalo,
    has_contact=excluded.has_contact,is_hot_lead=excluded.is_hot_lead,lead_score=excluded.lead_score,
    lead_level=excluded.lead_level,product_group=excluded.product_group,product_label=excluded.product_label,
    lead_status=excluded.lead_status,pancake_tags=excluded.pancake_tags,
    pancake_employee=excluded.pancake_employee,pancake_status=excluded.pancake_status,
    last_snippet=excluded.last_snippet,identity_source=excluded.identity_source,
    source_created_at=excluded.source_created_at,source_updated_at=excluded.source_updated_at,
    fact_version=21,refreshed_at=now();
  get diagnostics v_rows=row_count;

  return jsonb_build_object(
    'ok',true,'since',v_since,'rows_upserted',v_rows,
    'duration_ms',round(extract(epoch from(clock_timestamp()-v_started))*1000,2),
    'source','v8_report_conversation_attribution',
    'target','v8_report_v21_conversation_fact'
  );
end;
$function$;
revoke all on function public.v9_refresh_conversation_fact(timestamptz) from public,anon,authenticated;
grant execute on function public.v9_refresh_conversation_fact(timestamptz) to service_role;

create or replace function public.v8_report_leads_test(
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

  with filtered as (
    select
      r.tenant_id,
      r.conversation_date_vn as report_date,
      r.conversation_started_at,
      r.page_id,r.page_name,r.conversation_id,r.sender_id,r.customer_id,r.customer_name,
      r.phone,r.zalo,r.has_contact,r.is_hot_lead,r.lead_score,r.lead_level,r.lead_status,
      r.product_group,r.product_label,r.ad_account_id,r.ad_account_name,
      r.campaign_id,r.campaign_name,r.adset_id,r.adset_name,r.ad_id,
      coalesce(r.ad_name_current,r.ad_name_at_start) as ad_name,
      coalesce(r.ad_status_current,r.ad_status_at_start) as ad_status,
      r.pancake_tags,r.pancake_employee,r.pancake_status,r.message_count,r.last_snippet,
      r.source_channel,r.identity_source
    from public.v8_report_v21_conversation_fact r
    where r.conversation_date_vn between v_from and v_to
      and (nullif(btrim(p_page_id),'') is null or r.page_id=p_page_id)
      and (nullif(btrim(p_ad_account_id),'') is null or r.ad_account_id=replace(p_ad_account_id,'act_',''))
      and (nullif(btrim(p_campaign_id),'') is null or r.campaign_id=p_campaign_id)
      and (nullif(btrim(p_adset_id),'') is null or r.adset_id=p_adset_id)
      and (nullif(btrim(p_ad_id),'') is null or r.ad_id=p_ad_id)
      and (
        nullif(btrim(p_search),'') is null
        or to_tsvector('simple',concat_ws(' ',r.customer_name,r.phone,r.zalo,r.sender_id,r.conversation_id,
            coalesce(r.ad_name_current,r.ad_name_at_start),r.last_snippet))
           @@ plainto_tsquery('simple',btrim(p_search))
        or concat_ws(' ',r.customer_name,r.phone,r.zalo,r.sender_id,r.conversation_id,
            coalesce(r.ad_name_current,r.ad_name_at_start),r.last_snippet)
           ilike '%'||btrim(p_search)||'%'
      )
  ), paged as (
    select * from filtered
    order by conversation_started_at desc nulls last
    limit least(greatest(coalesce(p_limit,100),1),10000)
    offset greatest(coalesce(p_offset,0),0)
  )
  select jsonb_build_object(
    'ok',true,
    'data',coalesce((select jsonb_agg(to_jsonb(p) order by p.conversation_started_at desc nulls last) from paged p),'[]'::jsonb),
    'count',(select count(*) from filtered),
    'range',jsonb_build_object('from',v_from,'to',v_to),
    'source','v9_conversation_fact'
  ) into v_result;
  return v_result;
end;
$function$;

revoke all on function public.v8_report_leads_test(date,date,text,text,text,text,text,text,integer,integer) from public;
grant execute on function public.v8_report_leads_test(date,date,text,text,text,text,text,text,integer,integer) to anon,authenticated,service_role;
