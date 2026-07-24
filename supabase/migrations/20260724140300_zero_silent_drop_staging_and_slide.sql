-- Staging errors are recorded for retry instead of rolling back a completed AI
-- decision. Duplicate asset ids are removed before authoritative output capture.

create or replace function public.v8_dedupe_ai_slide_assets_before_write()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_deduped jsonb:='[]'::jsonb;
begin
  if jsonb_typeof(coalesce(new.slide_asset_ids,'[]'::jsonb))='array' then
    with raw as (
      select value,min(ordinality)::integer first_order
      from jsonb_array_elements_text(coalesce(new.slide_asset_ids,'[]'::jsonb))
        with ordinality
      where value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      group by value
    )
    select coalesce(jsonb_agg(value order by first_order),'[]'::jsonb)
    into v_deduped
    from raw;
    new.slide_asset_ids:=v_deduped;
    if jsonb_typeof(coalesce(new.decision,'{}'::jsonb))='object' then
      new.decision:=jsonb_set(
        coalesce(new.decision,'{}'::jsonb),
        '{slide_asset_ids}',v_deduped,true
      );
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_v8_000_dedupe_slide_asset_ids
  on public.v8_ai_decisions;
create trigger trg_v8_000_dedupe_slide_asset_ids
before insert or update of slide_asset_ids,decision
on public.v8_ai_decisions
for each row execute function public.v8_dedupe_ai_slide_assets_before_write();

