create or replace function public.v8_sales_product_profile(p_text text,p_customer_id uuid default null)
returns jsonb
language plpgsql
stable
set search_path='public'
as $function$
declare
  v_norm text:=public.v8_normalize_detector_text(coalesce(p_text,''));
  v_last text;
  v_scope text;
  v_label text;
  v_items text;
  v_broad boolean:=false;
begin
  if p_customer_id is not null then
    select coalesce(last_product_key,last_catalog_key) into v_last
    from public.v8_customers where id=p_customer_id;
  end if;
  v_norm:=btrim(v_norm||' '||public.v8_normalize_detector_text(coalesce(v_last,'')));
  v_broad:=v_norm ~ '(muon xem het|xem het|xem tat ca|tat ca mau|toan bo mau|xem toan bo|xem tong the)';

  if v_broad then
    v_scope:='multi_product';
    v_label:='toàn bộ hạng mục nội thất';
    v_items:='thiết bị nhà tắm, nhà bếp, quạt trần, đèn trang trí và gạch ốp lát';
  elsif v_norm ~ '(nha tam|thiet bi ve sinh|bon cau|lavabo|sen tam|voi lavabo|guong tu|phu kien nha tam)' then
    v_scope:='combo_phong_tam';
    v_label:='thiết bị nhà tắm';
    v_items:='bồn cầu, lavabo, sen vòi, gương tủ và phụ kiện';
  elsif v_norm ~ '(nha bep|bep tu|hut mui|chau rua|voi rua|phu kien bep)' then
    v_scope:='bep_tu_hut_mui';
    v_label:='thiết bị nhà bếp';
    v_items:='bếp từ, máy hút mùi, chậu vòi rửa và phụ kiện bếp';
  elsif v_norm ~ '(quat tran|quat den|quat)' then
    v_scope:='quat_tran';
    v_label:='quạt trần';
    v_items:='quạt trần 5–6 cánh, 8 cánh và 10 cánh';
  elsif v_norm ~ '(den chum|den trang tri|den)' then
    v_scope:='den_trum';
    v_label:='đèn trang trí';
    v_items:='đèn chùm, đèn thả và các mẫu trang trí';
  elsif v_norm ~ '(gach op|gach lat|gach ngoi|gach)' then
    v_scope:='gach_ngoi';
    v_label:='gạch ốp lát';
    v_items:='gạch lát nền, gạch ốp tường và gạch trang trí';
  end if;

  return jsonb_build_object('scope',v_scope,'label',v_label,'items',v_items,'broad',v_broad);
end;
$function$;

create or replace function public.v8_obligation_is_low_value(p_text text,p_attachments jsonb default '[]'::jsonb)
returns boolean
language plpgsql
stable
set search_path='public'
as $function$
declare
  v_text text:=btrim(coalesce(p_text,''));
  v_norm text:=public.v8_normalize_detector_text(coalesce(p_text,''));
begin
  if coalesce(jsonb_array_length(coalesce(p_attachments,'[]'::jsonb)),0)>0 then return false; end if;
  if v_text='' then return true; end if;
  if v_norm in ('ok','oke','okay','cam on','thanks','thank you','vang','da','uh','um') then return true; end if;
  if v_norm ~ '^ban co the goi cho .+ trong [0-9]+ ngay toi$' then return true; end if;
  if regexp_replace(v_text,'\s','','g') ~ '^[.!?,…❤❤️👍]+$' then return true; end if;
  return false;
end;
$function$;

create or replace function public.v8_zero_token_sales_intent_request()
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
  v_kind text;
  v_profile jsonb:='{}'::jsonb;
  v_product jsonb:='{}'::jsonb;
  v_scope text;
  v_label text;
  v_items text;
  v_broad boolean:=false;
  v_has_contact boolean:=false;
  v_has_recent_image boolean:=false;
  v_salutation text:='Mình';
  v_address text;
  v_reply text;
  v_intent text;
  v_should_request boolean:=false;
  v_should_handoff boolean:=false;
  v_action text:='reply_text';
  v_decision jsonb;
  v_decision_id uuid;
  v_now timestamptz:=now();
