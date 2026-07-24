create or replace function public.v8_sync_obligation_from_ai_request()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.v8_response_obligations
  set ai_request_id=new.id,
      obligation_status=case
        when new.status='error' then 'ai_error'
        when new.status in ('pending','processing') then 'ai_pending'
        else obligation_status end,
      last_error=case when new.status='error' then new.last_error else last_error end,
      next_check_at=case
        when new.status='error' then now()+interval '5 seconds'
        else now()+interval '30 seconds' end,
      updated_at=now()
  where page_id=new.page_id and message_id=new.message_id and not is_resolved;
  return new;
end;
$function$;

drop trigger if exists trg_v8_sync_obligation_ai_request
  on public.v8_ai_brain_requests;
create trigger trg_v8_sync_obligation_ai_request
after insert or update of status,last_error,decision_id
on public.v8_ai_brain_requests
for each row execute function public.v8_sync_obligation_from_ai_request();

create or replace function public.v8_sync_obligation_from_ai_decision()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.v8_response_obligations
  set ai_decision_id=new.id,
      obligation_status=case
        when new.status='completed' then 'decision_ready'
        when new.status in ('error','revision_required') then 'ai_error'
        else obligation_status end,
      last_error=case
        when new.status in ('error','revision_required') then new.error
        else last_error end,
      next_check_at=case
        when new.status='completed' then now()+interval '10 seconds'
        else now()+interval '5 seconds' end,
      updated_at=now()
  where page_id=new.page_id and message_id=new.message_id and not is_resolved;
  return new;
end;
$function$;

drop trigger if exists trg_v8_sync_obligation_ai_decision
  on public.v8_ai_decisions;
create trigger trg_v8_sync_obligation_ai_decision
after insert or update of status,error,completed_at
on public.v8_ai_decisions
for each row execute function public.v8_sync_obligation_from_ai_decision();

create or replace function public.v8_sync_obligation_from_outbound()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_message_id text;
begin
  if new.ai_decision_id is not null then
    select message_id into v_message_id
    from public.v8_ai_decisions
    where id=new.ai_decision_id;
  end if;
  if v_message_id is null and new.reply_plan_id is not null then
    select message_id into v_message_id
    from public.v8_reply_plans
    where id=new.reply_plan_id;
  end if;
  if v_message_id is null then return new; end if;

  update public.v8_response_obligations
  set outbound_id=new.id,
      obligation_status=case
        when new.status='sent' then 'resolved_sent'
        when new.status in ('failed','cancelled') then 'outbound_failed'
        else 'outbound_pending' end,
      is_resolved=case when new.status='sent' then true else is_resolved end,
      resolution_code=case
        when new.status='sent' then 'OUTBOUND_QUEUE_SENT'
        else resolution_code end,
      resolved_at=case
        when new.status='sent' then coalesce(new.sent_at,now())
        else resolved_at end,
      last_error=case
        when new.status in ('failed','cancelled')
          then coalesce(new.last_error,new.cancel_reason)
        else null end,
      next_check_at=case
        when new.status='sent' then now()+interval '365 days'
        when new.status in ('failed','cancelled') then now()+interval '5 seconds'
        else now()+interval '30 seconds' end,
      updated_at=now()
  where page_id=new.page_id
    and message_id=v_message_id
    and (not is_resolved or new.status='sent');
  return new;
end;
$function$;

drop trigger if exists trg_v8_sync_obligation_outbound
  on public.v8_outbound_queue;
create trigger trg_v8_sync_obligation_outbound
after insert or update of status,last_error,cancel_reason,sent_at
on public.v8_outbound_queue
for each row execute function public.v8_sync_obligation_from_outbound();

create or replace function public.v8_response_obligation_status()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
select jsonb_build_object(
  'generated_at',now(),
  'unresolved_total',(
    select count(*) from public.v8_response_obligations where not is_resolved
  ),
  'unresolved_over_2m',(
    select count(*) from public.v8_response_obligations
    where not is_resolved and inbound_at<now()-interval '2 minutes'
  ),
  'unresolved_over_10m',(
    select count(*) from public.v8_response_obligations
    where not is_resolved and inbound_at<now()-interval '10 minutes'
  ),
  'by_status',coalesce((
    select jsonb_object_agg(obligation_status,cnt)
    from (
      select obligation_status,count(*) cnt
      from public.v8_response_obligations
      where not is_resolved
      group by obligation_status
    ) s
  ),'{}'::jsonb),
  'oldest_unresolved_at',(
    select min(inbound_at)
    from public.v8_response_obligations
    where not is_resolved
  ),
  'fallbacks_24h',(
    select count(*)
    from public.v8_ai_delivery_sla_events
    where action='safe_text_fallback'
      and created_at>=now()-interval '24 hours'
  ),
  'sale_escalations_open',(
    select count(*)
    from public.v8_sale_tasks
    where task_type='bot_delivery_rescue'
      and status in ('open','assigned','in_progress')
  ),
  'healthy',(
    select count(*)=0
    from public.v8_response_obligations
    where not is_resolved
      and inbound_at<now()-interval '2 minutes'
      and obligation_status<>'escalation_required'
  )
);
$function$;
