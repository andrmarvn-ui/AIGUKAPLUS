-- These tests create isolated synthetic customers, exercise the production
-- triggers, then delete every generated row before returning.

create or replace function public.v8_regression_test_zero_silent_drop()
returns jsonb
language plpgsql
security definer
set search_path to 'public','extensions'
as $function$
declare
  v_suffix text:=replace(gen_random_uuid()::text,'-','');
  v_sender text:='regression_obligation_'||v_suffix;
  v_message_id text:='regression:obligation:'||v_suffix;
  v_old_message_id text:='regression:old-history:'||v_suffix;
  v_customer_id uuid;
  v_message_row_id uuid;
  v_obligation_id uuid;
  v_decision_id uuid;
  v_fallback jsonb;
  v_outbound_status text;
  v_outbound_due timestamptz;
  v_authority text;
  v_old_obligation_exists boolean:=false;
  v_ok boolean:=false;
begin
  insert into public.v8_customers(
    page_id,page_name,sender_id,display_name,first_seen_at,last_seen_at,status,raw_profile
  ) values(
    '104810069068200','Regression Test',v_sender,
    'Regression Zero Silent Drop',now(),now(),'regression','{}'::jsonb
  ) returning id into v_customer_id;

  insert into public.v8_messages_raw(
    customer_id,page_id,sender_id,conversation_id,message_id,direction,
    actor_type,actor_name,source_system,is_automatic,message_text,
    attachments,raw_payload,sent_at
  ) values(
    v_customer_id,'104810069068200',v_sender,v_sender,v_message_id,
    'inbound','customer','Regression Customer','regression_test',false,
    'Xin giá bồn cầu và tư vấn giúp tôi','[]'::jsonb,
    jsonb_build_object('source','zero_silent_drop_regression'),now()
  ) returning id into v_message_row_id;

  select id into v_obligation_id
  from public.v8_response_obligations
  where page_id='104810069068200' and message_id=v_message_id;
  if v_obligation_id is null then
    raise exception 'REGRESSION_OBLIGATION_NOT_CREATED';
  end if;

  v_fallback:=public.v8_apply_safe_fallback_for_obligation(
    v_obligation_id,'REGRESSION_AI_FAILURE'
  );
  select id,decision_authority
  into v_decision_id,v_authority
  from public.v8_ai_decisions
  where page_id='104810069068200' and message_id=v_message_id;
  select status,due_at
  into v_outbound_status,v_outbound_due
  from public.v8_outbound_queue
  where ai_decision_id=v_decision_id and message_type='text'
  order by created_at desc limit 1;

  insert into public.v8_messages_raw(
    customer_id,page_id,sender_id,conversation_id,message_id,direction,
    actor_type,actor_name,source_system,is_automatic,message_text,
    attachments,raw_payload,sent_at
  ) values(
    v_customer_id,'104810069068200',v_sender,v_sender,v_old_message_id,
    'inbound','customer','Regression Customer','regression_test',false,
    'Tin lịch sử quá cũ không được mở lại nghĩa vụ','[]'::jsonb,
    jsonb_build_object('source','zero_silent_drop_regression_old'),
    now()-interval '60 days'
  );

  select exists(
    select 1 from public.v8_response_obligations
    where page_id='104810069068200'
      and message_id=v_old_message_id
      and not is_resolved
  ) into v_old_obligation_exists;

  v_ok:=coalesce((v_fallback->>'ok')::boolean,false)
    and v_decision_id is not null
    and v_authority='system_fallback'
    and v_outbound_status in ('ready','planned')
    and not v_old_obligation_exists;

  delete from public.v8_outbound_queue
    where ai_decision_id=v_decision_id or customer_id=v_customer_id;
  delete from public.v8_slide_logs
    where ai_decision_id=v_decision_id or customer_id=v_customer_id;
  delete from public.v8_reply_plans
    where ai_decision_id=v_decision_id or customer_id=v_customer_id;
  delete from public.v8_ai_revision_requests where decision_id=v_decision_id;
  delete from public.v8_ai_delivery_sla_events
    where entity_type='response_obligation' and entity_id=v_obligation_id;
  delete from public.v8_ai_decisions where customer_id=v_customer_id;
  delete from public.v8_ai_brain_requests
    where page_id='104810069068200' and sender_id=v_sender;
  delete from public.v8_sale_tasks where customer_id=v_customer_id;
  delete from public.v8_response_obligations
    where page_id='104810069068200' and sender_id=v_sender;
  delete from public.v8_messages_raw
    where page_id='104810069068200' and sender_id=v_sender;
  delete from public.v8_customers where id=v_customer_id;

  return jsonb_build_object(
    'ok',v_ok,'fallback',v_fallback,'decision_authority',v_authority,
    'outbound_status',v_outbound_status,'outbound_due',v_outbound_due,
    'old_history_created_unresolved_obligation',v_old_obligation_exists
  );
