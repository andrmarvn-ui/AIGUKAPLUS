create or replace function public.v8_build_contextual_lead_followup(p_customer_id uuid,p_source_message_row_id uuid default null)
returns text
language plpgsql
stable
set search_path='public'
as $function$
declare
  c public.v8_customers%rowtype;
  m public.v8_messages_raw%rowtype;
  d public.v8_ai_decisions%rowtype;
  v_product jsonb:='{}'::jsonb;
  v_scope text;
  v_label text;
  v_items text;
  v_broad boolean:=false;
  v_norm text;
  v_text text;
begin
  select * into c from public.v8_customers where id=p_customer_id;
  if c.id is null then return null; end if;

  if p_source_message_row_id is not null then
    select * into m from public.v8_messages_raw
    where id=p_source_message_row_id and customer_id=c.id and direction='inbound';
  end if;
  if m.id is null then
    select * into m from public.v8_messages_raw
    where customer_id=c.id and direction='inbound' and coalesce(actor_type,'customer')='customer'
    order by sent_at desc,created_at desc limit 1;
  end if;

  if m.id is not null and public.v8_obligation_is_low_value(m.message_text,m.attachments) then
    select * into m from public.v8_messages_raw x
    where x.customer_id=c.id and x.direction='inbound' and coalesce(x.actor_type,'customer')='customer'
      and x.sent_at<m.sent_at and not public.v8_obligation_is_low_value(x.message_text,x.attachments)
    order by x.sent_at desc,x.created_at desc limit 1;
  end if;

  if m.id is not null then
    select * into d from public.v8_ai_decisions
    where page_id=m.page_id and message_id=m.message_id and status='completed'
    order by updated_at desc limit 1;
  end if;

  v_norm:=public.v8_normalize_detector_text(coalesce(m.message_text,''));
  v_product:=public.v8_sales_product_profile(coalesce(m.message_text,''),c.id);
  v_scope:=coalesce(nullif(v_product->>'scope',''),nullif(d.product_scope,''),nullif(c.last_product_key,''),nullif(c.last_catalog_key,''));
  v_label:=nullif(v_product->>'label','');
  v_items:=nullif(v_product->>'items','');
  v_broad:=coalesce((v_product->>'broad')::boolean,false) or v_scope='multi_product';

  if v_broad then
    v_text:='Bên em là Tổng kho Ánh Dương, có đủ thiết bị nhà tắm, nhà bếp, quạt trần, đèn trang trí và gạch ốp lát. Mình cho em xin SĐT hoặc Zalo, bên em gửi catalog theo từng nhóm và tư vấn đồng bộ cho mình tiện xem ạ.';
  elsif coalesce(d.intent_type,'')='ask_address' or v_norm ~ '(dia chi|o dau|showroom|cua hang.*dau|shop.*dau)' then
    v_text:='Mình dự định qua cơ sở nào'||case when v_label is not null then ' để xem '||v_label else '' end||'? Bên em có nhiều mẫu'||case when v_items is not null then ' '||v_items else ' theo từng hạng mục' end||'. Mình cho em xin SĐT hoặc Zalo, bên em gửi mẫu trước và nhờ nhân viên chuẩn bị sẵn để mình xem nhanh ạ.';
  elsif v_label is not null then
    v_text:='Bên em là Tổng kho Ánh Dương, '||v_label||' có nhiều mẫu'||case when v_items is not null then ' gồm '||v_items else '' end||'. Mình cho em xin SĐT hoặc Zalo, bên em gửi mẫu phù hợp và báo giá cụ thể kèm ưu đãi ạ.';
  else
    v_text:='Bên em là Tổng kho Ánh Dương, có thiết bị nhà tắm, nhà bếp, quạt trần, đèn trang trí và gạch ốp lát. Mình đang cần nhóm nào và cho em xin SĐT hoặc Zalo, bên em gửi mẫu phù hợp cho mình ạ.';
  end if;

  return left(v_text,900);
end;
$function$;