create or replace function public.v8_ai_stage_decision(p_decision_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public','extensions'
as $function$
declare
  d public.v8_ai_decisions%rowtype;
  v_catalog_count integer:=0;
begin
  select * into d
  from public.v8_ai_decisions
  where id=p_decision_id
  for update;
  if d.id is null then
    return jsonb_build_object('ok',false,'reason','decision_not_found');
  end if;

  if d.should_send_slide then
    with requested as (
      select distinct value::uuid asset_id
      from jsonb_array_elements_text(coalesce(d.slide_asset_ids,'[]'::jsonb))
      where value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
    select count(distinct a.catalog_key)::integer
    into v_catalog_count
    from requested rq
    join public.v8_drive_assets a on a.id=rq.asset_id
    where a.is_active and a.is_image and a.delivery_status='verified';
  end if;

  if v_catalog_count>1 then
    return public.v8_ai_stage_multi_catalog_decision(p_decision_id);
  end if;
  return public.v8_ai_stage_decision_single_catalog(p_decision_id);
end;
$function$;

create or replace function public.v8_stage_completed_ai_decision_trigger()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_stage jsonb:='{}'::jsonb;
  v_obligation_id uuid;
begin
  if new.status='completed'
     and coalesce(new.should_reply,false)
     and nullif(btrim(coalesce(new.final_reply,'')),'') is not null
     and coalesce(new.decision_authority,'ai_runtime') like 'ai_runtime%' then
    begin
      v_stage:=public.v8_ai_stage_decision(new.id);
      update public.v8_response_obligations
      set ai_decision_id=new.id,
          obligation_status=case
            when coalesce((v_stage->>'staged')::boolean,false)
              then 'outbound_pending'
            else 'staging_error' end,
          last_error=case
            when coalesce((v_stage->>'staged')::boolean,false) then null
            else coalesce(v_stage->>'reason',v_stage->>'error','STAGING_NOT_COMPLETED') end,
          resolution_details=coalesce(resolution_details,'{}'::jsonb)
            || jsonb_build_object('stage_result',v_stage,'stage_checked_at',now()),
          next_check_at=case
            when coalesce((v_stage->>'staged')::boolean,false)
              then now()+interval '30 seconds'
            else now()+interval '10 seconds' end,
          updated_at=now()
      where page_id=new.page_id and message_id=new.message_id
      returning id into v_obligation_id;

      if not coalesce((v_stage->>'staged')::boolean,false) then
        insert into public.v8_ai_delivery_sla_events(
          page_id,sender_id,customer_id,message_id,entity_type,entity_id,
          stage,action,reason,latency_seconds,details
        ) values(
          new.page_id,new.sender_id,new.customer_id,new.message_id,
          'ai_decision',new.id,'staging','staging_deferred',
          coalesce(v_stage->>'reason',v_stage->>'error','STAGING_NOT_COMPLETED'),
          null,v_stage
        )
        on conflict(entity_type,entity_id,action) do update set
          reason=excluded.reason,
          details=excluded.details,
          created_at=now();
      end if;
    exception when others then
      update public.v8_response_obligations
      set ai_decision_id=new.id,
          obligation_status='staging_error',
          last_error=left(sqlerrm,500),
          next_check_at=now()+interval '10 seconds',
          updated_at=now()
      where page_id=new.page_id and message_id=new.message_id
      returning id into v_obligation_id;

      insert into public.v8_ai_delivery_sla_events(
        page_id,sender_id,customer_id,message_id,entity_type,entity_id,
        stage,action,reason,details
      ) values(
        new.page_id,new.sender_id,new.customer_id,new.message_id,
        'ai_decision',new.id,'staging','staging_exception',
        left(sqlerrm,500),jsonb_build_object('sqlstate',sqlstate)
      )
      on conflict(entity_type,entity_id,action) do update set
        reason=excluded.reason,
        details=excluded.details,
        created_at=now();
    end;
  end if;
  return new;
end;
$function$;

-- Keep the original trigger name so existing installations are upgraded in place.
drop trigger if exists trg_v8_stage_completed_ai_decision
  on public.v8_ai_decisions;
create trigger trg_v8_stage_completed_ai_decision
after insert or update of status,should_reply,final_reply
on public.v8_ai_decisions
for each row execute function public.v8_stage_completed_ai_decision_trigger();

-- Text is normally held until the carousel is confirmed. If the carousel fails
-- for a transport reason, release a truthful text-only fallback instead of
-- cancelling the entire response.
create or replace function public.v8_release_ai_text_after_slide_sent()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  d public.v8_ai_decisions%rowtype;
  v_text text;
  v_has_contact boolean:=false;
  v_intentional boolean:=false;
  v_can_send boolean:=false;
begin
  if new.ai_decision_id is null
     or new.message_type not in ('carousel','generic_template','template','image')
     or old.status is not distinct from new.status then
    return new;
  end if;

  if new.status='sent' then
    update public.v8_outbound_queue q
    set status='ready',due_at=now(),last_error=null,updated_at=now()
    where q.ai_decision_id=new.ai_decision_id
      and q.message_type='text'
      and q.status='planned'
      and q.last_error='awaiting_required_slide_delivery';
    return new;
  end if;

  if new.status not in ('cancelled','failed') then return new; end if;

  v_intentional:=coalesce(new.cancel_reason,'') in (
    'external_responder_replied','EXTERNAL_RESPONDER_REPLIED',
    'newer_customer_message','customer_contact_provided',
    'customer_declined_after_sample_request','newer_sample_scope_requested',
    'BOT_CONTROL_CHANGED_AFTER_AUTHORIZATION',
    'BOT_CONTROL_CHANGED_DURING_TRANSPORT'
  );

  select * into d
  from public.v8_ai_decisions
  where id=new.ai_decision_id
  for update;
  if d.id is null then return new; end if;

  if exists(
    select 1
    from public.v8_messages_raw ni
    join public.v8_messages_raw src
      on src.page_id=d.page_id and src.message_id=d.message_id
    where ni.customer_id=d.customer_id
      and ni.direction='inbound'
      and ni.sent_at>src.sent_at
  ) then
    v_intentional:=true;
  end if;

  if exists(
    select 1
    from public.v8_messages_raw ho
    join public.v8_messages_raw src
      on src.page_id=d.page_id and src.message_id=d.message_id
    where ho.customer_id=d.customer_id
      and ho.direction='outbound'
      and ho.sent_at>=src.sent_at
      and public.v8_is_confirmed_human_outbound(
        ho.source_system,ho.message_text,ho.attachments,ho.is_automatic,
        ho.actor_type,ho.source_detail,ho.actor_app_id
      )
  ) then
    v_intentional:=true;
  end if;

  if v_intentional then
    update public.v8_outbound_queue q
    set status='cancelled',
        cancelled_at=now(),
        cancel_reason=coalesce(new.cancel_reason,'required_slide_delivery_cancelled'),
        last_error=null,
        updated_at=now()
    where q.ai_decision_id=new.ai_decision_id
      and q.message_type='text'
      and q.status='planned'
      and q.last_error='awaiting_required_slide_delivery';
    return new;
  end if;

  select coalesce(pol.can_send_text,false)
  into v_can_send
  from public.v8_resolve_runtime_policy(d.page_id) pol
  limit 1;
  if not v_can_send then return new; end if;

  select coalesce(c.phone is not null or c.zalo is not null,false)
         or coalesce(s.has_phone,false)
  into v_has_contact
  from public.v8_customers c
  left join public.v8_conversation_states s on s.customer_id=c.id
  where c.id=d.customer_id;
  v_has_contact:=coalesce(v_has_contact,false);

  v_text:=case when v_has_contact then
    'Dạ, phần hình ảnh vừa tải chưa thành công. Bên em đã ghi nhận nhu cầu của mình; nhân viên sẽ kiểm tra đúng mẫu và tư vấn qua thông tin mình đã gửi ạ.'
  else
    'Dạ, phần hình ảnh vừa tải chưa thành công. Bên em đã ghi nhận nhu cầu của mình; mình cho em xin SĐT hoặc Zalo, nhân viên sẽ kiểm tra đúng mẫu và gửi lại ạ.'
  end;

  update public.v8_ai_decisions
  set should_send_slide=false,
      slide_asset_ids='[]'::jsonb,
      final_reply=v_text,
      should_request_contact=not v_has_contact,
      should_handoff_sale=v_has_contact,
      decision=coalesce(decision,'{}'::jsonb)
        || jsonb_build_object(
          'final_reply',v_text,
          'should_send_slide',false,
          'slide_asset_ids','[]'::jsonb,
          'should_request_contact',not v_has_contact,
          'should_handoff_sale',v_has_contact,
          'delivery_degraded_to_text',true,
          'slide_failure_reason',coalesce(new.cancel_reason,new.last_error,'unknown'),
          'degraded_at',now()
        ),
      risk_flags=coalesce(risk_flags,'[]'::jsonb)
        || jsonb_build_array('slide_delivery_failed_text_fallback'),
      model_output=null,
      decision_authority='system_fallback',
      prompt_version='slide_failure_text_fallback_v1',
      updated_at=now()
  where id=d.id;

  update public.v8_reply_plans
  set suggested_reply=v_text,
      should_request_phone=not v_has_contact,
      should_handoff_sale=v_has_contact,
      send_eligible=true,
      safety_status='ready_to_send',
      blocked_reason=null,
      dispatch_status='staged',
      reason=coalesce(reason,'{}'::jsonb)
        || jsonb_build_object(
          'slide_failure_text_fallback',true,
          'slide_outbound_id',new.id
        )
  where ai_decision_id=d.id
    and coalesce(dispatch_status,'not_staged')<>'sent';

  update public.v8_outbound_queue q
  set payload=jsonb_set(coalesce(q.payload,'{}'::jsonb),'{text}',to_jsonb(v_text),true),
      status='ready',
      due_at=now(),
      last_error=null,
      cancelled_at=null,
      cancel_reason=null,
      locked_at=null,
      locked_by=null,
      authorized_at=null,
      authorized_by=null,
      authorization_version=null,
      authorization_details='{}'::jsonb,
      transport_confirmed_at=null,
      transport_confirmed_by=null,
      updated_at=now()
  where q.ai_decision_id=d.id
    and q.message_type='text'
    and q.status in ('planned','cancelled','failed')
    and (
      q.last_error='awaiting_required_slide_delivery'
      or q.cancel_reason='required_slide_delivery_failed'
      or q.status<>'planned'
    );

  update public.v8_response_obligations
  set obligation_status='outbound_pending',
      ai_decision_id=d.id,
      last_error='SLIDE_FAILED_DEGRADED_TO_TEXT',
      next_check_at=now()+interval '30 seconds',
      updated_at=now(),
      resolution_details=coalesce(resolution_details,'{}'::jsonb)
        || jsonb_build_object(
          'slide_failure_text_fallback',true,
          'slide_outbound_id',new.id
        )
  where page_id=d.page_id
    and message_id=d.message_id
    and not is_resolved;

  return new;
end;
$function$;

-- Replace the prior trigger in place. The exact trigger name may already exist.
drop trigger if exists trg_v8_release_ai_text_after_slide_sent
  on public.v8_outbound_queue;
create trigger trg_v8_release_ai_text_after_slide_sent
after update of status
on public.v8_outbound_queue
for each row execute function public.v8_release_ai_text_after_slide_sent();
