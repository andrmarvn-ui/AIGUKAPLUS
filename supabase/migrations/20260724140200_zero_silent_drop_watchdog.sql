-- Watchdog closes the gap between independently successful pipeline tables.
-- It is idempotent and guarded by an advisory lock.

create or replace function public.v8_reconcile_response_obligations(
  p_limit integer default 200
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','extensions'
as $function$
declare
  v_locked boolean:=false;
  v_limit integer:=least(greatest(coalesce(p_limit,200),1),1000);
  v_backfilled integer:=0;
  v_resolved_sent integer:=0;
  v_resolved_human integer:=0;
  v_resolved_superseded integer:=0;
  v_requests integer:=0;
  v_staged integer:=0;
  v_fallbacks integer:=0;
  v_escalated integer:=0;
  v_request_id uuid;
  v_stage jsonb;
  v_rescue jsonb;
  v_task uuid;
  r record;
begin
  select pg_try_advisory_xact_lock(
    hashtextextended('v8_response_obligation_watchdog',0)
  ) into v_locked;
  if not coalesce(v_locked,false) then
    return jsonb_build_object('ok',true,'skipped',true,'reason','watchdog_already_running');
  end if;

  insert into public.v8_response_obligations(
    page_id,sender_id,customer_id,message_row_id,message_id,inbound_at,
    inbound_text,source_system,obligation_status,is_resolved,resolution_code,
    resolution_details,next_check_at
  )
  select m.page_id,m.sender_id,m.customer_id,m.id,m.message_id,m.sent_at,
         m.message_text,m.source_system,
         case when public.v8_obligation_is_low_value(m.message_text,m.attachments)
           then 'resolved_low_value' else 'received' end,
         public.v8_obligation_is_low_value(m.message_text,m.attachments),
         case when public.v8_obligation_is_low_value(m.message_text,m.attachments)
           then 'LOW_VALUE_TURN' else null end,
         jsonb_build_object('source','watchdog_backfill','backfilled_at',now()),
         now()
  from public.v8_messages_raw m
  where m.direction='inbound'
    and coalesce(m.actor_type,'customer')='customer'
    and m.sent_at>=now()-interval '48 hours'
  on conflict(page_id,message_id) do nothing;
  get diagnostics v_backfilled=row_count;

  update public.v8_response_obligations o
  set obligation_status='resolved_superseded',is_resolved=true,
      resolution_code='NEWER_CUSTOMER_TURN',resolved_at=now(),updated_at=now(),
      resolution_details=coalesce(o.resolution_details,'{}'::jsonb)
        || jsonb_build_object('resolved_by','obligation_watchdog','resolved_at',now())
  where not o.is_resolved
    and exists(
      select 1 from public.v8_messages_raw ni
      where ni.page_id=o.page_id and ni.sender_id=o.sender_id
        and ni.direction='inbound'
        and coalesce(ni.actor_type,'customer')='customer'
        and ni.sent_at>o.inbound_at
    );
  get diagnostics v_resolved_superseded=row_count;

  update public.v8_response_obligations o
  set obligation_status='resolved_sent',is_resolved=true,
      resolution_code='BOT_DELIVERED',resolved_at=now(),updated_at=now(),last_error=null
  where not o.is_resolved
    and exists(
      select 1 from public.v8_messages_raw bo
      where bo.page_id=o.page_id and bo.sender_id=o.sender_id
        and bo.direction='outbound' and bo.sent_at>=o.inbound_at
        and coalesce(bo.source_system,'') in ('aiguka','aiguka_v8')
    );
  get diagnostics v_resolved_sent=row_count;

  update public.v8_response_obligations o
  set obligation_status='resolved_human',is_resolved=true,
      resolution_code='HUMAN_REPLIED',resolved_at=now(),updated_at=now(),last_error=null
  where not o.is_resolved
    and exists(
      select 1 from public.v8_messages_raw ho
      where ho.page_id=o.page_id and ho.sender_id=o.sender_id
        and ho.direction='outbound' and ho.sent_at>=o.inbound_at
        and public.v8_is_confirmed_human_outbound(
          ho.source_system,ho.message_text,ho.attachments,ho.is_automatic,
          ho.actor_type,ho.source_detail,ho.actor_app_id
        )
    );
  get diagnostics v_resolved_human=row_count;

  perform public.v8_release_stale_outbound(2);

  for r in
    select o.*,m.message_text,m.attachments,m.sent_at as message_sent_at,
           ar.id request_id,ar.status request_status,
           ar.attempts request_attempts,ar.created_at request_created_at,
           ar.started_at request_started_at,ar.last_error request_error,
           d.id decision_id,d.status decision_status,d.should_reply,
           d.completed_at decision_completed_at,d.error decision_error,
           rp.id reply_plan_id,rp.dispatch_status,
           rp.created_at reply_plan_created_at,
           oq.id outbound_id,oq.status outbound_status,
           oq.cancel_reason,oq.last_error outbound_error,
           oq.created_at outbound_created_at
    from public.v8_response_obligations o
    join public.v8_messages_raw m on m.id=o.message_row_id
    left join lateral (
      select * from public.v8_ai_brain_requests x
      where x.page_id=o.page_id and x.message_id=o.message_id
      order by x.created_at desc limit 1
    ) ar on true
    left join lateral (
      select * from public.v8_ai_decisions x
      where x.page_id=o.page_id and x.message_id=o.message_id
      order by x.created_at desc limit 1
    ) d on true
    left join lateral (
      select * from public.v8_reply_plans x
      where x.ai_decision_id=d.id order by x.created_at desc limit 1
    ) rp on true
    left join lateral (
      select * from public.v8_outbound_queue x
      where x.ai_decision_id=d.id or x.reply_plan_id=rp.id
      order by x.created_at desc limit 1
    ) oq on true
    cross join lateral public.v8_resolve_runtime_policy(o.page_id) pol
    where not o.is_resolved
      and o.next_check_at<=now()
      and o.inbound_at>=now()-interval '48 hours'
      and coalesce(pol.can_send_text,false)
    order by o.inbound_at
    limit v_limit
    for update of o skip locked
  loop
    if public.v8_obligation_is_low_value(r.message_text,r.attachments) then
      update public.v8_response_obligations
      set obligation_status='resolved_low_value',is_resolved=true,
          resolution_code='LOW_VALUE_TURN',resolved_at=now(),updated_at=now()
      where id=r.id;
      continue;
    end if;

    if r.outbound_status='sent' then
      update public.v8_response_obligations
      set obligation_status='resolved_sent',is_resolved=true,
          resolution_code='OUTBOUND_QUEUE_SENT',resolved_at=now(),
          outbound_id=r.outbound_id,updated_at=now()
      where id=r.id;
      continue;
    end if;

    if r.outbound_status in ('failed','cancelled')
       and coalesce(r.cancel_reason,r.outbound_error,'') not in (
         'external_responder_replied','EXTERNAL_RESPONDER_REPLIED',
         'newer_customer_message','customer_contact_provided',
         'customer_declined_after_sample_request','newer_sample_scope_requested',
         'BOT_CONTROL_CHANGED_AFTER_AUTHORIZATION',
         'BOT_CONTROL_CHANGED_DURING_TRANSPORT'
       ) then
      v_rescue:=public.v8_apply_safe_fallback_for_obligation(
        r.id,'OUTBOUND_'||upper(r.outbound_status)||':'
          ||coalesce(r.cancel_reason,r.outbound_error,'unknown')
      );
      v_fallbacks:=v_fallbacks+1;
      continue;
    end if;

    if r.decision_status='completed'
       and coalesce(r.should_reply,false)
       and r.reply_plan_id is null
       and r.decision_completed_at<now()-interval '10 seconds' then
      begin
        v_stage:=public.v8_ai_stage_decision(r.decision_id);
      exception when others then
        v_stage:=jsonb_build_object(
          'ok',false,'staged',false,'error',left(sqlerrm,500)
        );
      end;
      if coalesce((v_stage->>'staged')::boolean,false) then
        v_staged:=v_staged+1;
        update public.v8_response_obligations
        set obligation_status='outbound_pending',ai_decision_id=r.decision_id,
            next_check_at=now()+interval '30 seconds',last_error=null,updated_at=now()
        where id=r.id;
      else
        v_rescue:=public.v8_apply_safe_fallback_for_obligation(
          r.id,'COMPLETED_DECISION_NOT_STAGED:'
            ||coalesce(v_stage->>'reason',v_stage->>'error','unknown')
        );
        v_fallbacks:=v_fallbacks+1;
      end if;
      continue;
    end if;

    if r.decision_status='completed'
       and not coalesce(r.should_reply,false)
       and r.decision_completed_at<now()-interval '20 seconds' then
      v_rescue:=public.v8_apply_safe_fallback_for_obligation(
        r.id,'AI_NO_REPLY_ON_ACTIONABLE_TURN'
      );
      v_fallbacks:=v_fallbacks+1;
      continue;
    end if;

    if r.decision_status in ('error','revision_required')
       or (r.request_status='error' and coalesce(r.request_attempts,0)>=2)
       or (r.request_status='completed' and r.decision_id is null
           and r.request_created_at<now()-interval '30 seconds') then
      v_rescue:=public.v8_apply_safe_fallback_for_obligation(
        r.id,
        coalesce(
          'AI_DECISION_'||upper(r.decision_status),
          'AI_REQUEST_'||upper(r.request_status),
          'AI_PIPELINE_FAILED'
        )
      );
      v_fallbacks:=v_fallbacks+1;
      continue;
    end if;

    if r.request_status='processing'
       and r.request_started_at<now()-interval '2 minutes' then
      update public.v8_ai_brain_requests
      set status='error',last_error='STALE_AI_PROCESSING_LOCK',
          dispatch_locked_at=null,dispatch_locked_by=null,completed_at=now()
      where id=r.request_id;
      update public.v8_response_obligations
      set obligation_status='ai_error',last_error='STALE_AI_PROCESSING_LOCK',
          next_check_at=now()+interval '5 seconds',updated_at=now()
      where id=r.id;
      continue;
    end if;

    if r.request_id is null then
      if public.v8_extract_vietnam_phone(r.message_text) is not null
         or public.v8_normalize_detector_text(r.message_text)
              ~ '(so zalo|so dien thoai|sdt|dia chi|o dau|showroom|cua hang.*dau|shop.*dau|sop.*dau)' then
        v_rescue:=public.v8_apply_safe_fallback_for_obligation(
          r.id,'MISSING_AI_REQUEST_DETERMINISTIC_RESCUE'
        );
        v_fallbacks:=v_fallbacks+1;
      else
        v_request_id:=public.v8_enqueue_ai_brain_request(
          r.page_id,r.sender_id,r.message_id,'sla_recovery_latest_turn'
        );
        update public.v8_ai_brain_requests
        set status=case when status in ('error','skipped') then 'pending' else status end,
            requested_by='sla_recovery_latest_turn',
            dispatch_locked_at=null,dispatch_locked_by=null,
            completed_at=case when status in ('error','skipped') then null else completed_at end,
            last_error=case when status in ('error','skipped') then null else last_error end,
            dispatch_details=coalesce(dispatch_details,'{}'::jsonb)
              || jsonb_build_object(
                'response_obligation_id',r.id,
                'zero_silent_drop_recovery',true,
                'not_before',now(),
                'recovered_at',now()
              )
        where id=v_request_id;
        update public.v8_response_obligations
        set ai_request_id=v_request_id,obligation_status='ai_pending',
            next_check_at=now()+interval '45 seconds',updated_at=now()
        where id=r.id;
        v_requests:=v_requests+1;
      end if;
      continue;
    end if;

    if r.reply_plan_id is not null
       and r.outbound_id is null
       and r.reply_plan_created_at<now()-interval '15 seconds' then
      begin
        v_stage:=public.v8_ai_stage_decision(r.decision_id);
      exception when others then
        v_stage:=jsonb_build_object(
          'ok',false,'staged',false,'error',left(sqlerrm,500)
        );
      end;
      if coalesce((v_stage->>'staged')::boolean,false) then
        v_staged:=v_staged+1;
      else
        v_rescue:=public.v8_apply_safe_fallback_for_obligation(
          r.id,'REPLY_PLAN_NOT_STAGED:'
            ||coalesce(v_stage->>'reason',v_stage->>'error','unknown')
        );
        v_fallbacks:=v_fallbacks+1;
      end if;
      continue;
    end if;

    update public.v8_response_obligations
    set ai_request_id=r.request_id,
        ai_decision_id=r.decision_id,
        reply_plan_id=r.reply_plan_id,
        outbound_id=r.outbound_id,
        obligation_status=case
          when r.outbound_status in ('ready','sending','planned') then 'outbound_pending'
          when r.reply_plan_id is not null then 'staging'
          when r.decision_id is not null then 'decision_ready'
          else 'ai_pending' end,
        next_check_at=now()+interval '30 seconds',
        updated_at=now()
    where id=r.id;
  end loop;

  for r in
    select id,last_error
    from public.v8_response_obligations
    where not is_resolved
      and rescue_attempts>=2
      and inbound_at<now()-interval '5 minutes'
      and obligation_status in ('escalation_required','ai_error','outbound_failed')
    order by inbound_at
    limit v_limit
  loop
    v_task:=public.v8_create_response_rescue_task(
      r.id,coalesce(r.last_error,'REPEATED_RESCUE_FAILURE'),'urgent'
    );
    update public.v8_response_obligations
    set obligation_status='escalation_required',
        next_check_at=now()+interval '15 minutes',updated_at=now()
    where id=r.id;
    v_escalated:=v_escalated+1;
  end loop;

  return jsonb_build_object(
    'ok',true,'skipped',false,'checked_at',now(),
    'backfilled',v_backfilled,
    'resolved_sent',v_resolved_sent,
    'resolved_human',v_resolved_human,
    'resolved_superseded',v_resolved_superseded,
    'requests_enqueued',v_requests,
    'decisions_staged',v_staged,
    'safe_fallbacks',v_fallbacks,
    'sale_escalations',v_escalated
  );
end;
$function$;

create or replace function public.v8_zero_silent_drop_tick(
  p_limit integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_locked boolean:=false;
  v_ready_before jsonb;
  v_obligations jsonb;
  v_ready_after jsonb;
  v_external integer:=0;
  v_external_after integer:=0;
  v_archived integer:=0;
begin
  select pg_try_advisory_xact_lock(
    hashtextextended('v8_zero_silent_drop_tick',0)
  ) into v_locked;
  if not coalesce(v_locked,false) then
    return jsonb_build_object('ok',true,'skipped',true,'reason','tick_already_running');
  end if;

  update public.v8_response_obligations
  set obligation_status='resolved_archived_history',
      is_resolved=true,
      resolution_code='HISTORY_TOO_OLD_FOR_DELIVERY',
      resolved_at=coalesce(resolved_at,now()),
      updated_at=now()
  where not is_resolved and inbound_at<now()-interval '48 hours';
  get diagnostics v_archived=row_count;

  v_ready_before:=public.v8_reconcile_ready_outbound_queue(
    least(greatest(coalesce(p_limit,300),1),1000)
  );

  update public.v8_response_obligations o
  set obligation_status='resolved_external',
      is_resolved=true,
      resolution_code='EXTERNAL_RESPONDER_REPLIED',
      resolved_at=now(),last_error=null,updated_at=now(),
      resolution_details=coalesce(o.resolution_details,'{}'::jsonb)
        || jsonb_build_object(
          'resolved_by','final_gate_external_responder','resolved_at',now()
        )
  where not o.is_resolved
    and (
      exists(
        select 1 from public.v8_messages_raw x
        where x.page_id=o.page_id and x.sender_id=o.sender_id
          and x.direction='outbound' and x.sent_at>=o.inbound_at
          and public.v8_is_actionable_external_outbound(
            x.source_system,x.message_text,x.attachments,x.is_automatic,
            x.actor_type,x.source_detail
          )
      )
      or exists(
        select 1
        from public.v8_ai_decisions d
        left join public.v8_reply_plans rp on rp.ai_decision_id=d.id
        join public.v8_outbound_queue q
          on q.ai_decision_id=d.id or q.reply_plan_id=rp.id
        where d.page_id=o.page_id and d.message_id=o.message_id
          and q.status='cancelled'
          and upper(coalesce(q.cancel_reason,''))='EXTERNAL_RESPONDER_REPLIED'
      )
    );
  get diagnostics v_external=row_count;

  v_obligations:=public.v8_reconcile_response_obligations(
    least(greatest(coalesce(p_limit,300),1),1000)
  );
  v_ready_after:=public.v8_reconcile_ready_outbound_queue(
    least(greatest(coalesce(p_limit,300),1),1000)
  );

  update public.v8_response_obligations o
  set obligation_status='resolved_external',
      is_resolved=true,
      resolution_code='EXTERNAL_RESPONDER_REPLIED',
      resolved_at=now(),last_error=null,updated_at=now()
  where not o.is_resolved
    and exists(
      select 1 from public.v8_ai_decisions d
      left join public.v8_reply_plans rp on rp.ai_decision_id=d.id
      join public.v8_outbound_queue q
        on q.ai_decision_id=d.id or q.reply_plan_id=rp.id
      where d.page_id=o.page_id and d.message_id=o.message_id
        and q.status='cancelled'
        and upper(coalesce(q.cancel_reason,''))='EXTERNAL_RESPONDER_REPLIED'
    );
  get diagnostics v_external_after=row_count;
  v_external:=v_external+v_external_after;

  return jsonb_build_object(
    'ok',true,'skipped',false,'checked_at',now(),
    'archived_history',v_archived,
    'external_responder_resolved',v_external,
    'ready_reconcile_before',v_ready_before,
    'obligation_reconcile',v_obligations,
    'ready_reconcile_after',v_ready_after,
    'status',public.v8_response_obligation_status()
  );
end;
$function$;

-- Stagger heavyweight maintenance so it no longer collides at every minute.
select cron.alter_job(2,'1-59/5 * * * *',null,null,null,true);
select cron.alter_job(11,'2-59/5 * * * *',null,null,null,true);
select cron.alter_job(6,'3-59/10 * * * *',null,null,null,true);
select cron.alter_job(8,'4-59/10 * * * *',null,null,null,true);
select cron.alter_job(9,'6-59/10 * * * *',null,null,null,true);
select cron.alter_job(3,'7-59/15 * * * *',null,null,null,true);
select cron.alter_job(16,'8,23,38,53 * * * *',null,null,null,true);
select cron.alter_job(
  18,'* * * * *','select public.v8_zero_silent_drop_tick(300);',
  null,null,true
);
