-- AIGUKAPLUS quota optimization v3
-- Production-applied migration: ai_quota_zero_token_fast_paths_v3
-- Remove model calls only for deterministic intents while preserving AI for
-- image understanding, verified prices, product consultation and ambiguous turns.

insert into public.v8_config_hub(scope,key,value,description,is_active,updated_at)
values(
  'business',
  'showroom_contact_profile',
  jsonb_build_object(
    'address','254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội',
    'hotline','0973 693 677',
    'zalo','0989 882 690',
    'zalo_url','https://zalo.me/0989882690',
    'verified_at',now()
  ),
  'Thông tin showroom đã xác minh để xử lý các câu hỏi địa chỉ/liên hệ bằng rule 0 token.',
  true,
  now()
)
on conflict(scope,key) do update
set value=excluded.value,
    description=excluded.description,
    is_active=true,
    updated_at=now();

create or replace function public.v8_quota_fast_path_kind(p_text text)
returns text
language plpgsql
stable
set search_path='public'
as $function$
declare
  v_norm text:=public.v8_normalize_detector_text(coalesce(p_text,''));
  v_phone text:=public.v8_extract_vietnam_phone(p_text);
begin
  if v_phone is not null then
    return 'provide_contact';
  end if;

  if v_norm in (
    '', 'ok', 'oke', 'okay', 'cam on', 'thanks', 'thank you', 'vang', 'da',
    'uh', 'um', 'f', 'meta ai call me in messenger'
  ) then
    return 'no_value';
  end if;

  if v_norm in ('ib','inbox','bat dau','hello','hi','alo','chao shop','chao ban') then
    return 'simple_greeting';
  end if;

  if v_norm ~ '^(xin|cho|minh xin|cho minh xin|gui|cho xin)? ?(so dien thoai|sdt|so zalo|zalo)( cua hang| shop| ben em| ben ban)?( voi| nhe| a| ah)?$'
     or v_norm ~ '^(shop|cua hang|ben em|ben ban).*(so dien thoai|sdt|so zalo|zalo)'
     or v_norm ~ '(cho|minh xin).*(so dien thoai|sdt|so zalo|zalo).*(shop|cua hang|ben em|ben ban)'
  then
    return 'ask_store_contact';
  end if;

  if v_norm in ('dia chi','xin dia chi','xin dia chi shop','xin dia chi sop','cho minh xin dia chi','gui dinh vi','gui dinh vi nhe','xin dinh vi cua hang voi ah')
     or v_norm ~ '^(xin|cho|minh xin|cho minh xin).*(dia chi|dinh vi)( cua hang| shop| showroom)?'
     or v_norm ~ '^(dia chi|dinh vi)( cua hang| shop| showroom)?( o dau| nhe| a| ah)?$'
     or v_norm ~ '(cua hang|shop|showroom|co so|ben em|ben ban|nha minh|nha em).*(o dau|gan day|gan hon|gan tien hon)'
     or v_norm ~ '^o .*(co cua hang|co co so|co showroom)'
     or v_norm ~ 'toi dang hoi dia chi o dau'
  then
    return 'ask_address';
  end if;

  if v_norm ~ '(^| )(xin gia|bao gia|xin bao gia|gia bao nhieu|gia bao nhieu tien|bao nhieu tien|gia ca)( |$)'
     or v_norm ~ '^(gia|bao nhieu)($| shop| a| ah| vay| vay a| vay shop)'
  then
    return 'price_without_verified_data';
  end if;

  return null;
end;
$function$;

create or replace function public.v8_zero_token_common_intent_request()
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
  v_kind text;
  v_phone text;
  v_has_contact boolean:=false;
  v_has_recent_image boolean:=false;
  v_has_verified_price boolean:=false;
  v_ad_id text;
  v_salutation text:='Mình';
  v_reply text:='';
  v_should_reply boolean:=true;
  v_should_request_contact boolean:=false;
  v_should_handoff boolean:=false;
  v_intent text:='other';
  v_action text:='reply_text';
  v_product_scope text;
  v_decision_id uuid;
  v_decision jsonb;
  v_profile jsonb:='{}'::jsonb;
  v_address text:='254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội';
  v_hotline text:='0973 693 677';
  v_zalo text:='0989 882 690';
  v_now timestamptz:=now();
