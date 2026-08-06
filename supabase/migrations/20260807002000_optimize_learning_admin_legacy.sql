-- Fast, non-blocking fallback for the reviewed-learning admin.
-- Production applied on 2026-08-07.

create index if not exists idx_lt_conversation_identities_page_sender_updated
  on public.lt_conversation_identities(page_id, sender_id, updated_at desc, created_at desc);

create index if not exists idx_v8_reply_plans_message_lookup
  on public.v8_reply_plans(page_id, sender_id, message_id, created_at desc);

create or replace function public.v8_admin_conversation_list(
  p_search text default null::text,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language sql
security definer
set search_path to 'public'
as $function$
with params as (
  select least(greatest(coalesce(p_limit,50),1),500)::integer as selected_limit,
         greatest(coalesce(p_offset,0),0)::integer as selected_offset,
         nullif(btrim(coalesce(p_search,'')),'') as search_text
), base as (
  select c.page_id,coalesce(p.page_name,c.page_name,c.page_id) as page_name,c.sender_id,c.id as customer_id,
         c.display_name,c.phone,c.zalo,c.profile_pic_url,c.gender,c.gender_source,c.preferred_salutation,
         c.profile_sync_status,bg.group_name as business_group_name,c.lead_state,c.last_seen_at
  from public.v8_customers c
  left join public.v8_pages p on p.page_id=c.page_id
  left join public.v8_conversation_states cs on cs.page_id=c.page_id and cs.sender_id=c.sender_id
  left join public.v8_business_product_groups bg on bg.group_key=cs.business_group_key
  cross join params q
  where c.page_id is not null and c.sender_id is not null
    and exists (select 1 from public.v8_messages_raw em where em.page_id=c.page_id and em.sender_id=c.sender_id)
    and (q.search_text is null
      or concat_ws(' ',c.display_name,c.phone,c.zalo,c.sender_id,coalesce(p.page_name,c.page_name,c.page_id),bg.group_name)
         ilike '%'||q.search_text||'%'
      or exists (select 1 from public.v8_messages_raw sm where sm.page_id=c.page_id and sm.sender_id=c.sender_id
        and to_tsvector('simple',coalesce(sm.message_text,'')) @@ websearch_to_tsquery('simple',q.search_text)))
), paged as (
  select b.* from base b order by b.last_seen_at desc nulls last,b.page_id,b.sender_id
  limit (select selected_limit from params) offset (select selected_offset from params)
), decorated as (
  select p.page_id,p.page_name,p.sender_id,lm.conversation_id,p.customer_id,p.display_name,p.phone,p.zalo,
         p.profile_pic_url,p.gender,p.gender_source,p.preferred_salutation,p.profile_sync_status,
         p.business_group_name,p.lead_state,lm.message_text as last_message_text,
         coalesce(lm.sent_at,p.last_seen_at) as last_message_at,
         coalesce(mc.message_count,0)::integer as message_count,
         coalesce(mc.inbound_count,0)::integer as inbound_count,
         coalesce(mc.outbound_count,0)::integer as outbound_count
  from paged p
  left join lateral (
    select m.conversation_id,m.message_text,coalesce(m.sent_at,m.created_at) as sent_at
    from public.v8_messages_raw m where m.page_id=p.page_id and m.sender_id=p.sender_id
    order by coalesce(m.sent_at,m.created_at) desc nulls last limit 1
  ) lm on true
  left join lateral (
    select count(*)::integer as message_count,
           count(*) filter(where m.direction='inbound')::integer as inbound_count,
           count(*) filter(where m.direction='outbound')::integer as outbound_count
    from public.v8_messages_raw m where m.page_id=p.page_id and m.sender_id=p.sender_id
  ) mc on true
)
select jsonb_build_object(
  'data',coalesce((select jsonb_agg(to_jsonb(d) order by d.last_message_at desc nulls last) from decorated d),'[]'::jsonb),
  'count',(select count(*) from base),'selected_limit',(select selected_limit from params),
  'limit_options',jsonb_build_array(20,40,60,80,100,150,200),'custom_limit_min',1,'custom_limit_max',500,
  'meta_sync_requested',jsonb_build_object('requested',0,'dispatched',0,'mode','separate_background_sync'),
  'meta_sync_mode','separate_background_sync'
);
$function$;

create or replace function public.v8_admin_conversation_detail(p_page_id text,p_sender_id text)
returns jsonb
language sql
security definer
set search_path to 'public'
as $function$
with selected_events as (
  select * from (
    select m.* from public.v8_messages_raw m where m.page_id=p_page_id and m.sender_id=p_sender_id
    order by coalesce(m.sent_at,m.created_at) desc nulls last limit 1000
  ) recent order by coalesce(recent.sent_at,recent.created_at),recent.created_at
), events as (
  select m.*,case when m.direction='inbound' then 'customer' else coalesce(m.actor_type,'outbound') end as role,
    (select to_jsonb(rp) from public.v8_reply_plans rp
     where rp.page_id=m.page_id and rp.sender_id=m.sender_id and rp.message_id=m.message_id
     order by rp.created_at desc limit 1) as reply_plan
  from selected_events m
), counts as (
  select count(*)::integer total,count(*) filter(where direction='inbound')::integer inbound,
    count(*) filter(where direction='outbound')::integer outbound,
    count(*) filter(where direction='outbound' and is_automatic=true)::integer automatic_outbound,
    count(*) filter(where direction='outbound' and is_automatic is distinct from true)::integer other_outbound
  from events
), lead as (
  select to_jsonb(c)||jsonb_build_object('business_group_key',cs.business_group_key,'business_group_name',bg.group_name,
    'conversation_stage',cs.stage,'sale_handoff_ready',cs.sale_handoff_ready,
    'last_customer_message_at',cs.last_customer_message_at) as item
  from public.v8_customers c
  left join public.v8_conversation_states cs on cs.page_id=c.page_id and cs.sender_id=c.sender_id
  left join public.v8_business_product_groups bg on bg.group_key=cs.business_group_key
  where c.page_id=p_page_id and c.sender_id=p_sender_id limit 1
)
select jsonb_build_object(
  'page_id',p_page_id,'sender_id',p_sender_id,
  'customer',coalesce((select to_jsonb(c) from public.v8_customers c where c.page_id=p_page_id and c.sender_id=p_sender_id limit 1),'null'::jsonb),
  'lead',coalesce((select item from lead),'null'::jsonb),
  'state',coalesce((select to_jsonb(s) from public.v8_conversation_states s where s.page_id=p_page_id and s.sender_id=p_sender_id limit 1),'null'::jsonb),
  'events',coalesce((select jsonb_agg(to_jsonb(e) order by coalesce(e.sent_at,e.created_at),e.created_at) from events e),'[]'::jsonb),
  'reply_plans',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from
    (select * from public.v8_reply_plans rp where rp.page_id=p_page_id and rp.sender_id=p_sender_id order by rp.created_at desc limit 300) x),'[]'::jsonb),
  'slide_logs',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from
    (select * from public.v8_slide_logs sl where sl.page_id=p_page_id and sl.sender_id=p_sender_id order by sl.created_at desc limit 300) x),'[]'::jsonb),
  'profile_sync_log',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from
    (select * from public.v8_profile_sync_log where page_id=p_page_id and sender_id=p_sender_id order by created_at desc limit 10) x),'[]'::jsonb),
  'counts',(select to_jsonb(counts) from counts),
  'history_warning',case when (select outbound from counts)=0 then 'Chưa có tin Page, Sale, Botcake, AIcake hoặc hệ thống tự động gửi ra trong dữ liệu V8.' else null end,
  'meta_sync_requested',jsonb_build_object('requested',0,'dispatched',0,'mode','separate_background_sync'),
  'meta_sync_mode','separate_background_sync'
);
$function$;