exception when others then
  begin
    delete from public.v8_outbound_queue where customer_id=v_customer_id;
    delete from public.v8_slide_logs where customer_id=v_customer_id;
    delete from public.v8_reply_plans where customer_id=v_customer_id;
    delete from public.v8_ai_decisions where customer_id=v_customer_id;
    delete from public.v8_ai_brain_requests
      where page_id='104810069068200' and sender_id=v_sender;
    delete from public.v8_sale_tasks where customer_id=v_customer_id;
    delete from public.v8_response_obligations
      where page_id='104810069068200' and sender_id=v_sender;
    delete from public.v8_messages_raw
      where page_id='104810069068200' and sender_id=v_sender;
    delete from public.v8_customers where id=v_customer_id;
  exception when others then null;
  end;
  return jsonb_build_object('ok',false,'error',left(sqlerrm,500));
end;
$function$;

create or replace function public.v8_regression_test_slide_failure_text_fallback()
returns jsonb
language plpgsql
security definer
set search_path to 'public','extensions'
as $function$
declare
  v_suffix text:=replace(gen_random_uuid()::text,'-','');
  v_sender text:='regression_slide_'||v_suffix;
  v_message_id text:='regression:slide:'||v_suffix;
  v_customer_id uuid;
  v_message_row_id uuid;
  v_decision_id uuid;
  v_asset_id uuid;
  v_carousel_id uuid;
  v_text_id uuid;
  v_text_status text;
  v_text_due timestamptz;
  v_text_payload jsonb;
  v_should_slide boolean;
  v_asset_count integer;
  v_authority text;
  v_ok boolean:=false;