begin
  if new.status<>'pending' or coalesce(new.requested_by,'')='follow_up_scan' then
    return new;
  end if;

  select status,decision_id into v_request_status,v_existing_decision
  from public.v8_ai_brain_requests
  where id=new.id;

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

  select coalesce(value,'{}'::jsonb) into v_profile
  from public.v8_config_hub
  where scope='business' and key='showroom_contact_profile' and is_active
  order by updated_at desc limit 1;

  v_address:=coalesce(nullif(v_profile->>'address',''),v_address);
  v_hotline:=coalesce(nullif(v_profile->>'hotline',''),v_hotline);
  v_zalo:=coalesce(nullif(v_profile->>'zalo',''),v_zalo);
  v_phone:=public.v8_extract_vietnam_phone(v_message.message_text);
  v_salutation:=public.v8_contact_capture_salutation(v_customer.id);
  v_has_contact:=v_phone is not null
    or coalesce(v_customer.phone is not null or v_customer.zalo is not null,false)
    or coalesce((select has_phone from public.v8_conversation_states where customer_id=v_customer.id),false);

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

  v_ad_id:=coalesce(
    v_message.raw_payload#>>'{message,referral,ad_id}',
    v_message.raw_payload#>>'{referral,ad_id}',
    v_message.raw_payload#>>'{ad_id}',
    v_message.source_detail#>>'{ad_id}'
  );

  select exists(
    select 1
    from public.ad_mappings a
    where nullif(btrim(coalesce(a.price_range,'')),'') is not null
      and (
        (v_ad_id is not null and a.ad_id=v_ad_id)
        or (
          nullif(btrim(coalesce(v_customer.last_product_key,'')),'') is not null
          and public.v8_normalize_detector_text(v_customer.last_product_key) in (
            public.v8_normalize_detector_text(coalesce(a.product_item_key,'')),
            public.v8_normalize_detector_text(coalesce(a.product_group,'')),
            public.v8_normalize_detector_text(coalesce(a.product_name,'')),
            public.v8_normalize_detector_text(coalesce(a.slide_key,''))
          )
        )
      )
  ) into v_has_verified_price;

  v_kind:=public.v8_quota_fast_path_kind(v_message.message_text);

  if v_has_recent_image then return new; end if;
  if v_kind='price_without_verified_data' and v_has_verified_price then return new; end if;
  if v_kind is null then return new; end if;

  if v_kind='provide_contact' then
    v_intent:='provide_contact';
    v_action:='handoff_sale';
    v_should_handoff:=true;
    v_product_scope:=nullif(v_customer.last_product_key,'');
    v_reply:='Dạ, bên em đã nhận SĐT/Zalo của mình. Tư vấn viên sẽ liên hệ để tư vấn đúng mẫu và báo giá cụ thể ạ.';
  elsif v_kind='no_value' then
    v_intent:='acknowledgement';
    v_action:='no_reply';
    v_should_reply:=false;
    v_reply:='';
  elsif v_kind='simple_greeting' then
    v_intent:='greeting';
    v_reply:='Dạ, mình đang quan tâm nhóm nào: quạt trần, thiết bị phòng tắm, nhà bếp, gạch ốp lát hay đèn trang trí ạ?';
  elsif v_kind='ask_store_contact' then
    v_intent:='ask_product_info';
    v_reply:='Dạ, hotline showroom là '||v_hotline||', Zalo '||v_zalo||' ạ.';
  elsif v_kind='ask_address' then
    v_intent:='ask_address';
    v_reply:='Dạ, showroom tại '||v_address||'. Hotline '||v_hotline||', Zalo '||v_zalo||' ạ.';
  elsif v_kind='price_without_verified_data' then
    v_intent:='ask_price';
    v_product_scope:=nullif(v_customer.last_product_key,'');
    if v_has_contact then
      v_action:='handoff_sale';
      v_should_handoff:=true;
      v_reply:='Dạ, sản phẩm này có nhiều mức giá tùy mẫu và cấu hình. Bên em sẽ kiểm tra đúng mẫu rồi liên hệ báo giá cụ thể ạ.';
    else
      v_should_request_contact:=true;
      v_reply:='Dạ, sản phẩm này có nhiều mức giá tùy mẫu và cấu hình. '||coalesce(nullif(v_salutation,''),'Mình')||' cho em xin SĐT hoặc Zalo, bên em kiểm tra đúng mẫu và báo giá cụ thể ạ.';
    end if;
  end if;

  v_decision:=jsonb_build_object(
    'customer_goal',case v_kind
      when 'provide_contact' then 'Cung cấp thông tin liên hệ'
      when 'ask_address' then 'Hỏi địa chỉ showroom'
      when 'ask_store_contact' then 'Hỏi số liên hệ showroom'
      when 'price_without_verified_data' then 'Hỏi giá sản phẩm'
      when 'simple_greeting' then 'Bắt đầu hội thoại'
      else 'Xác nhận hội thoại' end,
    'intent_type',v_intent,
    'product_scope',v_product_scope,
    'catalog_keys','[]'::jsonb,
    'conversation_stage',case when v_should_handoff then 'handoff' else 'new' end,
    'action_type',v_action,
    'confidence',1.0,
    'should_reply',v_should_reply,
    'final_reply',v_reply,
    'needs_clarification',false,
    'clarification_question',null,
    'should_send_slide',false,
    'should_request_contact',v_should_request_contact,
    'should_handoff_sale',v_should_handoff,
    'evidence_summary',jsonb_build_array(jsonb_build_object(
      'source_type','deterministic_business_rule',
      'source_id',v_message.message_id,
      'claim','Fast path '||v_kind||' dùng dữ liệu đã xác minh, không cần gọi model.'
    )),
    'risk_flags','[]'::jsonb,
    'reason','Ý định có đáp án xác định từ dữ liệu hệ thống; xử lý 0 token để tiết kiệm quota.',
    'memory_update',jsonb_build_object(
      'active_goal',case when v_kind='price_without_verified_data' then 'Nhận báo giá sản phẩm' else null end,
      'summary','Fast path: '||v_kind,
      'product_scope',v_product_scope,
      'contact_status',case when v_has_contact then 'captured' when v_should_request_contact then 'requested' else 'unknown' end,
      'pending_actions',case when v_should_handoff then jsonb_build_array('Sale liên hệ khách') else '[]'::jsonb end
    ),
    'quota_fast_path',v_kind,
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
    'deterministic_rule','rule_zero_token_v2','completed',
    v_decision->>'customer_goal',v_intent,v_product_scope,v_product_scope,
    1.0,v_should_reply,v_reply,false,'[]'::jsonb,
    v_should_request_contact,v_should_handoff,false,v_decision,
    v_decision->'evidence_summary','[]'::jsonb,null,v_now,v_now,v_now,
    'ai_runtime_rule_fast_path','quota_fast_path_zero_token_v3',0,
    octet_length(coalesce(v_reply,'')),0,0,0,0,0,
    jsonb_build_object(
      'mode','deterministic_zero_token',
      'fast_path_kind',v_kind,
      'recent_image_guard',v_has_recent_image,
      'verified_price_guard',v_has_verified_price
    )
  )
  on conflict(page_id,message_id) do update set
    status='completed',customer_goal=excluded.customer_goal,
    intent_type=excluded.intent_type,product_scope=excluded.product_scope,
    catalog_key=excluded.catalog_key,confidence=excluded.confidence,
    should_reply=excluded.should_reply,final_reply=excluded.final_reply,
    should_send_slide=false,slide_asset_ids='[]'::jsonb,
    should_request_contact=excluded.should_request_contact,
    should_handoff_sale=excluded.should_handoff_sale,
    needs_clarification=false,decision=excluded.decision,
    evidence_summary=excluded.evidence_summary,risk_flags='[]'::jsonb,
    error=null,completed_at=excluded.completed_at,updated_at=excluded.updated_at,
    decision_authority=excluded.decision_authority,prompt_version=excluded.prompt_version,
    provider_key=excluded.provider_key,model_name=excluded.model_name,
    model_calls=0,context_bytes=excluded.context_bytes,
    input_tokens=0,output_tokens=0,total_tokens=0,
    cached_input_tokens=0,reasoning_tokens=0,usage_details=excluded.usage_details
  returning id into v_decision_id;

  update public.v8_ai_brain_requests
  set status='completed',decision_id=v_decision_id,completed_at=v_now,
      dispatch_locked_at=null,dispatch_locked_by=null,last_error=null,
      dispatch_details=coalesce(dispatch_details,'{}'::jsonb)||jsonb_build_object(
        'quota_saved',true,'zero_token_fast_path',v_kind,
        'prompt_version','quota_fast_path_zero_token_v3',
        'model_calls',0,'input_tokens',0,'output_tokens',0,'total_tokens',0,
        'recent_image_guard',v_has_recent_image,
        'verified_price_guard',v_has_verified_price,'completed_at',v_now
      )
  where id=new.id and decision_id is null;

  return new;