begin
  if new.status<>'pending' or coalesce(new.requested_by,'')='follow_up_scan' then return new; end if;

  select status,decision_id into v_request_status,v_existing_decision
  from public.v8_ai_brain_requests where id=new.id;
  if coalesce(v_request_status,new.status)<>'pending' or v_existing_decision is not null then return new; end if;

  select * into v_message
  from public.v8_messages_raw
  where page_id=new.page_id and message_id=new.message_id
  order by created_at desc limit 1;
  if v_message.id is null or v_message.direction<>'inbound'
     or coalesce(v_message.actor_type,'customer')<>'customer' then return new; end if;

  v_norm:=public.v8_normalize_detector_text(coalesce(v_message.message_text,''));
  if v_norm ~ '^ban co the goi cho .+ trong [0-9]+ ngay toi$' then
    update public.v8_ai_brain_requests
    set status='skipped',completed_at=v_now,last_error='meta_system_call_permission_notice',
        dispatch_details=coalesce(dispatch_details,'{}'::jsonb)||jsonb_build_object(
          'quota_saved',true,'classified_as','meta_system_notice','completed_at',v_now
        )
    where id=new.id and decision_id is null;
    return new;
  end if;

  select exists(
    select 1 from public.v8_messages_raw mi
    where mi.page_id=v_message.page_id and mi.sender_id=v_message.sender_id
      and mi.direction='inbound' and coalesce(mi.actor_type,'customer')='customer'
      and mi.sent_at between v_message.sent_at-interval '60 seconds' and v_message.sent_at
      and jsonb_array_length(coalesce(mi.attachments,'[]'::jsonb))>0
  ) into v_has_recent_image;
  if v_has_recent_image then return new; end if;

  v_kind:=public.v8_quota_fast_path_kind(v_message.message_text);
  v_product:=public.v8_sales_product_profile(v_message.message_text,v_message.customer_id);
  v_scope:=nullif(v_product->>'scope','');
  v_label:=nullif(v_product->>'label','');
  v_items:=nullif(v_product->>'items','');
  v_broad:=coalesce((v_product->>'broad')::boolean,false);
  if v_kind<>'ask_address' and not v_broad then return new; end if;

  select * into v_customer
  from public.v8_customers
  where id=v_message.customer_id or (page_id=new.page_id and sender_id=new.sender_id)
  order by case when id=v_message.customer_id then 0 else 1 end limit 1;

  select coalesce(mode,'ACTIVE') into v_runtime_mode
  from public.v8_ai_brain_runtime where page_id=new.page_id;
  v_runtime_mode:=coalesce(v_runtime_mode,'ACTIVE');
  if v_runtime_mode='OFF' then return new; end if;

  select coalesce(value,'{}'::jsonb) into v_profile
  from public.v8_config_hub
  where scope='business' and key='showroom_contact_profile' and is_active
  order by updated_at desc limit 1;
  v_address:=coalesce(nullif(v_profile->>'address',''),'254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội');
  v_salutation:=public.v8_contact_capture_salutation(v_customer.id);
  v_has_contact:=coalesce(v_customer.phone is not null or v_customer.zalo is not null,false)
    or coalesce((select has_phone from public.v8_conversation_states where customer_id=v_customer.id),false);
  v_should_request:=not v_has_contact;
  v_should_handoff:=v_has_contact;
  v_action:=case when v_has_contact then 'handoff_sale' else 'reply_text' end;

  if v_broad then
    v_intent:='ask_product_info';
    v_scope:='multi_product';
    v_reply:='Dạ, bên em là Tổng kho Ánh Dương, có đủ '||coalesce(v_items,'thiết bị nhà tắm, nhà bếp, quạt trần, đèn trang trí và gạch ốp lát')||'. '||
      case when v_has_contact
        then 'Bên em sẽ liên hệ để tư vấn tổng thể và gửi catalog theo từng nhóm cho mình ạ.'
        else coalesce(nullif(v_salutation,''),'Mình')||' cho em xin SĐT hoặc Zalo, bên em gửi catalog theo từng nhóm và tư vấn đồng bộ cho mình tiện xem ạ.' end;
  else
    v_intent:='ask_address';
    v_reply:='Dạ, bên em là Tổng kho Ánh Dương, showroom tại '||v_address||'. '||
      case when v_label is not null
        then 'Riêng '||v_label||' bên em có nhiều mẫu '||coalesce(v_items,'trưng bày')||'. '
        else 'Bên em có nhiều mẫu thiết bị nhà tắm, nhà bếp, quạt trần, đèn trang trí và gạch ốp lát. ' end||
      case when v_has_contact
        then 'Mình dự định qua cơ sở nào, bên em nhờ nhân viên chuẩn bị sẵn mẫu để mình xem nhanh ạ.'
        else 'Mình dự định qua cơ sở nào và cho em xin SĐT hoặc Zalo, bên em gửi mẫu trước rồi nhờ nhân viên chuẩn bị sẵn để mình xem nhanh ạ.' end;
  end if;

  v_decision:=jsonb_build_object(
    'customer_goal',case when v_broad then 'Xem toàn bộ hạng mục sản phẩm' else 'Xin địa chỉ và xem sản phẩm tại showroom' end,
    'intent_type',v_intent,'product_scope',v_scope,'catalog_keys','[]'::jsonb,
    'conversation_stage',case when v_has_contact then 'handoff' else 'evaluating' end,
    'action_type',v_action,'confidence',1.0,'should_reply',true,'final_reply',v_reply,
    'needs_clarification',false,'clarification_question',null,'should_send_slide',false,
    'should_request_contact',v_should_request,'should_handoff_sale',v_should_handoff,
    'evidence_summary',jsonb_build_array(jsonb_build_object(
      'source_type','deterministic_composite_intent','source_id',v_message.message_id,
      'claim',case when v_broad then 'Khách muốn xem toàn bộ danh mục' else 'Khách hỏi địa chỉ, có thể kèm nhu cầu sản phẩm' end
    )),
    'risk_flags','[]'::jsonb,'reason','Giữ đủ ý định địa chỉ, sản phẩm và mục tiêu xin liên hệ; xử lý 0 token.',
    'memory_update',jsonb_build_object(
      'active_goal',case when v_broad then 'Xem toàn bộ danh mục' else 'Đến showroom xem hàng' end,
      'summary',left(coalesce(v_message.message_text,''),500),'product_scope',v_scope,
      'contact_status',case when v_has_contact then 'captured' else 'requested' end,
      'pending_actions',case when v_has_contact then jsonb_build_array('Sale chuẩn bị mẫu và liên hệ khách') else jsonb_build_array('Chờ khách cung cấp SĐT/Zalo và chọn cơ sở') end
    ),
    'quota_fast_path',case when v_broad then 'broad_catalog_interest' else 'address_with_sales_context' end
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
    'deterministic_rule','rule_zero_token_v4','completed',v_decision->>'customer_goal',
    v_intent,v_scope,v_scope,1.0,true,v_reply,false,'[]'::jsonb,
    v_should_request,v_should_handoff,false,v_decision,v_decision->'evidence_summary','[]'::jsonb,
    null,v_now,v_now,v_now,'ai_runtime_rule_fast_path','sales_intent_zero_token_v4',0,
    octet_length(coalesce(v_reply,'')),0,0,0,0,0,
    jsonb_build_object('mode','deterministic_zero_token','composite_intent',true,'broad',v_broad)
  )
  on conflict(page_id,message_id) do update set
    status='completed',customer_goal=excluded.customer_goal,intent_type=excluded.intent_type,
    product_scope=excluded.product_scope,catalog_key=excluded.catalog_key,confidence=1.0,
    should_reply=true,final_reply=excluded.final_reply,should_send_slide=false,slide_asset_ids='[]'::jsonb,
    should_request_contact=excluded.should_request_contact,should_handoff_sale=excluded.should_handoff_sale,
    needs_clarification=false,decision=excluded.decision,evidence_summary=excluded.evidence_summary,
    risk_flags='[]'::jsonb,error=null,completed_at=excluded.completed_at,updated_at=excluded.updated_at,
    decision_authority=excluded.decision_authority,prompt_version=excluded.prompt_version,
    provider_key=excluded.provider_key,model_name=excluded.model_name,model_calls=0,
    context_bytes=excluded.context_bytes,input_tokens=0,output_tokens=0,total_tokens=0,
    cached_input_tokens=0,reasoning_tokens=0,usage_details=excluded.usage_details
  returning id into v_decision_id;

  update public.v8_ai_brain_requests
  set status='completed',decision_id=v_decision_id,completed_at=v_now,
      dispatch_locked_at=null,dispatch_locked_by=null,last_error=null,
      dispatch_details=coalesce(dispatch_details,'{}'::jsonb)||jsonb_build_object(
        'quota_saved',true,'zero_token_fast_path',case when v_broad then 'broad_catalog_interest' else 'address_with_sales_context' end,
        'prompt_version','sales_intent_zero_token_v4','model_calls',0,'input_tokens',0,'output_tokens',0,'total_tokens',0,
        'completed_at',v_now
      )
  where id=new.id and decision_id is null;

  return new;
end;
$function$;

drop trigger if exists trg_v8_zy_sales_intent_zero_token_request on public.v8_ai_brain_requests;
create trigger trg_v8_zy_sales_intent_zero_token_request
after insert on public.v8_ai_brain_requests
for each row execute function public.v8_zero_token_sales_intent_request();

insert into public.v8_config_hub(scope,key,value,description,is_active,updated_at)
values('runtime','sales_intent_composite_v4',jsonb_build_object(
  'enabled',true,'version','sales_intent_zero_token_v4','address_preserves_product_intent',true,
  'broad_catalog_interest',true,'meta_call_notice_skipped',true,'activated_at',now()
),'Giữ ý định kép địa chỉ + sản phẩm, hiểu nhu cầu xem hết và bỏ qua thông báo kỹ thuật Meta.',true,now())
on conflict(scope,key) do update set value=excluded.value,description=excluded.description,is_active=true,updated_at=now();