create or replace function public.v8_stage_showroom_promotion_single_text(p_customer_id uuid,p_source_message_row_id uuid default null,p_requested_by text default 'single_followup_scan',p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path='public'
as $function$
declare
  c public.v8_customers%rowtype;
  m public.v8_messages_raw%rowtype;
  v_cfg jsonb:='{}'::jsonb;
  v_campaign_key text;
  v_text text;
  v_channel jsonb;
  v_policy record;
  v_delivery_id uuid;
  v_reply_plan_id uuid;
  v_outbound_id uuid;
  v_due_at timestamptz;
  v_last_reply_at timestamptz;
  v_last_reply_source text;
  v_wait_hours integer:=0;
begin
  select * into c from public.v8_customers where id=p_customer_id;
  if c.id is null then return jsonb_build_object('ok',false,'reason','customer_not_found'); end if;

  select value into v_cfg from public.v8_config_hub
  where scope='promotion' and key='showroom_event_202607_single_followup_text' and is_active
  order by updated_at desc limit 1;
  v_cfg:=coalesce(v_cfg,'{}'::jsonb);
  if not coalesce((v_cfg->>'enabled')::boolean,false) then return jsonb_build_object('ok',true,'staged',false,'reason','single_followup_disabled'); end if;

  if not exists(select 1 from jsonb_array_elements_text(coalesce(v_cfg->'page_ids','[]'::jsonb)) p(value) where p.value=c.page_id) then return jsonb_build_object('ok',true,'staged',false,'reason','page_not_enabled'); end if;
  if c.phone is not null or c.zalo is not null or public.v8_customer_has_contact(c.id) then return jsonb_build_object('ok',true,'staged',false,'reason','contact_already_captured'); end if;
  if exists(select 1 from public.v8_marketing_message_subscriptions s where s.customer_id=c.id and s.page_id=c.page_id and s.status='stopped') then return jsonb_build_object('ok',true,'staged',false,'reason','promotion_opted_out'); end if;
  if exists(select 1 from public.v8_messages_raw x where x.customer_id=c.id and x.direction='inbound' and public.v8_is_promotion_opt_out_text(x.message_text)) then return jsonb_build_object('ok',true,'staged',false,'reason','promotion_opt_out_text_found'); end if;

  if p_source_message_row_id is not null then
    select * into m from public.v8_messages_raw where id=p_source_message_row_id and customer_id=c.id and direction='inbound' and actor_type='customer';
  end if;
  if m.id is null then
    select * into m from public.v8_messages_raw where customer_id=c.id and direction='inbound' and actor_type='customer' order by sent_at desc,created_at desc limit 1;
  end if;
  if m.id is null then return jsonb_build_object('ok',true,'staged',false,'reason','source_message_missing'); end if;
  if exists(select 1 from public.v8_messages_raw x where x.customer_id=c.id and x.direction='inbound' and x.actor_type='customer' and x.sent_at>m.sent_at) then return jsonb_build_object('ok',true,'staged',false,'reason','newer_customer_message'); end if;

  select x.sent_at,x.source_system into v_last_reply_at,v_last_reply_source
  from public.v8_messages_raw x
  where x.customer_id=c.id and x.direction='outbound' and x.sent_at>m.sent_at
    and (public.v8_is_actionable_external_outbound(x.source_system,x.message_text,x.attachments,x.is_automatic,x.actor_type,x.source_detail)
      or public.v8_is_unresolved_page_outbound_candidate(x.source_system,x.message_text,x.attachments,x.is_automatic,x.actor_type,x.source_detail)
      or x.source_system in ('aiguka','aiguka_v8'))
  order by x.sent_at desc limit 1;
  if v_last_reply_at is null then return jsonb_build_object('ok',true,'staged',false,'reason','customer_question_not_answered'); end if;

  v_campaign_key:=coalesce(nullif(v_cfg->>'campaign_key',''),'showroom_event_202607_v1');
  v_text:=nullif(btrim(public.v8_build_contextual_lead_followup(c.id,m.id)),'');
  if v_text is null then return jsonb_build_object('ok',false,'reason','contextual_followup_text_missing'); end if;
  if exists(select 1 from public.v8_promotion_delivery_log d where d.customer_id=c.id and d.campaign_key=v_campaign_key) then return jsonb_build_object('ok',true,'staged',false,'reason','followup_already_staged_or_sent','campaign_key',v_campaign_key); end if;

  v_channel:=public.v8_resolve_messaging_channel(c.page_id,c.id,null,true);
  if v_channel->>'channel'<>'standard_24h' or not coalesce((v_channel->>'send_allowed_by_window')::boolean,false) then return jsonb_build_object('ok',true,'staged',false,'reason','standard_window_unavailable','channel',v_channel); end if;

  v_wait_hours:=case when extract(hour from now() at time zone 'Asia/Bangkok')>=coalesce((v_cfg->>'day_start_hour')::integer,8)
     and extract(hour from now() at time zone 'Asia/Bangkok')<coalesce((v_cfg->>'night_start_hour')::integer,18)
    then coalesce((v_cfg->>'day_wait_hours')::integer,4) else coalesce((v_cfg->>'night_wait_hours')::integer,2) end;
  if v_last_reply_at>now()-make_interval(hours=>v_wait_hours) then return jsonb_build_object('ok',true,'staged',false,'reason','followup_wait_not_reached','wait_hours',v_wait_hours,'last_reply_at',v_last_reply_at); end if;

  if p_dry_run then
    return jsonb_build_object('ok',true,'dry_run',true,'staged',false,'campaign_key',v_campaign_key,'page_id',c.page_id,'sender_id',c.sender_id,'channel',v_channel,'text',v_text,'wait_hours',v_wait_hours,'last_reply_at',v_last_reply_at,'ai_tokens',0,'contextual',true);
  end if;

  insert into public.v8_promotion_delivery_log(campaign_key,customer_id,page_id,sender_id,source_message_row_id,status,requested_by,details)
  values(v_campaign_key,c.id,c.page_id,c.sender_id,m.id,'preparing',p_requested_by,jsonb_build_object('channel','standard_24h','source_message_id',m.message_id,'single_message',true,'ai_tokens',0,'last_reply_at',v_last_reply_at,'last_reply_source',v_last_reply_source,'wait_hours',v_wait_hours,'contextual_lead_followup',true))
  on conflict(customer_id,campaign_key) do nothing returning id into v_delivery_id;
  if v_delivery_id is null then return jsonb_build_object('ok',true,'staged',false,'reason','followup_deduped_concurrently'); end if;

  select * into v_policy from public.v8_resolve_runtime_policy(c.page_id) limit 1;
  v_due_at:=now()+interval '20 seconds';

  insert into public.v8_reply_plans(customer_id,page_id,sender_id,message_id,pipeline_version,business_group_key,intent_type,conversation_stage,action_type,suggested_reply,should_request_phone,should_ask_need,should_handoff_sale,safety_status,reason,send_eligible,blocked_reason,available_after,runtime_mode,is_latest_customer_turn,messaging_channel,utility_eligible,dispatch_status,dispatched_at)
  values(c.id,c.page_id,c.sender_id,m.message_id,'contextual_followup_v2','lead_followup','contextual_follow_up','silent_after_answer','contextual_text_followup',v_text,true,false,false,'ready_to_send',jsonb_build_object('is_promotional',false,'campaign_key',v_campaign_key,'promotion_delivery_id',v_delivery_id,'requested_by',p_requested_by,'source_system',m.source_system,'channel','standard_24h','care_case','contextual_contact_capture','care_anchor_at',v_last_reply_at,'single_message',true,'ai_tokens',0,'wait_hours',v_wait_hours,'last_reply_source',v_last_reply_source,'contextual',true),true,null,v_due_at,coalesce(v_policy.runtime_mode,'OBSERVE'),true,'standard_24h',true,'staged',now())
  returning id into v_reply_plan_id;

  insert into public.v8_outbound_queue(customer_id,page_id,sender_id,reply_plan_id,pipeline_version,message_type,payload,messaging_channel,status,due_at)
  values(c.id,c.page_id,c.sender_id,v_reply_plan_id,'contextual_followup_v2','text',jsonb_build_object('text',v_text,'campaign_key',v_campaign_key,'promotion_delivery_id',v_delivery_id,'delivery_mode','standard_24h','is_promotional',false,'single_message',true,'source_message_id',m.message_id,'care_anchor_at',v_last_reply_at,'ai_tokens',0,'pipeline_version','contextual_followup_v2','contextual',true),'standard_24h','ready',v_due_at)
  returning id into v_outbound_id;

  update public.v8_promotion_delivery_log set reply_plan_id=v_reply_plan_id,outbound_id=v_outbound_id,status='queued',details=details||jsonb_build_object('outbound_id',v_outbound_id,'reply_plan_id',v_reply_plan_id,'contextual_text',v_text),updated_at=now() where id=v_delivery_id;

  return jsonb_build_object('ok',true,'staged',true,'campaign_key',v_campaign_key,'channel','standard_24h','reply_plan_id',v_reply_plan_id,'outbound_id',v_outbound_id,'promotion_delivery_id',v_delivery_id,'due_at',v_due_at,'single_message',true,'ai_tokens',0,'wait_hours',v_wait_hours,'contextual',true,'text',v_text);
end;
$function$;

update public.v8_config_hub
set value=coalesce(value,'{}'::jsonb)||jsonb_build_object('enabled',true,'version','contextual_lead_followup_v2','message_mode','contextual_from_latest_meaningful_turn','message_text',null,'single_message_all_benefits',false,'contextual_contact_capture',true,'generic_promotion_dump_disabled',true,'updated_at',now()),updated_at=now()
where scope='promotion' and key='showroom_event_202607_single_followup_text';

update public.v8_config_hub
set value=coalesce(value,'{}'::jsonb)||jsonb_build_object('policy_version','contextual_lead_followup_v2','single_message_all_benefits',false,'natural_follow_up_required',true,'contextual_contact_capture',true,'generic_promotion_dump_disabled',true,'updated_at',now()),updated_at=now()
where scope='conversation' and key='follow_up_policy';

insert into public.v8_config_hub(scope,key,value,description,is_active,updated_at)
values('runtime','contextual_zero_token_followup_v2',jsonb_build_object('enabled',true,'version','contextual_lead_followup_v2','latest_meaningful_turn',true,'low_value_ack_backtracking',true,'generic_promotion_dump_disabled',true,'ai_tokens',0,'activated_at',now()),'Chăm sóc 0 token theo nhu cầu gần nhất, bỏ đoạn quảng cáo dài và vẫn xử lý khi khách chỉ trả lời Ok.',true,now())
on conflict(scope,key) do update set value=excluded.value,description=excluded.description,is_active=true,updated_at=now();