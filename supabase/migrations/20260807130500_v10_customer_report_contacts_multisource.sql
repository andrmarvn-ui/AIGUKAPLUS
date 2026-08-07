create or replace function public.v10_report_customer_metrics(
  p_from date default current_date,
  p_to date default current_date,
  p_page_id text default null,
  p_ad_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_from date := coalesce(p_from, current_date);
  v_to date := coalesce(p_to, current_date);
  v_result jsonb;
  v_role text := coalesce(current_setting('request.jwt.claim.role', true), '');
begin
  if session_user <> 'postgres'
     and v_role <> 'service_role'
     and not aiguka_private.v9_bridge_authorized() then
    raise insufficient_privilege using message = 'v10_report_customer_metrics_bridge_required';
  end if;

  if v_from > v_to then raise exception 'date_from_after_date_to'; end if;
  if v_to - v_from > 731 then raise exception 'date_range_too_large'; end if;
  perform set_config('statement_timeout', '12000', true);

  with valid_events as (
    select e.id, e.source_event_id, e.page_id, e.customer_id, e.message_text, e.occurred_at,
      (e.occurred_at at time zone 'Asia/Ho_Chi_Minh')::date as event_date
    from public.v9_events e
    where e.actor_type = 'customer'
      and e.event_type in ('customer_message','customer_comment')
      and e.customer_id is not null and btrim(e.customer_id) <> ''
      and e.customer_id <> e.page_id
      and e.occurred_at >= (v_from::timestamp at time zone 'Asia/Ho_Chi_Minh')
      and e.occurred_at < ((v_to + 1)::timestamp at time zone 'Asia/Ho_Chi_Minh')
      and (nullif(btrim(p_page_id),'') is null or e.page_id = p_page_id)
  ),
  first_touch as (
    select distinct on (page_id, customer_id)
      page_id, customer_id, event_date as report_date, occurred_at as first_customer_at
    from valid_events
    order by page_id, customer_id, occurred_at asc, id asc
  ),
  first_referral as (
    select distinct on (e.page_id, e.customer_id)
      e.page_id, e.customer_id, nullif(btrim(e.referral->>'ad_id'),'') as ad_id,
      e.occurred_at as referral_at
    from public.v9_events e
    join first_touch f on f.page_id = e.page_id and f.customer_id = e.customer_id
    where e.customer_id is not null and e.customer_id <> e.page_id
      and nullif(btrim(e.referral->>'ad_id'),'') is not null
      and e.occurred_at < ((v_to + 1)::timestamp at time zone 'Asia/Ho_Chi_Minh')
    order by e.page_id, e.customer_id, e.occurred_at asc, e.id asc
  ),
  message_counts as (
    select page_id, customer_id, count(*)::bigint as message_count
    from valid_events group by page_id, customer_id
  ),
  contact_evidence as (
    select distinct c.page_id, c.customer_id, 'v9_contacts'::text as source
    from public.v9_contacts c
    join first_touch f on f.page_id = c.page_id and f.customer_id = c.customer_id
    where c.captured_at < ((v_to + 1)::timestamp at time zone 'Asia/Ho_Chi_Minh')

    union

    select distinct g.page_id, g.sender_id as customer_id, 'pancake_contact_tag'::text as source
    from public.v10_followup_contact_guard g
    join first_touch f on f.page_id = g.page_id and f.customer_id = g.sender_id
    where g.has_contact_tag = true
      and coalesce(g.source_updated_at, g.checked_at, now()) < ((v_to + 1)::timestamp at time zone 'Asia/Ho_Chi_Minh')

    union

    select distinct e.page_id, e.customer_id, 'contact_detector_observation'::text as source
    from public.v9_shadow_observations o
    join public.v9_events e on e.source_event_id = o.source_event_id
    join first_touch f on f.page_id = e.page_id and f.customer_id = e.customer_id
    where e.actor_type = 'customer'
      and e.occurred_at < ((v_to + 1)::timestamp at time zone 'Asia/Ho_Chi_Minh')
      and coalesce((o.contact_detection->>'hasPhone')::boolean, false) = true
  ),
  contact_customers as (
    select distinct page_id, customer_id from contact_evidence
  ),
  customer_rows as (
    select f.report_date, f.page_id, r.ad_id, f.customer_id,
      coalesce(m.message_count,0)::bigint as message_count,
      (c.customer_id is not null) as has_contact
    from first_touch f
    left join first_referral r on r.page_id = f.page_id and r.customer_id = f.customer_id
    left join message_counts m on m.page_id = f.page_id and m.customer_id = f.customer_id
    left join contact_customers c on c.page_id = f.page_id and c.customer_id = f.customer_id
    where nullif(btrim(p_ad_id),'') is null or r.ad_id = p_ad_id
  ),
  aggregated as (
    select report_date, page_id, ad_id,
      count(*)::bigint as conversations,
      count(*) filter (where has_contact)::bigint as contacts,
      count(*) filter (where has_contact)::bigint as hot_leads,
      coalesce(sum(message_count),0)::bigint as message_count
    from customer_rows group by report_date, page_id, ad_id
  )
  select jsonb_build_object(
    'ok', true,
    'data', coalesce((select jsonb_agg(to_jsonb(a) order by a.report_date desc, a.page_id, a.ad_id nulls last) from aggregated a), '[]'::jsonb),
    'source', 'v10_core_live_customer_metrics_multisource_contact',
    'contact_sources', jsonb_build_array('v9_contacts','pancake_contact_tag','contact_detector_observation'),
    'range', jsonb_build_object('from', v_from, 'to', v_to)
  ) into v_result;
  return v_result;
end;
$function$;

-- Railway may access Core in database-bridge mode with the publishable role.
-- The function itself verifies x-aiguka-core-bridge before returning aggregates.
revoke all on function public.v10_report_customer_metrics(date,date,text,text) from public;
grant execute on function public.v10_report_customer_metrics(date,date,text,text) to service_role, authenticated, anon;

comment on function public.v10_report_customer_metrics(date,date,text,text) is
  'Aggregate-only reporting RPC. Database-bridge or service-role authorization required. Counts V10 contacts, Pancake contact tags and contact-detector observations; exposes no PII.';
