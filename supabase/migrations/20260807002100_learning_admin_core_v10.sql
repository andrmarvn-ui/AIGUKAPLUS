-- Core V10 source for /learning-reviewed.
-- Production applied on 2026-08-07.

create index if not exists idx_v9_conversation_state_recent
  on public.v9_conversation_state ((greatest(coalesce(last_customer_event_at,'epoch'::timestamptz),coalesce(last_page_event_at,'epoch'::timestamptz),coalesce(updated_at,'epoch'::timestamptz))) desc, page_id, sender_id);
create index if not exists idx_v9_decisions_conversation_created
  on public.v9_decisions(page_id,sender_id,created_at desc);
create index if not exists idx_v9_delivery_bundles_conversation_updated
  on public.v9_delivery_bundles(page_id,sender_id,updated_at desc);

create or replace function public.v10_learning_conversation_list(
  p_search text default null,
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
  select s.page_id,p.page_name,s.sender_id,c.id as customer_uuid,c.display_name,s.phone,s.zalo,c.gender,
         c.preferred_salutation,c.profile,s.contact_status,s.state as lead_state,
         greatest(coalesce(s.last_customer_event_at,'epoch'::timestamptz),
                  coalesce(s.last_page_event_at,'epoch'::timestamptz),coalesce(s.updated_at,'epoch'::timestamptz)) as activity_at
  from public.v9_conversation_state s
  join public.v9_customers c on c.page_id=s.page_id and c.customer_id=s.sender_id
  left join public.v9_pages p on p.page_id=s.page_id
  cross join params q
  where s.page_id is not null and s.sender_id is not null and s.page_id<>s.sender_id
    and (q.search_text is null
      or concat_ws(' ',c.display_name,s.phone,s.zalo,s.sender_id,p.page_name,s.state,s.contact_status) ilike '%'||q.search_text||'%'
      or exists (select 1 from public.v9_events se where se.page_id=s.page_id
        and coalesce(se.customer_id,se.sender_id)=s.sender_id and coalesce(se.message_text,'') ilike '%'||q.search_text||'%')
      or exists (select 1 from public.v9_delivery_bundles sb where sb.page_id=s.page_id and sb.sender_id=s.sender_id
        and coalesce(sb.text_body,'') ilike '%'||q.search_text||'%'))
), paged as (
  select b.* from base b order by b.activity_at desc,b.page_id,b.sender_id
  limit (select selected_limit from params) offset (select selected_offset from params)
), decorated as (
  select p.page_id,coalesce(p.page_name,p.page_id) as page_name,p.sender_id,p.sender_id as conversation_id,
         p.customer_uuid as customer_id,p.display_name,p.phone,p.zalo,
         coalesce(p.profile->>'profile_pic_url',p.profile->>'picture_url',p.profile#>>'{picture,data,url}',p.profile->>'avatar_url') as profile_pic_url,
         p.gender,p.preferred_salutation,coalesce(p.profile->>'profile_sync_status','core_v10') as profile_sync_status,
         p.lead_state,coalesce(prod.business_group_name,'Chưa rõ sản phẩm') as business_group_name,
         case when coalesce(ob.sent_at,'epoch'::timestamptz)>coalesce(ie.occurred_at,'epoch'::timestamptz)
           then ob.text_body else ie.message_text end as last_message_text,
         greatest(coalesce(ie.occurred_at,'epoch'::timestamptz),coalesce(ob.sent_at,'epoch'::timestamptz),p.activity_at) as last_message_at,
         (coalesce(ec.inbound_count,0)+coalesce(bc.outbound_count,0))::integer as message_count,
         coalesce(ec.inbound_count,0)::integer as inbound_count,coalesce(bc.outbound_count,0)::integer as outbound_count,
         'core_v10'::text as data_source
  from paged p
  left join lateral (
    select e.message_text,e.occurred_at from public.v9_events e
    where e.page_id=p.page_id and coalesce(e.customer_id,e.sender_id)=p.sender_id
    order by e.occurred_at desc nulls last limit 1
  ) ie on true
  left join lateral (
    select b.text_body,coalesce(a.completed_at,b.updated_at,b.created_at) as sent_at
    from public.v9_delivery_bundles b
    left join lateral (select da.completed_at from public.v9_delivery_attempts da
      where da.bundle_id=b.id and da.status='sent' order by da.attempt_no desc limit 1) a on true
    where b.page_id=p.page_id and b.sender_id=p.sender_id and b.status in ('sent','partial')
    order by coalesce(a.completed_at,b.updated_at,b.created_at) desc limit 1
  ) ob on true
  left join lateral (select count(*)::integer as inbound_count from public.v9_events e
    where e.page_id=p.page_id and coalesce(e.customer_id,e.sender_id)=p.sender_id) ec on true
  left join lateral (select count(*)::integer as outbound_count from public.v9_delivery_bundles b
    where b.page_id=p.page_id and b.sender_id=p.sender_id and b.status in ('sent','partial')) bc on true
  left join lateral (
    select coalesce(nullif(d.output->'selected_products'->>0,''),nullif(d.output->'follow_up_plan'->0->>'topic',''),
      nullif(d.output->'intents'->>0,'')) as business_group_name
    from public.v9_decisions d where d.page_id=p.page_id and d.sender_id=p.sender_id
    order by d.created_at desc limit 1
  ) prod on true
)
select jsonb_build_object('ok',true,
  'data',coalesce((select jsonb_agg(to_jsonb(d) order by d.last_message_at desc) from decorated d),'[]'::jsonb),
  'count',(select count(*) from base),'selected_limit',(select selected_limit from params),'offset',(select selected_offset from params),
  'data_source','core_v10','generated_at',now());
$function$;

create or replace function public.v10_learning_conversation_detail(p_page_id text,p_sender_id text)
returns jsonb
language sql
security definer
set search_path to 'public'
as $function$
with customer as (
  select c.*,s.state,s.contact_status,s.phone,s.zalo,s.human_takeover,s.human_takeover_until,
         s.last_customer_event_at,s.last_page_event_at,s.updated_at as state_updated_at
  from public.v9_customers c
  left join public.v9_conversation_state s on s.page_id=c.page_id and s.sender_id=c.customer_id
  where c.page_id=p_page_id and c.customer_id=p_sender_id limit 1
), inbound as (
  select jsonb_build_object('id',e.id,'message_id',e.message_id,'source_event_id',e.source_event_id,
    'direction','inbound','role','customer','actor_type','customer',
    'actor_name',coalesce((select display_name from customer),'Khách hàng'),'source_system',e.source_system,
    'message_text',coalesce(e.message_text,''),'text',coalesce(e.message_text,''),'attachments',coalesce(e.attachments,'[]'::jsonb),
    'sent_at',e.occurred_at,'created_at',e.created_at,'event_type',e.event_type,'raw_payload',e.payload) as item,
    e.occurred_at as sort_at
  from public.v9_events e where e.page_id=p_page_id and coalesce(e.customer_id,e.sender_id)=p_sender_id
  order by e.occurred_at desc limit 1000
), outbound as (
  select jsonb_build_object('id',b.id,'message_id',coalesce(a.provider_message_id,b.id::text),'direction','outbound',
    'role','bot','actor_type','bot','actor_name','AIGUKA','source_system','core_v10_outbound',
    'message_text',coalesce(b.text_body,''),'text',coalesce(b.text_body,''),'attachments',coalesce(b.asset_refs,'[]'::jsonb),
    'sent_at',coalesce(a.completed_at,b.updated_at,b.created_at),'created_at',b.created_at,'delivery_status',b.status,
    'decision_id',b.decision_id,'provider_message_id',a.provider_message_id) as item,
    coalesce(a.completed_at,b.updated_at,b.created_at) as sort_at
  from public.v9_delivery_bundles b
  left join lateral (select da.provider_message_id,da.completed_at from public.v9_delivery_attempts da
    where da.bundle_id=b.id and da.status='sent' order by da.attempt_no desc limit 1) a on true
  where b.page_id=p_page_id and b.sender_id=p_sender_id and b.status in ('sent','partial')
  order by coalesce(a.completed_at,b.updated_at,b.created_at) desc limit 500
), timeline as (select * from inbound union all select * from outbound), decisions as (
  select d.* from public.v9_decisions d where d.page_id=p_page_id and d.sender_id=p_sender_id
  order by d.created_at desc limit 300
), latest_decision as (select * from decisions order by created_at desc limit 1), counts as (
  select (select count(*) from inbound)::integer as inbound,(select count(*) from outbound)::integer as outbound,
    ((select count(*) from inbound)+(select count(*) from outbound))::integer as total,
    (select count(*) from decisions)::integer as decisions
)
select jsonb_build_object('page_id',p_page_id,'sender_id',p_sender_id,'conversation_id',p_sender_id,'data_source','core_v10',
  'customer',coalesce((select to_jsonb(c) from customer c),'null'::jsonb),
  'state',coalesce((select jsonb_build_object('state',c.state,'contact_status',c.contact_status,'phone',c.phone,'zalo',c.zalo,
    'human_takeover',c.human_takeover,'human_takeover_until',c.human_takeover_until,
    'last_customer_event_at',c.last_customer_event_at,'last_page_event_at',c.last_page_event_at,'updated_at',c.state_updated_at)
    from customer c),'null'::jsonb),
  'events',coalesce((select jsonb_agg(t.item order by t.sort_at) from timeline t),'[]'::jsonb),
  'messages',coalesce((select jsonb_agg(t.item order by t.sort_at) from timeline t),'[]'::jsonb),
  'decisions',coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at desc) from decisions d),'[]'::jsonb),
  'reply_plans',coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at desc) from decisions d),'[]'::jsonb),
  'slide_logs','[]'::jsonb,'counts',(select to_jsonb(c) from counts c),
  'product_detection',coalesce((select jsonb_build_object('group_name',coalesce(
    nullif(d.output->'selected_products'->>0,''),nullif(d.output->'follow_up_plan'->0->>'topic',''),nullif(d.output->'intents'->>0,'')),
    'selected_products',coalesce(d.output->'selected_products','[]'::jsonb),
    'selected_catalog_keys',coalesce(d.output->'selected_catalog_keys','[]'::jsonb),'intent',d.output->'intents'->>0,
    'decision_id',d.id,'decision_status',d.status) from latest_decision d),'null'::jsonb),
  'history_warning',case when (select outbound from counts)=0 then 'Core V10 chưa ghi nhận gói gửi thành công cho hội thoại này.' else null end,
  'meta_sync_requested',jsonb_build_object('requested',0,'mode','manual_only'),'meta_sync_mode','manual_only','generated_at',now());
$function$;

revoke all on function public.v10_learning_conversation_list(text,integer,integer) from public,anon,authenticated;
revoke all on function public.v10_learning_conversation_detail(text,text) from public,anon,authenticated;
grant execute on function public.v10_learning_conversation_list(text,integer,integer) to service_role;
grant execute on function public.v10_learning_conversation_detail(text,text) to service_role;
