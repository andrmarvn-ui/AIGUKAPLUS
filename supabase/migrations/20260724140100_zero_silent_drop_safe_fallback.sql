-- Safe fallback is used only after the normal AI/delivery path is terminally
-- broken. It never invents numeric prices, stock or product specifications.

create or replace function public.v8_sync_response_obligation_pipeline(
  p_page_id text,
  p_message_id text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  o public.v8_response_obligations%rowtype;
  r public.v8_ai_brain_requests%rowtype;
  d public.v8_ai_decisions%rowtype;
  rp public.v8_reply_plans%rowtype;
  oq public.v8_outbound_queue%rowtype;
begin
  select * into o
  from public.v8_response_obligations
  where page_id=p_page_id and message_id=p_message_id
  for update;
  if o.id is null then return jsonb_build_object('ok',false,'reason','obligation_not_found'); end if;
  if o.is_resolved then
    return jsonb_build_object('ok',true,'resolved',true,'status',o.obligation_status);
  end if;

  select * into r from public.v8_ai_brain_requests
  where page_id=o.page_id and message_id=o.message_id
  order by created_at desc limit 1;
  select * into d from public.v8_ai_decisions
  where page_id=o.page_id and message_id=o.message_id
  order by created_at desc limit 1;
  if d.id is not null then
    select * into rp from public.v8_reply_plans
    where ai_decision_id=d.id order by created_at desc limit 1;
    select * into oq from public.v8_outbound_queue
    where ai_decision_id=d.id or reply_plan_id=rp.id
    order by case status
      when 'sent' then 0 when 'sending' then 1 when 'ready' then 2
      when 'planned' then 3 else 4 end,created_at desc
    limit 1;
  end if;

  update public.v8_response_obligations
  set ai_request_id=r.id,
      ai_decision_id=d.id,
      reply_plan_id=rp.id,
      outbound_id=oq.id,
      obligation_status=case
        when oq.status='sent' then 'resolved_sent'
        when oq.status in ('failed','cancelled') then 'outbound_failed'
        when oq.status in ('ready','sending','planned') then 'outbound_pending'
        when rp.id is not null then 'staging'
        when d.status='completed' then 'decision_ready'
        when d.status in ('error','revision_required') then 'ai_error'
        when r.status='error' then 'ai_error'
        when r.id is not null then 'ai_pending'
        else obligation_status end,
      is_resolved=case when oq.status='sent' then true else is_resolved end,
      resolution_code=case when oq.status='sent' then 'OUTBOUND_QUEUE_SENT' else resolution_code end,
      resolved_at=case when oq.status='sent' then coalesce(oq.sent_at,now()) else resolved_at end,
      last_error=coalesce(oq.last_error,oq.cancel_reason,d.error,r.last_error,last_error),
      next_check_at=case
        when oq.status='sent' then now()+interval '365 days'
        when oq.status in ('ready','sending','planned') then now()+interval '30 seconds'
        else now()+interval '15 seconds' end,
      updated_at=now()
  where id=o.id;

  return jsonb_build_object(
    'ok',true,'obligation_id',o.id,'request_id',r.id,'decision_id',d.id,
    'reply_plan_id',rp.id,'outbound_id',oq.id,'outbound_status',oq.status
  );
end;
$function$;

create or replace function public.v8_create_response_rescue_task(
  p_obligation_id uuid,
  p_reason text,
  p_priority text default 'high'
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  o public.v8_response_obligations%rowtype;
  v_id uuid;
begin
  select * into o from public.v8_response_obligations where id=p_obligation_id;
  if o.id is null then return null; end if;

  select id into v_id
  from public.v8_sale_tasks
  where metadata->>'response_obligation_id'=o.id::text
    and status in ('open','assigned','in_progress')
  order by created_at desc limit 1;
  if v_id is not null then return v_id; end if;

  insert into public.v8_sale_tasks(
    customer_id,page_id,sender_id,task_type,priority,title,note,
    due_at,status,metadata
  ) values(
    o.customer_id,o.page_id,o.sender_id,'bot_delivery_rescue',
    coalesce(nullif(p_priority,''),'high'),
    'Khách chưa nhận được phản hồi',
    left('Tin khách: '||coalesce(o.inbound_text,'[ảnh/tệp]')
      ||'. Lý do cứu hộ: '||coalesce(p_reason,'unknown'),1000),
    now(),'open',jsonb_build_object(
      'response_obligation_id',o.id,
      'message_id',o.message_id,
      'reason',p_reason,
      'created_by','zero_silent_drop_watchdog'
    )
  ) returning id into v_id;
  return v_id;
end;
$function$;

create or replace function public.v8_apply_safe_fallback_for_obligation(
  p_obligation_id uuid,
  p_reason text default 'AI_DELIVERY_FAILED'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','extensions'
as $function$
declare
  o public.v8_response_obligations%rowtype;
  m public.v8_messages_raw%rowtype;
  c public.v8_customers%rowtype;
  s public.v8_conversation_states%rowtype;
  pol record;
  v_norm text;
  v_phone text;
  v_has_contact boolean:=false;
  v_product_label text;
  v_reply text;
  v_intent text:='other';
  v_request_contact boolean:=false;
  v_handoff boolean:=false;
  v_decision_id uuid;
  v_stage jsonb:='{}'::jsonb;
  v_task_id uuid;
  v_now timestamptz:=now();
begin
  select * into o
  from public.v8_response_obligations
  where id=p_obligation_id
  for update;
  if o.id is null then return jsonb_build_object('ok',false,'reason','obligation_not_found'); end if;
  if o.is_resolved then
    return jsonb_build_object('ok',true,'skipped',true,'reason','already_resolved','status',o.obligation_status);
  end if;

  select * into m from public.v8_messages_raw where id=o.message_row_id;
  if m.id is null then
    select * into m from public.v8_messages_raw
    where page_id=o.page_id and message_id=o.message_id limit 1;
  end if;
  if m.id is null then
    update public.v8_response_obligations
    set obligation_status='escalation_required',last_error='SOURCE_MESSAGE_NOT_FOUND',
        next_check_at=now()+interval '5 minutes',updated_at=now()
    where id=o.id;
    v_task_id:=public.v8_create_response_rescue_task(o.id,'SOURCE_MESSAGE_NOT_FOUND','urgent');
    return jsonb_build_object('ok',false,'reason','source_message_not_found','sale_task_id',v_task_id);
  end if;

  if exists(
    select 1 from public.v8_messages_raw ni
    where ni.customer_id=o.customer_id
      and ni.direction='inbound'
      and coalesce(ni.actor_type,'customer')='customer'
      and ni.sent_at>m.sent_at
  ) then
    update public.v8_response_obligations
    set obligation_status='resolved_superseded',is_resolved=true,
        resolution_code='NEWER_CUSTOMER_TURN',resolved_at=now(),updated_at=now()
    where id=o.id;
    return jsonb_build_object('ok',true,'skipped',true,'reason','newer_customer_turn');
  end if;

  if exists(
    select 1 from public.v8_messages_raw bo
    where bo.customer_id=o.customer_id and bo.direction='outbound'
      and bo.sent_at>=m.sent_at
      and coalesce(bo.source_system,'') in ('aiguka','aiguka_v8')
  ) then
    update public.v8_response_obligations
    set obligation_status='resolved_sent',is_resolved=true,
        resolution_code='BOT_DELIVERED',resolved_at=now(),updated_at=now()
    where id=o.id;
    return jsonb_build_object('ok',true,'skipped',true,'reason','bot_already_delivered');
  end if;

  if exists(
    select 1 from public.v8_messages_raw ho
    where ho.customer_id=o.customer_id and ho.direction='outbound'
      and ho.sent_at>=m.sent_at
      and public.v8_is_confirmed_human_outbound(
        ho.source_system,ho.message_text,ho.attachments,ho.is_automatic,
        ho.actor_type,ho.source_detail,ho.actor_app_id
      )
  ) then
    update public.v8_response_obligations
    set obligation_status='resolved_human',is_resolved=true,
        resolution_code='HUMAN_REPLIED',resolved_at=now(),updated_at=now()
    where id=o.id;
    return jsonb_build_object('ok',true,'skipped',true,'reason','human_already_replied');
  end if;

  select * into pol from public.v8_resolve_runtime_policy(o.page_id) limit 1;
  if not coalesce(pol.can_send_text,false) then
    update public.v8_response_obligations
    set obligation_status='escalation_required',last_error='RUNTIME_CANNOT_SEND_TEXT',
        next_check_at=now()+interval '5 minutes',updated_at=now()
    where id=o.id;
    v_task_id:=public.v8_create_response_rescue_task(o.id,'RUNTIME_CANNOT_SEND_TEXT','urgent');
    return jsonb_build_object('ok',false,'reason','runtime_cannot_send_text','sale_task_id',v_task_id);
  end if;

  if public.v8_obligation_is_low_value(m.message_text,m.attachments) then
    update public.v8_response_obligations
    set obligation_status='resolved_low_value',is_resolved=true,
        resolution_code='LOW_VALUE_TURN',resolved_at=now(),updated_at=now()
    where id=o.id;
    return jsonb_build_object('ok',true,'skipped',true,'reason','low_value_turn');
  end if;

  select * into c from public.v8_customers where id=o.customer_id;
  select * into s from public.v8_conversation_states where customer_id=o.customer_id;
  v_norm:=public.v8_normalize_detector_text(coalesce(m.message_text,''));
  v_phone:=public.v8_extract_vietnam_phone(m.message_text);
  v_has_contact:=v_phone is not null or c.phone is not null or c.zalo is not null
    or coalesce(s.has_phone,false);

  select catalog_name into v_product_label
  from public.v8_product_catalog
  where catalog_key=coalesce(c.last_catalog_key,c.last_product_key)
    and is_active
  limit 1;
  v_product_label:=coalesce(nullif(v_product_label,''),'sản phẩm mình đang quan tâm');

  if v_norm ~ '(^| )(dung nhan|dung gui|khong gui nua|stop|unsubscribe|huy dang ky)( |$)' then
    update public.v8_response_obligations
    set obligation_status='resolved_opt_out',is_resolved=true,
        resolution_code='CUSTOMER_OPT_OUT',resolved_at=now(),updated_at=now()
    where id=o.id;
    return jsonb_build_object('ok',true,'skipped',true,'reason','customer_opt_out');
  elsif v_phone is not null or v_norm ~ '(so zalo|so dien thoai|sdt|zalo.*[0-9])' then
    v_intent:='provide_contact';
    v_reply:='Dạ, bên em đã nhận được SĐT/Zalo của mình. Nhân viên sẽ liên hệ tư vấn sớm ạ.';
    v_handoff:=true;
  elsif v_norm ~ '(dia chi|o dau|showroom|cua hang.*dau|sop.*dau|shop.*dau)' then
    v_intent:='ask_address';
    v_reply:='Dạ showroom bên em tại 254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội ạ.';
  elsif v_norm ~ '(gia|bao gia|bao nhieu|xin gia|mua|dat hang|cho xem|xem mau|gui mau|catalog|mau nao|hinh anh|anh that|tu van)' then
    v_intent:=case
      when v_norm ~ '(gia|bao gia|bao nhieu|xin gia)' then 'ask_price'
      when v_norm ~ '(cho xem|xem mau|gui mau|catalog|mau nao|hinh anh|anh that)' then 'ask_sample'
      else 'purchase_intent' end;
    if v_has_contact then
      v_reply:='Dạ, bên em đã nhận được nhu cầu về '||v_product_label
        ||'. Sản phẩm có nhiều mẫu và mức giá; nhân viên sẽ kiểm tra đúng mẫu rồi tư vấn qua thông tin mình đã gửi ạ.';
      v_handoff:=true;
    else
      v_reply:='Dạ, bên em đã nhận được nhu cầu về '||v_product_label
        ||'. Sản phẩm có nhiều mẫu và mức giá; mình cho em xin SĐT hoặc Zalo, nhân viên sẽ chọn đúng mẫu và báo giá cụ thể ạ.';
      v_request_contact:=true;
    end if;
  else
    v_reply:='Dạ, bên em đã nhận được tin nhắn. Mình đang quan tâm sản phẩm nào để bên em tư vấn đúng mẫu ạ.';
    v_intent:='other';
  end if;

  insert into public.v8_ai_decisions(
    page_id,sender_id,customer_id,message_id,source_message_row_id,
    runtime_mode,provider_key,model_name,status,customer_goal,intent_type,
    product_scope,catalog_key,confidence,should_reply,final_reply,
    should_send_slide,slide_asset_ids,should_request_contact,
    should_handoff_sale,needs_clarification,decision,evidence_summary,
    risk_flags,error,started_at,completed_at,created_at,updated_at,
    model_output,rule_advisories,decision_authority,prompt_version,
    model_calls,context_bytes
  ) values(
    o.page_id,o.sender_id,o.customer_id,o.message_id,m.id,
    coalesce(pol.runtime_mode,'PRODUCTION'),'system','deterministic-safe-fallback','completed',
    left(coalesce(m.message_text,'customer_message'),500),v_intent,
    coalesce(c.last_product_key,c.last_catalog_key),c.last_catalog_key,
    0.99,true,v_reply,false,'[]'::jsonb,v_request_contact,v_handoff,false,
    jsonb_build_object(
      'action_type',case when v_handoff then 'handoff_sale' else 'reply_text' end,
      'conversation_stage','rescue','final_reply',v_reply,
      'should_send_slide',false,'should_request_contact',v_request_contact,
      'should_handoff_sale',v_handoff,'fallback_reason',p_reason,
      'response_obligation_id',o.id
    ),
    jsonb_build_array(jsonb_build_object(
      'source_type','response_obligation','source_id',o.id::text,
      'claim','AI/delivery failure required deterministic safe fallback'
    )),
    jsonb_build_array('system_fallback_after_pipeline_failure'),null,
    v_now,v_now,v_now,v_now,null,'[]'::jsonb,'system_fallback',
    'system_fallback_v1',0,0
  )
  on conflict(page_id,message_id) do update set
    status='completed',
    customer_goal=excluded.customer_goal,
    intent_type=excluded.intent_type,
    product_scope=excluded.product_scope,
    catalog_key=excluded.catalog_key,
    confidence=excluded.confidence,
    should_reply=true,
    final_reply=excluded.final_reply,
    should_send_slide=false,
    slide_asset_ids='[]'::jsonb,
    should_request_contact=excluded.should_request_contact,
    should_handoff_sale=excluded.should_handoff_sale,
    needs_clarification=false,
    decision=excluded.decision,
    evidence_summary=excluded.evidence_summary,
    risk_flags=excluded.risk_flags,
    error=null,
    completed_at=excluded.completed_at,
    updated_at=excluded.updated_at,
    model_output=null,
    rule_advisories='[]'::jsonb,
    decision_authority='system_fallback',
    prompt_version='system_fallback_v1',
    model_calls=0
  returning id into v_decision_id;

  update public.v8_ai_brain_requests
  set status='completed',decision_id=v_decision_id,completed_at=now(),last_error=null,
      dispatch_locked_at=null,dispatch_locked_by=null,
      dispatch_details=coalesce(dispatch_details,'{}'::jsonb)
        || jsonb_build_object(
          'resolved_by','system_fallback','fallback_reason',p_reason,
          'response_obligation_id',o.id,'resolved_at',now()
        )
  where page_id=o.page_id and message_id=o.message_id;

  begin
    v_stage:=public.v8_ai_stage_decision(v_decision_id);
  exception when others then
    v_stage:=jsonb_build_object(
      'ok',false,'staged',false,'reason','stage_exception','error',left(sqlerrm,500)
    );
  end;

  update public.v8_response_obligations
  set ai_decision_id=v_decision_id,
      obligation_status=case
        when coalesce((v_stage->>'staged')::boolean,false) then 'outbound_pending'
        else 'escalation_required' end,
      rescue_attempts=rescue_attempts+1,
      last_error=case
        when coalesce((v_stage->>'staged')::boolean,false) then null
        else coalesce(v_stage->>'error',v_stage->>'reason','FALLBACK_STAGE_FAILED') end,
      resolution_details=coalesce(resolution_details,'{}'::jsonb)
        || jsonb_build_object(
          'fallback_reason',p_reason,'fallback_stage',v_stage,'fallback_at',now()
        ),
      next_check_at=case
        when coalesce((v_stage->>'staged')::boolean,false) then now()+interval '30 seconds'
        else now()+interval '5 minutes' end,
      updated_at=now()
  where id=o.id;

  insert into public.v8_ai_delivery_sla_events(
    page_id,sender_id,customer_id,message_id,entity_type,entity_id,
    stage,action,reason,latency_seconds,details
  ) values(
    o.page_id,o.sender_id,o.customer_id,o.message_id,
    'response_obligation',o.id,'fallback','safe_text_fallback',
    coalesce(p_reason,'AI_DELIVERY_FAILED'),
    extract(epoch from (now()-o.inbound_at)),
    jsonb_build_object('decision_id',v_decision_id,'stage_result',v_stage)
  )
  on conflict(entity_type,entity_id,action) do update set
    reason=excluded.reason,
    latency_seconds=excluded.latency_seconds,
    details=coalesce(public.v8_ai_delivery_sla_events.details,'{}'::jsonb)
      || excluded.details,
    created_at=now();

  if v_handoff or not coalesce((v_stage->>'staged')::boolean,false) then
    v_task_id:=public.v8_create_response_rescue_task(
      o.id,coalesce(p_reason,'AI_DELIVERY_FAILED'),
      case when v_handoff then 'high' else 'urgent' end
    );
  end if;

  return jsonb_build_object(
    'ok',true,'obligation_id',o.id,'decision_id',v_decision_id,
    'stage',v_stage,'sale_task_id',v_task_id,'fallback_reply',v_reply
  );
end;
$function$;
