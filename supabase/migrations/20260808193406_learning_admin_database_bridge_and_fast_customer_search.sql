-- Allow the authenticated Railway database bridge to use the V10 learning RPCs
-- without exposing customer data to ordinary publishable-key requests.
-- Name searches intentionally stay on indexed customer/state fields; searching the
-- full message corpus here previously exhausted statement_timeout in production.

alter function public.v10_learning_conversation_list(text, integer, integer)
  rename to v10_learning_conversation_list_service;
alter function public.v10_learning_conversation_detail(text, text)
  rename to v10_learning_conversation_detail_service;

revoke all on function public.v10_learning_conversation_list_service(text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.v10_learning_conversation_detail_service(text, text)
  from public, anon, authenticated;
grant execute on function public.v10_learning_conversation_list_service(text, integer, integer)
  to service_role;
grant execute on function public.v10_learning_conversation_detail_service(text, text)
  to service_role;

create or replace function public.v10_learning_conversation_list(
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0
) returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_role text := coalesce(current_setting('request.jwt.claim.role', true), '');
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_result jsonb;
begin
  if session_user <> 'postgres'
     and v_role <> 'service_role'
     and not aiguka_private.v9_bridge_authorized() then
    raise insufficient_privilege using message = 'v10_learning_conversation_list_bridge_required';
  end if;

  if v_search is null then
    return public.v10_learning_conversation_list_service(null, v_limit, v_offset);
  end if;

  perform set_config('statement_timeout', '12000', true);
  with matched as (
    select
      s.page_id,
      coalesce(p.page_name, s.page_id) as page_name,
      s.sender_id,
      s.sender_id as conversation_id,
      c.id as customer_id,
      c.display_name,
      s.phone,
      s.zalo,
      coalesce(c.profile->>'profile_pic_url', c.profile->>'picture_url',
        c.profile#>>'{picture,data,url}', c.profile->>'avatar_url') as profile_pic_url,
      c.gender,
      c.preferred_salutation,
      coalesce(c.profile->>'profile_sync_status', 'core_v10') as profile_sync_status,
      s.state as lead_state,
      'Chưa rõ sản phẩm'::text as business_group_name,
      null::text as last_message_text,
      greatest(coalesce(s.last_customer_event_at, 'epoch'::timestamptz),
        coalesce(s.last_page_event_at, 'epoch'::timestamptz),
        coalesce(s.updated_at, 'epoch'::timestamptz)) as last_message_at,
      0::integer as message_count,
      0::integer as inbound_count,
      0::integer as outbound_count,
      'core_v10_fast_customer_search'::text as data_source
    from public.v9_conversation_state s
    join public.v9_customers c
      on c.page_id = s.page_id and c.customer_id = s.sender_id
    left join public.v9_pages p on p.page_id = s.page_id
    where s.page_id is not null
      and s.sender_id is not null
      and s.page_id <> s.sender_id
      and concat_ws(' ', c.display_name, s.phone, s.zalo, s.sender_id, p.page_name,
        s.state, s.contact_status) ilike '%' || v_search || '%'
    order by last_message_at desc, s.page_id, s.sender_id
    limit v_limit offset v_offset
  )
  select jsonb_build_object(
    'ok', true,
    'data', coalesce(jsonb_agg(to_jsonb(m) order by m.last_message_at desc), '[]'::jsonb),
    'count', count(*),
    'selected_limit', v_limit,
    'offset', v_offset,
    'data_source', 'core_v10_fast_customer_search',
    'generated_at', now()
  ) into v_result
  from matched m;

  return v_result;
end;
$function$;

create or replace function public.v10_learning_conversation_detail(
  p_page_id text,
  p_sender_id text
) returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_role text := coalesce(current_setting('request.jwt.claim.role', true), '');
begin
  if session_user <> 'postgres'
     and v_role <> 'service_role'
     and not aiguka_private.v9_bridge_authorized() then
    raise insufficient_privilege using message = 'v10_learning_conversation_detail_bridge_required';
  end if;
  return public.v10_learning_conversation_detail_service(p_page_id, p_sender_id);
end;
$function$;

revoke all on function public.v10_learning_conversation_list(text, integer, integer) from public;
revoke all on function public.v10_learning_conversation_detail(text, text) from public;
grant execute on function public.v10_learning_conversation_list(text, integer, integer)
  to service_role, authenticated, anon;
grant execute on function public.v10_learning_conversation_detail(text, text)
  to service_role, authenticated, anon;

comment on function public.v10_learning_conversation_list(text, integer, integer) is
  'Bridge-protected V10 learning list; customer identity search avoids unindexed message-corpus scans.';
comment on function public.v10_learning_conversation_detail(text, text) is
  'Bridge-protected V10 learning detail for Railway admin.';