begin
  select id into v_asset_id
  from public.v8_drive_assets
  where is_active and is_image and delivery_status='verified'
    and catalog_key='bon_cau_thong_minh'
  order by sort_order,file_name limit 1;
  if v_asset_id is null then
    raise exception 'REGRESSION_VERIFIED_ASSET_MISSING';
  end if;

  insert into public.v8_customers(
    page_id,page_name,sender_id,display_name,first_seen_at,last_seen_at,
    status,raw_profile,last_catalog_key,last_product_key
  ) values(
    '104810069068200','Regression Test',v_sender,
    'Regression Slide Failure',now(),now(),'regression','{}'::jsonb,
    'bon_cau_thong_minh','bon_cau'
  ) returning id into v_customer_id;

  insert into public.v8_messages_raw(
    customer_id,page_id,sender_id,conversation_id,message_id,direction,
    actor_type,actor_name,source_system,is_automatic,message_text,
    attachments,raw_payload,sent_at
  ) values(
    v_customer_id,'104810069068200',v_sender,v_sender,v_message_id,
    'inbound','customer','Regression Customer','regression_test',false,
    'Cho tôi xem mẫu bồn cầu thông minh','[]'::jsonb,
    jsonb_build_object('source','zero_silent_drop_slide_regression'),now()
  ) returning id into v_message_row_id;

  insert into public.v8_ai_decisions(
    page_id,sender_id,customer_id,message_id,source_message_row_id,
    runtime_mode,provider_key,model_name,status,confidence,should_reply,
    final_reply,should_send_slide,slide_asset_ids,should_request_contact,
    should_handoff_sale,needs_clarification,decision,evidence_summary,
    risk_flags,decision_authority,prompt_version,model_calls,created_at,updated_at
  ) values(
    '104810069068200',v_sender,v_customer_id,v_message_id,v_message_row_id,
    'PRODUCTION','openai','regression-model','processing',0.99,false,'',
    false,'[]'::jsonb,false,false,false,'{}'::jsonb,'[]'::jsonb,
    '[]'::jsonb,'ai_runtime','evidence_first_single_call_v2',1,now(),now()
  ) returning id into v_decision_id;

  update public.v8_ai_decisions
  set status='completed',
      customer_goal='xem mẫu bồn cầu',
      intent_type='ask_sample',
      product_scope='bon_cau_thong_minh',
      catalog_key='bon_cau_thong_minh',
      confidence=0.99,
      should_reply=true,
      final_reply='Dạ, em gửi mình các mẫu bồn cầu thông minh để tham khảo ạ.',
      should_send_slide=true,
      slide_asset_ids=jsonb_build_array(v_asset_id::text,v_asset_id::text),
      decision=jsonb_build_object(
        'action_type','reply_with_slides',
        'conversation_stage','exploring',
        'final_reply','Dạ, em gửi mình các mẫu bồn cầu thông minh để tham khảo ạ.',
        'should_send_slide',true,
        'slide_asset_ids',jsonb_build_array(v_asset_id::text,v_asset_id::text),
        'catalog_keys',jsonb_build_array('bon_cau_thong_minh')
      ),
      completed_at=now(),updated_at=now(),model_output=null
  where id=v_decision_id;

  select jsonb_array_length(slide_asset_ids),decision_authority
  into v_asset_count,v_authority
  from public.v8_ai_decisions
  where id=v_decision_id;

  select id into v_carousel_id
  from public.v8_outbound_queue
  where ai_decision_id=v_decision_id and message_type='carousel'
  order by created_at desc limit 1;
  select id into v_text_id
  from public.v8_outbound_queue
  where ai_decision_id=v_decision_id and message_type='text'
  order by created_at desc limit 1;
  if v_carousel_id is null or v_text_id is null then
    raise exception 'REGRESSION_SLIDE_OUTBOUND_NOT_STAGED';
  end if;

  update public.v8_outbound_queue
  set status='failed',last_error='REGRESSION_FORCED_CAROUSEL_FAILURE',updated_at=now()
  where id=v_carousel_id;

  select should_send_slide,decision_authority
  into v_should_slide,v_authority
  from public.v8_ai_decisions
  where id=v_decision_id;
  select status,due_at,payload
  into v_text_status,v_text_due,v_text_payload
  from public.v8_outbound_queue
  where id=v_text_id;

  v_ok:=v_asset_count=1
    and not coalesce(v_should_slide,true)
    and v_authority='system_fallback'
    and v_text_status='ready'
    and coalesce(v_text_payload->>'text','')
      like 'Dạ, phần hình ảnh vừa tải chưa thành công%';

  delete from public.v8_outbound_queue
    where ai_decision_id=v_decision_id or customer_id=v_customer_id;
  delete from public.v8_slide_logs
    where ai_decision_id=v_decision_id or customer_id=v_customer_id;
  delete from public.v8_reply_plans
    where ai_decision_id=v_decision_id or customer_id=v_customer_id;
  delete from public.v8_ai_revision_requests where decision_id=v_decision_id;
  delete from public.v8_ai_delivery_sla_events
    where entity_id in (
      v_decision_id,
      (select id from public.v8_response_obligations where message_id=v_message_id)
    );
  delete from public.v8_ai_decisions where id=v_decision_id;
  delete from public.v8_ai_brain_requests
    where page_id='104810069068200' and sender_id=v_sender;
  delete from public.v8_sale_tasks where customer_id=v_customer_id;
  delete from public.v8_response_obligations
    where page_id='104810069068200' and sender_id=v_sender;
  delete from public.v8_messages_raw
    where page_id='104810069068200' and sender_id=v_sender;
  delete from public.v8_customers where id=v_customer_id;

  return jsonb_build_object(
    'ok',v_ok,
    'deduped_asset_count',v_asset_count,
    'decision_should_send_slide',v_should_slide,
    'decision_authority',v_authority,
    'text_status',v_text_status,
    'text_due',v_text_due,
    'text',v_text_payload->>'text'
  );
exception when others then
  begin
    delete from public.v8_outbound_queue where customer_id=v_customer_id;
    delete from public.v8_slide_logs where customer_id=v_customer_id;
    delete from public.v8_reply_plans where customer_id=v_customer_id;
    delete from public.v8_ai_revision_requests where decision_id=v_decision_id;
    delete from public.v8_ai_decisions where customer_id=v_customer_id;
    delete from public.v8_ai_brain_requests
      where page_id='104810069068200' and sender_id=v_sender;
    delete from public.v8_sale_tasks where customer_id=v_customer_id;
    delete from public.v8_response_obligations
      where page_id='104810069068200' and sender_id=v_sender;
    delete from public.v8_messages_raw
      where page_id='104810069068200' and sender_id=v_sender;
    delete from public.v8_customers where id=v_customer_id;
  exception when others then null;
  end;
  return jsonb_build_object('ok',false,'error',left(sqlerrm,500));
end;
$function$;
