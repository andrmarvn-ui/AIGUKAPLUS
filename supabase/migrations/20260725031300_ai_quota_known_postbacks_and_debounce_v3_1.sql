-- AIGUKAPLUS quota optimization v3.1
-- Production-applied migration: ai_quota_known_postbacks_and_debounce_v3_1
-- Exact approved Meta CTA postbacks are deterministic and do not need a model call.
-- Increase rapid-turn debounce from 15s to 20s so consecutive customer messages
-- are combined before AI processing, while preserving the live-response SLA.

create or replace function public.v8_zero_token_known_product_postback_request()
returns trigger
language plpgsql
security definer
set search_path='public'
as $function$
declare
  v_request_status text;
  v_existing_decision uuid;
  v_message public.v8_messages_raw%rowtype;
  v_customer public.v8_customers%rowtype;
  v_runtime_mode text:='ACTIVE';
  v_norm text;
  v_has_recent_image boolean:=false;
  v_has_contact boolean:=false;
  v_salutation text:='Mình';
  v_reply text;
  v_goal text;
  v_scope text;
  v_should_request_contact boolean:=false;
  v_should_handoff boolean:=false;
  v_action text:='reply_text';
  v_decision jsonb;
  v_decision_id uuid;
  v_now timestamptz:=now();
begin
  if new.status<>'pending' or coalesce(new.requested_by,'')='follow_up_scan' then
    return new;
  end if;

  select status,decision_id into v_request_status,v_existing_decision
  from public.v8_ai_brain_requests
  where id=new.id;

  -- Earlier deterministic triggers have priority. Only handle a request that is
  -- still pending and has no decision.
  if coalesce(v_request_status,new.status)<>'pending' or v_existing_decision is not null then
    return new;
  end if;

  select * into v_message
  from public.v8_messages_raw
  where page_id=new.page_id and message_id=new.message_id
  order by created_at desc
  limit 1;

  if v_message.id is null
     or v_message.direction<>'inbound'
     or coalesce(v_message.actor_type,'customer')<>'customer' then
    return new;
  end if;

  v_norm:=public.v8_normalize_detector_text(coalesce(v_message.message_text,''));
  if v_norm not in ('tu van noi that nha moi','tu van gach op lat') then
    return new;
  end if;

  -- Never replace visual understanding with a static rule.
  select exists(
    select 1
    from public.v8_messages_raw mi
    where mi.page_id=v_message.page_id
      and mi.sender_id=v_message.sender_id
      and mi.direction='inbound'
      and coalesce(mi.actor_type,'customer')='customer'
      and mi.sent_at between v_message.sent_at-interval '60 seconds' and v_message.sent_at
      and jsonb_array_length(coalesce(mi.attachments,'[]'::jsonb))>0
  ) into v_has_recent_image;
  if v_has_recent_image then return new; end if;

  select * into v_customer
  from public.v8_customers
  where id=v_message.customer_id
     or (page_id=new.page_id and sender_id=new.sender_id)
  order by case when id=v_message.customer_id then 0 else 1 end
  limit 1;

  select coalesce(mode,'ACTIVE') into v_runtime_mode
  from public.v8_ai_brain_runtime
  where page_id=new.page_id;
  v_runtime_mode:=coalesce(v_runtime_mode,'ACTIVE');
  if v_runtime_mode='OFF' then return new; end if;

  v_salutation:=public.v8_contact_capture_salutation(v_customer.id);
  v_has_contact:=coalesce(v_customer.phone is not null or v_customer.zalo is not null,false)
    or coalesce((select has_phone from public.v8_conversation_states where customer_id=v_customer.id),false);
  v_should_request_contact:=not v_has_contact;
  v_should_handoff:=v_has_contact;
  v_action:=case when v_has_contact then 'handoff_sale' else 'reply_text' end;

  if v_norm='tu van noi that nha moi' then
    v_goal:='Tư vấn nội thất nhà mới';
    v_scope:='noi_that_nha_moi';
    if v_has_contact then
      v_reply:='Dạ, bên em có gạch ốp lát, thiết bị phòng tắm, nhà bếp, quạt trần và đèn trang trí cho nhà mới. Bên em sẽ liên hệ để tư vấn đồng bộ và gửi mẫu phù hợp ạ.';
    else
      v_reply:='Dạ, bên em có gạch ốp lát, thiết bị phòng tắm, nhà bếp, quạt trần và đèn trang trí cho nhà mới. '||coalesce(nullif(v_salutation,''),'Mình')||' cho em xin SĐT hoặc Zalo và hạng mục đang làm, bên em tư vấn đồng bộ và gửi mẫu phù hợp ạ.';
    end if;
  else
    v_goal:='Tư vấn gạch ốp lát';
    v_scope:='gach_op_lat';
    if v_has_contact then
      v_reply:='Dạ, gạch ốp lát có nhiều kích thước, màu và phân khúc. Bên em sẽ liên hệ để gửi mẫu và báo giá phù hợp ạ.';
    else
      v_reply:='Dạ, gạch ốp lát có nhiều kích thước, màu và phân khúc. '||coalesce(nullif(v_salutation,''),'Mình')||' cho em xin SĐT hoặc Zalo cùng diện tích hoặc kích thước cần dùng, bên em gửi mẫu và báo giá phù hợp ạ.';
    end if;
  end if;

  v_decision:=jsonb_build_object(
    'customer_goal',v_goal,
    'intent_type','ask_product_info',
    'product_scope',v_scope,
    'catalog_keys','[]'::jsonb,
    'conversation_stage',case when v_has_contact then 'handoff' else 'evaluating' end,
    'action_type',v_action,
    'confidence',1.0,
    'should_reply',true,
    'final_reply',v_reply,
    'needs_clarification',false,
    'clarification_question',null,
    'should_send_slide',false,
    'should_request_contact',v_should_request_contact,
    'should_handoff_sale',v_should_handoff,
    'evidence_summary',jsonb_build_array(jsonb_build_object(
      'source_type','fixed_meta_postback_mapping',
      'source_id',v_message.message_id,
      'claim','CTA Meta đã được xác định chính xác: '||v_norm
    )),
    'risk_flags','[]'::jsonb,
    'reason','CTA cố định đã được mapping; dùng phản hồi đã duyệt và không gọi model.',
    'memory_update',jsonb_build_object(
      'active_goal',v_goal,
      'summary',v_goal,
      'product_scope',v_scope,
      'contact_status',case when v_has_contact then 'captured' else 'requested' end,
      'pending_actions',case when v_has_contact then jsonb_build_array('Sale liên hệ khách') else jsonb_build_array('Chờ khách cung cấp SĐT/Zalo') end
    ),
    'quota_fast_path','known_product_postback',
    'slide_selection_mode','system_from_catalog_mapping'
  );

  insert into public.v8_ai_decisions(
    page_id,sender_id,customer_id,message_id,source_message_row_id,runtime_mode,
    provider_key,model_name,status,customer_goal,intent_type,product_scope,catalog_key,
    confidence,should_reply,final_reply,should_send_slide,slide_asset_ids,
    should_request_contact,should_handoff_sale,needs_clarification,decision,
    evidence_summary,risk_flags,error,started_at,completed_at,updated_at,
    decision_authority,prompt_version,model_calls,context_bytes,input_tokens,
    output_tokens,total_tokens,cached_input_tokens,reasoning_tokens,usage_details
  ) values (
    new.page_id,new.sender_id,v_customer.id,new.message_id,v_message.id,v_runtime_mode,
    'deterministic_rule','rule_zero_token_v2','completed',v_goal,
    'ask_product_info',v_scope,null,1.0,true,v_reply,false,'[]'::jsonb,
    v_should_request_contact,v_should_handoff,false,v_decision,
    v_decision->'evidence_summary','[]'::jsonb,null,v_now,v_now,v_now,
    'ai_runtime_rule_fast_path','quota_known_postback_zero_token_v3_1',0,
    octet_length(coalesce(v_reply,'')),0,0,0,0,0,
    jsonb_build_object(
      'mode','deterministic_zero_token',
      'fast_path_kind','known_product_postback',
      'normalized_postback',v_norm,
      'recent_image_guard',v_has_recent_image
    )
  )
  on conflict(page_id,message_id) do update set
    status='completed',customer_goal=excluded.customer_goal,
    intent_type=excluded.intent_type,product_scope=excluded.product_scope,
    catalog_key=null,confidence=1.0,should_reply=true,
    final_reply=excluded.final_reply,should_send_slide=false,
    slide_asset_ids='[]'::jsonb,
    should_request_contact=excluded.should_request_contact,
    should_handoff_sale=excluded.should_handoff_sale,
    needs_clarification=false,decision=excluded.decision,
    evidence_summary=excluded.evidence_summary,risk_flags='[]'::jsonb,
    error=null,completed_at=excluded.completed_at,updated_at=excluded.updated_at,
    decision_authority=excluded.decision_authority,
    prompt_version=excluded.prompt_version,provider_key=excluded.provider_key,
    model_name=excluded.model_name,model_calls=0,
    context_bytes=excluded.context_bytes,input_tokens=0,output_tokens=0,total_tokens=0,
    cached_input_tokens=0,reasoning_tokens=0,usage_details=excluded.usage_details
  returning id into v_decision_id;

  update public.v8_ai_brain_requests
  set status='completed',decision_id=v_decision_id,completed_at=v_now,
      dispatch_locked_at=null,dispatch_locked_by=null,last_error=null,
      dispatch_details=coalesce(dispatch_details,'{}'::jsonb)||jsonb_build_object(
        'quota_saved',true,
        'zero_token_fast_path','known_product_postback',
        'normalized_postback',v_norm,
        'prompt_version','quota_known_postback_zero_token_v3_1',
        'model_calls',0,'input_tokens',0,'output_tokens',0,'total_tokens',0,
        'completed_at',v_now
      )
  where id=new.id and decision_id is null;

  return new;