end;
$function$;

drop trigger if exists trg_v8_zz_zero_token_common_intent_request on public.v8_ai_brain_requests;
create trigger trg_v8_zz_zero_token_common_intent_request
after insert on public.v8_ai_brain_requests
for each row execute function public.v8_zero_token_common_intent_request();

insert into public.v8_config_hub(scope,key,value,description,is_active,updated_at)
values(
  'runtime','ai_quota_optimization',
  jsonb_build_object(
    'enabled',true,
    'version','zero_token_common_intents_v3',
    'baseline_version','evidence_first_single_call_v2',
    'additional_target_reduction_percent',50,
    'max_model_calls_per_turn',1,
    'max_history_messages',4,
    'follow_up_ai_enabled',false,
    'history_can_trigger_ai',false,
    'zero_token_fast_paths',jsonb_build_array(
      'provide_contact','no_value','simple_greeting','ask_store_contact',
      'ask_address','price_without_verified_data'
    ),
    'image_turns_keep_ai',true,
    'verified_price_turns_keep_ai',true,
    'measure_token_usage',true,
    'activated_at',now()
  ),
  'Giảm thêm tối thiểu 50% số lần gọi model bằng fast path 0 token; vẫn giữ AI cho ảnh, giá đã xác minh và tư vấn phức tạp.',
  true,now()
)
on conflict(scope,key) do update
set value=coalesce(public.v8_config_hub.value,'{}'::jsonb)||excluded.value,
    description=excluded.description,is_active=true,updated_at=now();

create or replace view public.v8_ai_quota_fast_path_daily as
select
  date_trunc('day',coalesce(completed_at,created_at)) as usage_day,
  coalesce(usage_details->>'fast_path_kind','model_or_other') as path_kind,
  count(*) as decisions,
  sum(coalesce(model_calls,0)) as model_calls,
  sum(coalesce(input_tokens,0)) as input_tokens,
  sum(coalesce(output_tokens,0)) as output_tokens,
  sum(coalesce(total_tokens,0)) as total_tokens
from public.v8_ai_decisions
group by 1,2;
