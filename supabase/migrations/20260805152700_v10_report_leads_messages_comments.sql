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
set search_path='public'
as $function$
declare
  v_result jsonb;
  v_from date := coalesce(p_from,current_date);
  v_to date := coalesce(p_to,current_date);
begin
  perform public.v8_assert_admin_request();
  if v_from > v_to then raise exception 'date_from_after_date_to'; end if;
  if v_to - v_from > 731 then raise exception 'date_range_too_large'; end if;
  perform set_config('statement_timeout','7000',true);

  with message_base as (
    select
      m.page_id,
      m.customer_id,
      m.occurred_at,
      m.event_type,
      nullif(btrim(m.ad_id),'') as ad_id,
      nullif(btrim(m.attributes->>'source_system'),'') as source_system
    from public.fact_messages m
    where m.actor_type='customer'
      and m.event_type in ('customer_message','customer_postback','customer_comment')
      and (m.occurred_at at time zone 'Asia/Ho_Chi_Minh')::date between v_from and v_to
      and nullif(btrim(m.page_id),'') is not null
      and nullif(btrim(m.customer_id),'') is not null
      and m.customer_id <> m.page_id
  ), normalized_group as (
    select
      mb.page_id,
      mb.customer_id,
      min(mb.occurred_at) as conversation_started_at,
      max(mb.occurred_at) as last_customer_at,
      count(*)::integer as message_count,
      count(*) filter(where mb.event_type='customer_comment')::integer as comment_count,
      bool_or(mb.event_type in ('customer_message','customer_postback')) as has_direct_message,
      (array_agg(mb.ad_id order by mb.occurred_at) filter (where mb.ad_id is not null))[1] as ad_id,
      (array_agg(mb.source_system order by mb.occurred_at) filter (where mb.source_system is not null))[1] as source_system
    from message_base mb
    group by mb.page_id,mb.customer_id
  ), contact_rollup as (
    select
      c.page_id,c.customer_id,
      min(c.captured_at) filter (where lower(c.contact_type)='phone') as phone_at,
      min(c.captured_at) filter (where lower(c.contact_type)='zalo') as zalo_at,
      min(c.captured_at) as any_contact_at
    from public.fact_contacts c
    group by c.page_id,c.customer_id
  ), legacy_lookup as (
    select distinct on (l.page_id,coalesce(nullif(l.customer_id,''),nullif(l.sender_id,'')))
      l.page_id,
      coalesce(nullif(l.customer_id,''),nullif(l.sender_id,'')) as customer_key,
      l.customer_name,l.phone,l.zalo,l.pancake_tags,l.pancake_employee,l.pancake_status,
      l.last_snippet,l.lead_score,l.lead_level,l.lead_status,l.is_hot_lead,
      l.product_group,l.product_label
    from public.v8_report_lead_detail l
    where coalesce(nullif(l.customer_id,''),nullif(l.sender_id,'')) is not null
    order by l.page_id,coalesce(nullif(l.customer_id,''),nullif(l.sender_id,'')),l.conversation_started_at desc nulls last
  ), normalized as (
    select
      null::uuid as tenant_id,
      (ng.conversation_started_at at time zone 'Asia/Ho_Chi_Minh')::date as report_date,
      ng.conversation_started_at,
      ng.last_customer_at,
      ng.page_id,
      coalesce(dp.page_name,'Page '||ng.page_id) as page_name,
      'v10:'||ng.page_id||':'||ng.customer_id||':'||to_char(ng.conversation_started_at,'YYYYMMDDHH24MISS') as conversation_id,
      ng.customer_id as sender_id,
      ng.customer_id,
      coalesce(nullif(dc.display_name,''),nullif(ll.customer_name,''),'Khách '||right(ng.customer_id,6)) as customer_name,
      coalesce(nullif(ll.phone,''),case when cr.phone_at is not null and cr.phone_at <= ng.last_customer_at + interval '1 day' then 'Đã có SĐT' end) as phone,
      coalesce(nullif(ll.zalo,''),case when cr.zalo_at is not null and cr.zalo_at <= ng.last_customer_at + interval '1 day' then 'Đã có Zalo' end) as zalo,
      (coalesce(nullif(ll.phone,''),nullif(ll.zalo,'')) is not null
        or (cr.any_contact_at is not null and cr.any_contact_at <= ng.last_customer_at + interval '1 day')) as has_contact,
      coalesce(ll.is_hot_lead,false) or (cr.any_contact_at is not null and cr.any_contact_at <= ng.last_customer_at + interval '1 day') as is_hot_lead,
      coalesce(ll.lead_score,case when cr.any_contact_at is not null and cr.any_contact_at <= ng.last_customer_at + interval '1 day' then 100 else 0 end::numeric) as lead_score,
      coalesce(ll.lead_level,case when cr.any_contact_at is not null and cr.any_contact_at <= ng.last_customer_at + interval '1 day' then 3 else 1 end::smallint) as lead_level,
      coalesce(nullif(ll.lead_status,''),case when cr.any_contact_at is not null and cr.any_contact_at <= ng.last_customer_at + interval '1 day' then 'contact_captured' else 'new' end) as lead_status,
      coalesce(nullif(ll.product_group,''),da.catalog_keys[1]) as product_group,
      coalesce(nullif(ll.product_label,''),nullif(array_to_string(da.catalog_keys,', '),'')) as product_label,
      da.ad_account_id,da.ad_account_name,da.campaign_id,da.campaign_name,da.adset_id,da.adset_name,
      ng.ad_id,
      da.ad_name,
      da.effective_status as ad_status,
      coalesce(ll.pancake_tags,'[]'::jsonb) as pancake_tags,
      ll.pancake_employee,ll.pancake_status,
      ng.message_count,
      case
        when not ng.has_direct_message then ng.comment_count||' bình luận khách · nội dung được bảo mật'
        else coalesce(nullif(ll.last_snippet,''),ng.message_count||' tin khách · nội dung hội thoại được bảo mật')
      end as last_snippet,
      case when not ng.has_direct_message then 'meta_comment' else coalesce(ng.source_system,'v10_core') end as source_channel,
      case when not ng.has_direct_message then 'v10_normalized_comment' else 'v10_normalized_reporting' end::text as identity_source,
      case when not ng.has_direct_message then 'comment' else 'message' end::text as customer_source_type
    from normalized_group ng
    left join public.dim_customers dc on dc.page_id=ng.page_id and dc.customer_id=ng.customer_id
    left join public.dim_pages dp on dp.page_id=ng.page_id
    left join public.dim_ads da on da.ad_id=ng.ad_id
    left join contact_rollup cr on cr.page_id=ng.page_id and cr.customer_id=ng.customer_id
    left join legacy_lookup ll on ll.page_id=ng.page_id and ll.customer_key=ng.customer_id
  ), legacy_only as (
    select
      r.tenant_id,
      r.conversation_date_vn as report_date,
      r.conversation_started_at,
      r.conversation_started_at as last_customer_at,
      r.page_id,r.page_name,r.conversation_id,r.sender_id,r.customer_id,r.customer_name,
      r.phone,r.zalo,r.has_contact,r.is_hot_lead,r.lead_score,r.lead_level,r.lead_status,
      r.product_group,r.product_label,r.ad_account_id,r.ad_account_name,
      r.campaign_id,r.campaign_name,r.adset_id,r.adset_name,r.ad_id,
      coalesce(r.ad_name_current,r.ad_name_at_start) as ad_name,
      coalesce(r.ad_status_current,r.ad_status_at_start) as ad_status,
      coalesce(r.pancake_tags,'[]'::jsonb) as pancake_tags,
      r.pancake_employee,r.pancake_status,r.message_count,r.last_snippet,
      r.source_channel,r.identity_source,
      'message'::text as customer_source_type
    from public.v8_report_v21_conversation_fact r
    where r.conversation_date_vn between v_from and v_to
      and not exists (
        select 1 from normalized n
        where n.page_id=r.page_id
          and n.customer_id=coalesce(nullif(r.customer_id,''),nullif(r.sender_id,''))
      )
  ), unified as (
    select * from normalized
    union all
    select * from legacy_only
  ), filtered as (
    select * from unified u
    where (nullif(btrim(p_page_id),'') is null or u.page_id=p_page_id)
      and (nullif(btrim(p_ad_account_id),'') is null or u.ad_account_id=replace(p_ad_account_id,'act_',''))
      and (nullif(btrim(p_campaign_id),'') is null or u.campaign_id=p_campaign_id)
      and (nullif(btrim(p_adset_id),'') is null or u.adset_id=p_adset_id)
      and (nullif(btrim(p_ad_id),'') is null or u.ad_id=p_ad_id)
      and (
        nullif(btrim(p_search),'') is null
        or concat_ws(' ',u.customer_name,u.phone,u.zalo,u.sender_id,u.customer_id,u.conversation_id,
          u.ad_name,u.campaign_name,u.adset_name,u.product_group,u.product_label,u.last_snippet,
          u.pancake_employee,u.source_channel,u.customer_source_type)
          ilike '%'||btrim(p_search)||'%'
      )
  ), paged as (
    select * from filtered
    order by last_customer_at desc nulls last,conversation_started_at desc nulls last
    limit least(greatest(coalesce(p_limit,100),1),10000)
    offset greatest(coalesce(p_offset,0),0)
  )
  select jsonb_build_object(
    'ok',true,
    'data',coalesce((select jsonb_agg(to_jsonb(p) order by p.last_customer_at desc nulls last,p.conversation_started_at desc nulls last) from paged p),'[]'::jsonb),
    'count',(select count(*) from filtered),
    'customer_count',(select count(distinct (page_id,customer_id)) from filtered),
    'message_customer_count',(select count(distinct (page_id,customer_id)) from filtered where customer_source_type='message'),
    'comment_customer_count',(select count(distinct (page_id,customer_id)) from filtered where customer_source_type='comment'),
    'contact_count',(select count(distinct (page_id,customer_id)) from filtered where has_contact),
    'account_count',(select count(distinct ad_account_id) from filtered where ad_account_id is not null),
    'range',jsonb_build_object('from',v_from,'to',v_to),
    'source','v10_normalized_messages_and_comments'
  ) into v_result;
  return v_result;
end;
$function$;