end;
$function$;

drop trigger if exists trg_v8_zzz_zero_token_known_product_postback_request on public.v8_ai_brain_requests;
create trigger trg_v8_zzz_zero_token_known_product_postback_request
after insert on public.v8_ai_brain_requests
for each row execute function public.v8_zero_token_known_product_postback_request();

update public.v8_config_hub
set value=coalesce(value,'{}'::jsonb)||jsonb_build_object(
      'rapid_turn_debounce_seconds',20,
      'quota_guard_version','quota_guard_v3_1_20260725',
      'quota_debounce_reason','combine_consecutive_customer_messages_before_model_call'
    ),
    updated_at=now()
where scope='conversation' and key='follow_up_policy';

update public.v8_config_hub
set value=coalesce(value,'{}'::jsonb)||jsonb_build_object(
      'version','zero_token_common_intents_v3_1',
      'additional_target_reduction_percent',50,
      'rapid_turn_debounce_seconds',20,
      'known_zero_token_postbacks',jsonb_build_array(
        'tu van noi that nha moi','tu van gach op lat'
      ),
      'activated_at',now()
    ),
    description='Giảm thêm trên 50% lượt gọi model bằng fast path 0 token và gộp lượt khách trong 20 giây; giữ AI cho ảnh, giá xác minh và tư vấn phức tạp.',
    updated_at=now()
where scope='runtime' and key='ai_quota_optimization';
