create or replace function public.v8_report_v21_refresh_day(
  p_report_date date,
  p_page_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','extensions'
as $function$
declare
  v_started timestamptz:=clock_timestamp();
  v_page text:=nullif(p_page_id,'*');
  v_locked boolean:=false;
  v_from timestamptz;
  v_to timestamptz;
  v_customers integer:=0;
  v_ads integer:=0;
  v_referrals integer:=0;
begin
  if p_report_date is null then
    raise exception 'REPORT_DATE_REQUIRED';
  end if;

  v_from:=p_report_date::timestamp at time zone 'Asia/Ho_Chi_Minh';
  v_to:=(p_report_date+1)::timestamp at time zone 'Asia/Ho_Chi_Minh';

  select pg_try_advisory_xact_lock(
    hashtextextended('v8_report_v21_refresh:'||p_report_date::text||':'||coalesce(v_page,'*'),0)
  ) into v_locked;
  if not coalesce(v_locked,false) then
    return jsonb_build_object(
      'ok',true,'skipped',true,'reason','refresh_already_running',
      'report_date',p_report_date,'page_id',v_page
    );
  end if;

  perform set_config('statement_timeout','15000',true);
  perform set_config('lock_timeout','1000',true);

  insert into public.v8_report_v21_referral_fact(
    event_id,page_id,sender_id,customer_id,conversation_id,message_id,
    referral_at,ad_id,ad_title,post_id,referral_source,
    first_seen_at,last_seen_at,source_payload
  )
  select
    r.event_id,r.page_id,r.sender_id,r.customer_id,r.conversation_id,r.message_id,
    r.referral_at,r.ad_id,r.ad_title,r.post_id,r.referral_source,
    now(),now(),
    jsonb_build_object(
      'customer_name',r.customer_name,
      'phone',r.phone,
      'zalo',r.zalo,
      'lead_score',r.lead_score,
      'lead_state',r.lead_state,
      'product_key',r.product_key
    )
  from public.v8_meta_ad_referral_entries r
  where r.referral_at>=v_from-interval '90 days'
    and r.referral_at<v_to+interval '10 minutes'
    and r.is_ad_referral
    and nullif(btrim(r.ad_id),'') is not null
    and (v_page is null or r.page_id=v_page)
  on conflict(event_id) do update set
    page_id=excluded.page_id,
    sender_id=excluded.sender_id,
    customer_id=excluded.customer_id,
    conversation_id=excluded.conversation_id,
    message_id=excluded.message_id,
    referral_at=excluded.referral_at,
    ad_id=excluded.ad_id,
    ad_title=excluded.ad_title,
    post_id=excluded.post_id,
    referral_source=excluded.referral_source,
    last_seen_at=now(),
    source_payload=excluded.source_payload;
  get diagnostics v_referrals=row_count;

  delete from public.v8_report_v21_customer_day_fact f
  where f.report_date=p_report_date
    and (v_page is null or f.page_id=v_page);

  with inbound as materialized (
    select
      m.customer_id,
      m.page_id,
      m.sender_id,
      nullif(btrim(m.conversation_id),'') conversation_id,
      coalesce(m.sent_at,m.created_at) event_at,
      m.message_text,
      m.source_system
    from public.v8_messages_raw m
    where m.direction='inbound'
      and coalesce(m.actor_type,'customer')='customer'
      and m.page_id is not null
      and m.sender_id is not null
      and coalesce(m.sent_at,m.created_at)>=v_from
      and coalesce(m.sent_at,m.created_at)<v_to
      and (v_page is null or m.page_id=v_page)
  ), customer_day as (
    select
      p_report_date report_date,
      i.page_id,
      i.sender_id,
      (array_agg(i.customer_id order by i.event_at)
        filter(where i.customer_id is not null))[1] customer_id,
      min(i.event_at) first_event_at,
      max(i.event_at) last_event_at,
      count(*)::integer message_count,
      count(distinct i.conversation_id)
        filter(where i.conversation_id is not null)::integer source_conversation_count,
      (array_agg(i.message_text order by i.event_at desc)
        filter(where nullif(btrim(i.message_text),'') is not null))[1] last_snippet
    from inbound i
    group by i.page_id,i.sender_id
  )
  insert into public.v8_report_v21_customer_day_fact(
    report_date,page_id,sender_id,page_name,customer_id,customer_name,
    first_conversation_at,last_conversation_at,conversation_count,message_count,
    has_contact,is_hot_lead,phone,zalo,primary_ad_id,ad_ids,ad_count,
    product_groups,pancake_tags,pancake_employee,pancake_status,last_snippet,
    ad_id,ad_name,ad_account_id,ad_account_name,campaign_id,campaign_name,
    adset_id,adset_name,effective_status,currency,account_timezone,
    payment_method_last4,attribution_source,attribution_confidence,referral_at,
    fact_version,refreshed_at
  )
  select
    cd.report_date,
    cd.page_id,
    cd.sender_id,
    p.page_name,
    cd.customer_id::text,
    coalesce(c.display_name,ident.customer_name,lead.customer_name),
    cd.first_event_at,
    cd.last_event_at,
    1,
    cd.message_count,
    coalesce(ld.has_contact,false),
    coalesce(c.lead_state='hot_lead',false),
    coalesce(ld.phone,lead.phone_normalized,lead.phone,c.phone),
    coalesce(ld.zalo,lead.zalo,c.zalo),
    ref.ad_id,
    case when ref.ad_id is null then '[]'::jsonb else jsonb_build_array(ref.ad_id) end,
    case when ref.ad_id is null then 0 else 1 end,
    case
      when coalesce(map.product_group,ctx.product_key,lead.product_group,c.last_product_key) is null
        then '[]'::jsonb
      else jsonb_build_array(coalesce(map.product_group,ctx.product_key,lead.product_group,c.last_product_key))
    end,
    coalesce(lead.pancake_tags,ident.pancake_tags,'[]'::jsonb),
    coalesce(lead.pancake_employee,ident.pancake_employee,c.assigned_sale),
    coalesce(lead.pancake_status,ident.pancake_status),
    coalesce(cd.last_snippet,ident.last_snippet),
    ref.ad_id,
    coalesce(map.ad_name,ctx.ad_name,lead.ad_name,ident.ad_name,ref.ad_title),
    coalesce(map.ad_account_id,lead.ad_account_id,ident.ad_account_id),
    coalesce(map.ad_account_name,lead.ad_account_name,ident.ad_account_name),
    coalesce(map.campaign_id,ctx.campaign_id,lead.campaign_id,ident.campaign_id),
    coalesce(map.campaign_name,ctx.campaign_name,lead.campaign_name,ident.campaign_name),
    coalesce(map.adset_id,ctx.adset_id,lead.adset_id,ident.adset_id),
    coalesce(map.adset_name,ctx.adset_name,lead.adset_name,ident.adset_name),
    coalesce(map.effective_status,lead.ad_status,ident.status,'UNKNOWN'),
    coalesce(aa.currency,'VND'),
    coalesce(aa.reporting_timezone,aa.timezone_name,'Asia/Ho_Chi_Minh'),
    aa.payment_method_last4,
    case
      when ref.ad_id is null then 'unattributed'
      when lower(coalesce(ref.referral_source,'')) like '%meta%' then 'meta_referral'
      when lower(coalesce(ref.referral_source,'')) like '%pancake%' then 'pancake_referral'
      else 'normalized_referral'
    end,
    case
      when ref.ad_id is null then 0
      when lower(coalesce(ref.referral_source,'')) like '%meta%' then 100
      when lower(coalesce(ref.referral_source,'')) like '%pancake%' then 90
      else 85
    end::smallint,
    ref.referral_at,
    21,
    now()
  from customer_day cd
  join public.v8_pages p on p.page_id=cd.page_id
  left join public.v8_customers c on c.id=cd.customer_id
  left join lateral (
    select q.*
    from (
      select r.ad_id,r.referral_at,r.referral_source,r.ad_title,r.event_id
      from public.v8_report_v21_referral_fact r
      where r.page_id=cd.page_id
        and r.sender_id=cd.sender_id
        and r.referral_at<=cd.first_event_at+interval '10 minutes'
        and r.referral_at>=cd.first_event_at-interval '90 days'
      union all
      select r.ad_id,r.referral_at,r.referral_source,r.ad_title,r.event_id
      from public.v8_report_v21_referral_fact r
      where cd.customer_id is not null
        and r.page_id=cd.page_id
        and r.customer_id=cd.customer_id
        and r.referral_at<=cd.first_event_at+interval '10 minutes'
        and r.referral_at>=cd.first_event_at-interval '90 days'
    ) q
    order by q.referral_at desc,q.event_id desc
    limit 1
  ) ref on true
  left join lateral (
    select m.*
    from public.ad_mappings m
    where m.ad_id=ref.ad_id
    order by coalesce(m.is_active,m.enabled,true) desc,
             m.updated_at desc nulls last,m.id desc
    limit 1
  ) map on true
  left join lateral (
    select x.*
    from public.v8_ad_context x
    where x.page_id=cd.page_id and x.ad_id=ref.ad_id
    order by x.is_active desc,x.updated_at desc
    limit 1
  ) ctx on true
  left join lateral (
    select
      bool_or(
        le.phone is not null or le.zalo is not null
        or le.event_type in ('phone_detected','zalo_detected','provide_contact')
      ) has_contact,
      (array_agg(le.phone order by le.created_at desc)
        filter(where nullif(btrim(le.phone),'') is not null))[1] phone,
      (array_agg(le.zalo order by le.created_at desc)
        filter(where nullif(btrim(le.zalo),'') is not null))[1] zalo
    from public.v8_lead_events le
    where le.page_id=cd.page_id
      and (le.sender_id=cd.sender_id or (cd.customer_id is not null and le.customer_id=cd.customer_id))
      and le.created_at>=v_from and le.created_at<v_to
  ) ld on true
  left join lateral (
    select l.*
    from public.lt_leads l
    where l.sender_id=cd.sender_id
    order by l.updated_at desc nulls last,l.created_at desc
    limit 1
  ) lead on true
  left join lateral (
    select
      i.customer_name,i.ad_id,i.ad_name,i.ad_account_id,i.ad_account_name,
      i.campaign_id,i.campaign_name,i.adset_id,i.adset_name,i.status,
      i.pancake_tags,i.pancake_employee,i.pancake_status,
      coalesce(i.raw #>> '{pancake,snippet}',i.raw #>> '{normalized,snippet}') last_snippet
    from public.lt_conversation_identities i
    where i.page_id=cd.page_id and i.sender_id=cd.sender_id
    order by i.updated_at desc nulls last,i.created_at desc
    limit 1
  ) ident on true
  left join public.v8_meta_ad_accounts aa
    on aa.ad_account_id=coalesce(map.ad_account_id,lead.ad_account_id,ident.ad_account_id);
  get diagnostics v_customers=row_count;

  delete from public.v8_report_v21_conversation_fact f
  where f.conversation_date_vn=p_report_date
    and (v_page is null or f.page_id=v_page);

  delete from public.v8_report_v21_ad_day_fact f
  where f.report_date=p_report_date
    and (v_page is null or f.page_id=v_page);

  with runtime_base as (
    select
      f.*,
      coalesce(f.ad_account_id,pa.ad_account_id,'') resolved_ad_account_id,
      coalesce(f.ad_account_name,faa.ad_account_name,
        case when coalesce(f.ad_account_id,pa.ad_account_id) is null
          then 'Chưa xác định tài khoản QC' end) resolved_ad_account_name,
      coalesce(f.currency,faa.currency,'VND') resolved_currency,
      coalesce(f.account_timezone,faa.reporting_timezone,faa.timezone_name,'Asia/Ho_Chi_Minh') resolved_timezone,
      coalesce(f.payment_method_last4,faa.payment_method_last4) resolved_payment_method,
      case
        when f.ad_account_id is null and pa.ad_account_id is not null then 'runtime_page_fallback'
        when f.ad_id is null then 'runtime_unattributed'
        else 'runtime_crm_only'
      end runtime_status
    from public.v8_report_v21_customer_day_fact f
    left join lateral (
      select l.ad_account_id
      from public.v8_meta_page_ad_accounts l
      where l.page_id=f.page_id
      order by l.is_primary desc,l.updated_at desc
      limit 1
    ) pa on true
    left join public.v8_meta_ad_accounts faa
      on faa.ad_account_id=coalesce(f.ad_account_id,pa.ad_account_id)
    where f.report_date=p_report_date
      and (v_page is null or f.page_id=v_page)
  ), runtime as (
    select
      report_date,
      page_id,
      max(page_name) page_name,
      resolved_ad_account_id ad_account_id,
      max(resolved_ad_account_name) ad_account_name,
      coalesce(campaign_id,'') campaign_id,
      max(campaign_name) campaign_name,
      coalesce(adset_id,'') adset_id,
      max(adset_name) adset_name,
      coalesce(ad_id,'') ad_id,
      max(ad_name) ad_name,
      max(effective_status) effective_status,
      max(resolved_currency) currency,
      max(resolved_timezone) account_timezone,
      max(resolved_payment_method) payment_method_last4,
      count(*)::bigint conversations,
      count(distinct sender_id)::bigint customers,
      count(*) filter(where has_contact)::bigint contacts,
      count(*) filter(where is_hot_lead)::bigint hot_leads,
      coalesce(sum(message_count),0)::bigint message_count,
      max(runtime_status) runtime_status,
      max(refreshed_at) latest_source_at
    from runtime_base
    group by report_date,page_id,resolved_ad_account_id,
      coalesce(campaign_id,''),coalesce(adset_id,''),coalesce(ad_id,'')
  ), ad_page as (
    select distinct on (r.ad_id) r.ad_id,r.page_id
    from public.v8_report_v21_referral_fact r
    where r.ad_id is not null
    order by r.ad_id,r.referral_at desc
  ), ads as (
    select
      a.insight_date report_date,
      coalesce(a.page_id,ap.page_id,'') page_id,
      max(p.page_name) page_name,
      coalesce(a.ad_account_id,'') ad_account_id,
      max(ac.ad_account_name) ad_account_name,
      coalesce(a.campaign_id,'') campaign_id,
      max(a.campaign_name) campaign_name,
      coalesce(a.adset_id,'') adset_id,
      max(a.adset_name) adset_name,
      coalesce(a.ad_id,'') ad_id,
      max(a.ad_name) ad_name,
      max(a.effective_status) effective_status,
      max(coalesce(a.currency,ac.currency,'VND')) currency,
      max(coalesce(a.account_timezone,ac.reporting_timezone,ac.timezone_name,'Asia/Ho_Chi_Minh')) account_timezone,
      max(ac.payment_method_last4) payment_method_last4,
      coalesce(sum(a.spend),0) spend,
      coalesce(sum(a.tax_amount),0) tax_amount,
      coalesce(sum(case when a.spend_with_tax>0 then a.spend_with_tax else a.spend end),0) spend_with_tax,
      coalesce(sum(a.impressions),0)::bigint impressions,
      coalesce(sum(a.reach),0)::bigint reach,
      coalesce(sum(a.clicks),0)::bigint clicks,
      coalesce(sum(a.link_clicks),0)::bigint link_clicks,
      coalesce(sum(a.messaging_conversations_started),0)::bigint meta_conversations,
      coalesce(sum(a.meta_leads),0)::bigint meta_leads,
      max(greatest(a.synced_at,a.updated_at,a.created_at)) latest_source_at
    from public.v8_ads_daily_insights a
    left join ad_page ap on ap.ad_id=a.ad_id
    left join public.v8_pages p on p.page_id=coalesce(a.page_id,ap.page_id)
    left join public.v8_meta_ad_accounts ac on ac.ad_account_id=a.ad_account_id
    where a.insight_date=p_report_date
      and (v_page is null or coalesce(a.page_id,ap.page_id)=v_page)
    group by a.insight_date,coalesce(a.page_id,ap.page_id,''),
      coalesce(a.ad_account_id,''),coalesce(a.campaign_id,''),
      coalesce(a.adset_id,''),coalesce(a.ad_id,'')
  ), combined as (
    select
      coalesce(a.report_date,r.report_date) report_date,
      coalesce(a.page_id,r.page_id,'') page_id,
      coalesce(a.page_name,r.page_name) page_name,
      coalesce(a.ad_account_id,r.ad_account_id,'') ad_account_id,
      coalesce(a.ad_account_name,r.ad_account_name) ad_account_name,
      coalesce(a.campaign_id,r.campaign_id,'') campaign_id,
      coalesce(a.campaign_name,r.campaign_name) campaign_name,
      coalesce(a.adset_id,r.adset_id,'') adset_id,
      coalesce(a.adset_name,r.adset_name) adset_name,
      coalesce(a.ad_id,r.ad_id,'') ad_id,
      coalesce(a.ad_name,r.ad_name) ad_name,
      coalesce(a.effective_status,r.effective_status,'UNKNOWN') effective_status,
      coalesce(a.currency,r.currency,'VND') currency,
      coalesce(a.account_timezone,r.account_timezone,'Asia/Ho_Chi_Minh') account_timezone,
      coalesce(a.payment_method_last4,r.payment_method_last4) payment_method_last4,
      coalesce(a.spend,0) spend,
      coalesce(a.tax_amount,0) tax_amount,
      coalesce(a.spend_with_tax,0) spend_with_tax,
      coalesce(a.impressions,0) impressions,
      coalesce(a.reach,0) reach,
      coalesce(a.clicks,0) clicks,
      coalesce(a.link_clicks,0) link_clicks,
      coalesce(a.meta_conversations,0) meta_conversations,
      coalesce(a.meta_leads,0) meta_leads,
      coalesce(r.conversations,0) conversations,
      coalesce(r.customers,0) customers,
      coalesce(r.contacts,0) contacts,
      coalesce(r.hot_leads,0) hot_leads,
      coalesce(r.message_count,0) message_count,
      case
        when a.report_date is not null and r.report_date is not null then 'matched'
        when a.report_date is not null then 'ads_only'
        else r.runtime_status
      end data_match_status,
      greatest(a.latest_source_at,r.latest_source_at) latest_source_at
    from ads a
    full outer join runtime r
      on r.report_date=a.report_date
     and r.page_id=a.page_id
     and r.ad_account_id=a.ad_account_id
     and r.ad_id=a.ad_id
  )
  insert into public.v8_report_v21_ad_day_fact(
    report_date,page_id,page_name,ad_account_id,ad_account_name,
    campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,
    effective_status,currency,account_timezone,payment_method_last4,
    spend,tax_amount,spend_with_tax,impressions,reach,clicks,link_clicks,
    meta_conversations,meta_leads,conversations,customers,contacts,
    hot_leads,message_count,data_match_status,latest_source_at,
    fact_version,refreshed_at
  )
  select
    report_date,page_id,page_name,ad_account_id,ad_account_name,
    campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,
    effective_status,currency,account_timezone,payment_method_last4,
    spend,tax_amount,spend_with_tax,impressions,reach,clicks,link_clicks,
    meta_conversations,meta_leads,conversations,customers,contacts,
    hot_leads,message_count,data_match_status,latest_source_at,21,now()
  from combined;
  get diagnostics v_ads=row_count;

  insert into public.v8_report_v21_state(state_key,state_value,updated_at)
  values(
    'conversation_fact_readiness',
    jsonb_build_object(
      'ready',false,
      'reason','customer_day_and_ad_day_parity_precedes_conversation_grain_cutover',
      'updated_at',now()
    ),
    now()
  )
  on conflict(state_key) do update set
    state_value=excluded.state_value,updated_at=now();

  insert into public.v8_report_v21_metrics(
    operation,report_date,page_id,started_at,completed_at,duration_ms,
    rows_affected,status,details
  ) values(
    'refresh_day_raw_customer_grain',p_report_date,v_page,v_started,clock_timestamp(),
    extract(epoch from (clock_timestamp()-v_started))*1000,
    v_customers+v_ads,'completed',
    jsonb_build_object(
      'customer_days',v_customers,
      'ad_days',v_ads,
      'referrals_upserted',v_referrals,
      'conversation_fact_ready',false
    )
  );

  return jsonb_build_object(
    'ok',true,'skipped',false,'report_date',p_report_date,'page_id',v_page,
    'customer_days',v_customers,'ad_days',v_ads,
    'referrals_upserted',v_referrals,
    'conversation_fact_ready',false,
    'duration_ms',round(extract(epoch from (clock_timestamp()-v_started))*1000,2)
  );
exception when others then
  insert into public.v8_report_v21_metrics(
    operation,report_date,page_id,started_at,completed_at,duration_ms,
    rows_affected,status,details
  ) values(
    'refresh_day_raw_customer_grain',p_report_date,v_page,v_started,clock_timestamp(),
    extract(epoch from (clock_timestamp()-v_started))*1000,0,'error',
    jsonb_build_object('sqlstate',sqlstate,'error',left(sqlerrm,500))
  );
  raise;
end;
$function$;

revoke all on function public.v8_report_v21_refresh_day(date,text) from public;
grant execute on function public.v8_report_v21_refresh_day(date,text) to service_role;
