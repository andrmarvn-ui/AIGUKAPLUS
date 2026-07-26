-- Emergency hotfix 2026-07-26
-- Restore AI authority for contextual turns after over-broad zero-token quota rules.
-- Production was patched first; this migration records the final idempotent state.

create or replace function public.v8_block_history_ai_requests()
returns trigger
language plpgsql
security definer
set search_path='public'
as $function$
declare
  v_has_live boolean:=false;
  v_has_history boolean:=false;
  v_has_fresh_history boolean:=false;
begin
  if coalesce(new.status,'pending') <> 'pending' then return new; end if;

  select
    exists(
      select 1 from public.v8_messages_raw m
      where m.page_id=new.page_id and m.message_id=new.message_id
        and m.source_system='meta_customer'
    ),
    exists(
      select 1 from public.v8_messages_raw m
      where m.page_id=new.page_id and m.message_id=new.message_id
        and (
          m.source_system='meta_customer_history'
          or coalesce(m.raw_payload->>'source','') in ('meta_history_sync','meta_history_preflight')
        )
    ),
    exists(
      select 1 from public.v8_messages_raw m
      where m.page_id=new.page_id and m.message_id=new.message_id
        and (
          m.source_system='meta_customer_history'
          or coalesce(m.raw_payload->>'source','') in ('meta_history_sync','meta_history_preflight')
        )
        and m.sent_at is not null
        and m.created_at <= m.sent_at + interval '45 minutes'
    )
  into v_has_live,v_has_history,v_has_fresh_history;

  if v_has_history and not v_has_live and not v_has_fresh_history then
    new.status:='skipped';
    new.completed_at:=now();
    new.last_error:='stale_history_context_only_emergency_patch';
    new.dispatch_locked_at:=null;
    new.dispatch_locked_by:=null;
    new.dispatch_details:=coalesce(new.dispatch_details,'{}'::jsonb)||jsonb_build_object(
      'blocked_by','emergency_restore_ai_context_quality_20260726',
      'history_context_only',true,
      'fresh_history_recovery',false,
      'blocked_at',now()
    );
  else
    new.dispatch_details:=coalesce(new.dispatch_details,'{}'::jsonb)||jsonb_build_object(
      'history_guard',case
        when v_has_live then 'live_event_precedence'
        when v_has_fresh_history then 'fresh_history_recovery_allowed'
        else 'not_history'
      end,
      'live_copy_present',v_has_live,
      'fresh_history_recovery',v_has_fresh_history
    );
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_v8_000_block_history_ai_request on public.v8_ai_brain_requests;
create trigger trg_v8_000_block_history_ai_request
before insert or update of status,message_id,requested_by
on public.v8_ai_brain_requests
for each row execute function public.v8_block_history_ai_requests();

-- Remove broad deterministic rules that stole contextual turns from the model.
drop trigger if exists trg_v8_zero_token_combo_postback_request on public.v8_ai_brain_requests;
drop trigger if exists trg_v8_zy_sales_intent_zero_token_request on public.v8_ai_brain_requests;
drop trigger if exists trg_v8_zzz_zero_token_known_product_postback_request on public.v8_ai_brain_requests;

-- Keep zero-token handling only for exact, deterministic intents.
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
  if v_phone is not null then return 'provide_contact'; end if;

  if v_norm in (
    '', 'ok', 'oke', 'okay', 'cam on', 'thanks', 'thank you',
    'vang', 'da', 'uh', 'um', 'f', 'meta ai call me in messenger'
  ) then return 'no_value'; end if;

  if v_norm in (
    'so dien thoai','sdt','so zalo','zalo','xin so dien thoai','xin sdt',
    'xin so zalo','xin zalo','cho xin so dien thoai','cho xin sdt',
    'cho xin so zalo','cho xin zalo','so dien thoai cua hang','sdt cua hang',
    'zalo cua hang','hotline','xin hotline','hotline cua hang'
  ) then return 'ask_store_contact'; end if;

  if v_norm in (
    'dia chi','xin dia chi','xin dia chi shop','xin dia chi showroom',
    'cho minh xin dia chi','gui dia chi','gui dinh vi','xin dinh vi',
    'dia chi o dau','showroom o dau','cua hang o dau','shop o dau',
    'dia chi kho','kho o dau'
  ) then return 'ask_address'; end if;

  return null;
end;
$function$;

-- Pause the deterministic contextual promotion follow-up until quality tests pass.
update public.v8_config_hub
set value=coalesce(value,'{}'::jsonb)||jsonb_build_object(
      'enabled',false,
      'emergency_paused_at',now(),
      'emergency_pause_reason','contextual_zero_token_quality_regression',
      'version','emergency_paused_20260726'
    ),
    updated_at=now()
where scope='promotion' and key='showroom_event_202607_single_followup_text';

-- Cancel unsafe queued messages created by the paused follow-up or stale history replay.
update public.v8_outbound_queue oq
set status='cancelled',
    cancelled_at=now(),
    cancel_reason='EMERGENCY_CONTEXT_QUALITY_PATCH',
    locked_at=null,
    locked_by=null,
    updated_at=now()
where oq.status in ('planned','ready','sending','staged','pending')
  and (
    oq.pipeline_version='contextual_followup_v2'
    or exists (
      select 1
      from public.v8_reply_plans rp
      join public.v8_messages_raw m
        on m.page_id=rp.page_id and m.message_id=rp.message_id
      where rp.id=oq.reply_plan_id
        and m.source_system='meta_customer_history'
        and m.created_at > m.sent_at + interval '45 minutes'
    )
  );

update public.v8_reply_plans rp
set dispatch_status='cancelled',
    send_eligible=false,
    blocked_reason='EMERGENCY_CONTEXT_QUALITY_PATCH'
where coalesce(rp.dispatch_status,'') not in ('sent','cancelled')
  and (
    rp.pipeline_version='contextual_followup_v2'
    or exists (
      select 1 from public.v8_messages_raw m
      where m.page_id=rp.page_id and m.message_id=rp.message_id
        and m.source_system='meta_customer_history'
        and m.created_at > m.sent_at + interval '45 minutes'
    )
  );

insert into public.v8_admin_change_log(
  actor,action,asset_type,asset_id,before_data,after_data,metadata,created_at
)
values(
  'chatgpt_emergency_patch',
  'restore_ai_context_authority',
  'ai_runtime',
  'production',
  jsonb_build_object(
    'broad_zero_token_sales',true,
    'stale_history_can_trigger_ai',true,
    'contextual_followup_enabled',true
  ),
  jsonb_build_object(
    'broad_zero_token_sales',false,
    'fresh_history_recovery_only',true,
    'contextual_followup_enabled',false
  ),
  jsonb_build_object(
    'migration','20260726101500_emergency_restore_ai_context_quality',
    'reason','user_approved_emergency_patch'
  ),
  now()
);