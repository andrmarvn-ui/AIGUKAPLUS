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
  v_request_role text:=coalesce(
    nullif(current_setting('request.jwt.claim.role',true),''),
    nullif((nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role'),''),
    current_user
  );
begin
  if current_user<>'postgres' and v_request_role<>'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode='42501';
  end if;

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

revoke all on function public.v9_refresh_conversation_fact(timestamptz) from public;
grant execute on function public.v9_refresh_conversation_fact(timestamptz) to anon,authenticated,service_role;

do $migration$
declare
  v_definition text;
begin
  select pg_get_functiondef(p.oid)
  into v_definition
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='v8_report_v21_refresh_day'
    and pg_get_function_identity_arguments(p.oid)='p_report_date date, p_page_id text';
  if v_definition is null then raise exception 'v8_report_v21_refresh_day_not_found'; end if;
  v_definition:=replace(v_definition,'''conversation_fact_ready'',false','''conversation_fact_ready'',true');
  execute v_definition;
end;
$migration$;

update public.v8_report_v21_state
set state_value=jsonb_build_object(
  'ready',true,'owner','v9_refresh_conversation_fact',
  'request_source','v8_report_v21_conversation_fact',
  'daily_refresh_delete_disabled',true,'updated_at',now()
),updated_at=now()
where state_key='conversation_fact_readiness';

select pg_notify('pgrst','reload schema');
select pg_notify('pgrst','reload config');
