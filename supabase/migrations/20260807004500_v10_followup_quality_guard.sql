-- Strict quality gate for scheduled follow-up decisions.
-- Bad or repetitive AI output is suppressed before the delivery worker can claim it.

create or replace function public.v10_followup_context_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_instruction text := 'Đây là lượt Follow-up sau khi khách đã được trả lời nhưng im lặng. Chỉ gửi một tin ngắn 1-2 câu, phải nối đúng sản phẩm hoặc nhu cầu cụ thể; nếu không đủ ngữ cảnh thì chọn suppress. Không trả lời lại nguyên câu hỏi cũ, không liệt kê toàn bộ địa chỉ hay chương trình. Không nói đã gửi mẫu vì lượt này chỉ gửi chữ. Không xin SĐT/Zalo nếu tin Page/BOT gần nhất đã xin. Không bịa showroom, tồn kho, giá, ưu đãi hoặc địa điểm. Không dùng câu chung chung kiểu đang muốn xem sản phẩm nào.';
  v_followup jsonb;
begin
  if new.goal <> 'follow_up_reengagement' then
    return new;
  end if;

  v_followup := coalesce(new.input_snapshot -> 'follow_up', '{}'::jsonb)
    || jsonb_build_object(
      'instruction', v_instruction,
      'quality_policy', 'followup_strict_v2',
      'text_only', true,
      'suppress_when_context_unclear', true,
      'repeat_contact_request_forbidden', true,
      'generic_clarification_forbidden', true
    );

  new.input_snapshot := jsonb_set(
    jsonb_set(coalesce(new.input_snapshot, '{}'::jsonb), '{follow_up}', v_followup, true),
    '{conversation,follow_up}',
    v_followup,
    true
  );
  new.output := coalesce(new.output, '{}'::jsonb) || jsonb_build_object('follow_up', v_followup);
  return new;
end;
$$;

drop trigger if exists trg_v10_followup_context_policy on public.v9_decisions;
create trigger trg_v10_followup_context_policy
before insert or update of input_snapshot, output on public.v9_decisions
for each row execute function public.v10_followup_context_policy();

create or replace function public.v10_followup_quality_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_text text := btrim(coalesce(new.output ->> 'final_reply', ''));
  v_lower text;
  v_last_page_text text := '';
  v_item jsonb;
  v_role text;
  v_reason text := null;
  v_contact_status text := lower(coalesce(new.input_snapshot #>> '{state,contact_status}', 'missing'));
begin
  if new.goal <> 'follow_up_reengagement' or new.status <> 'followup_ai_completed' then
    return new;
  end if;

  v_lower := lower(regexp_replace(v_text, '\s+', ' ', 'g'));

  for v_item in
    select value from jsonb_array_elements(coalesce(new.input_snapshot #> '{conversation,messages}', '[]'::jsonb))
  loop
    v_role := lower(coalesce(v_item ->> 'role', ''));
    if v_role = 'customer' then
      v_last_page_text := '';
    elsif v_role in ('human','bot','automation','page') then
      v_last_page_text := coalesce(v_item ->> 'text', '');
    end if;
  end loop;

  if new.action = 'suppress' or v_text = '' then
    v_reason := 'AI_SUPPRESSED';
  elsif length(v_text) > 420 then
    v_reason := 'FOLLOWUP_TOO_LONG';
  elsif new.action = 'reply_with_slides' or coalesce((new.output ->> 'needs_slides')::boolean, false) then
    v_reason := 'FOLLOWUP_TEXT_ONLY_MEDIA_DECISION';
  elsif v_lower ~ '(bên em em|nhé nhé|ạ ạ)' then
    v_reason := 'FOLLOWUP_REPEATED_WORDS';
  elsif v_lower ~ '(đã gửi|em gửi rồi|vừa gửi).{0,40}mẫu' then
    v_reason := 'FOLLOWUP_FALSE_MEDIA_CLAIM';
  elsif v_lower ~ '(đang muốn xem mẫu sản phẩm nào|muốn xem sản phẩm nào|cần tư vấn sản phẩm nào)' then
    v_reason := 'FOLLOWUP_GENERIC_CLARIFICATION';
  elsif v_lower ~ '(showroom|cửa hàng).{0,30}(tại|ở) hải phòng|showroom tại hải phòng|có showroom tại hải phòng' then
    v_reason := 'FOLLOWUP_UNVERIFIED_LOCATION';
  elsif v_lower like 'cửa hàng của em là showroom%' then
    v_reason := 'FOLLOWUP_IRRELEVANT_IDENTITY_DUMP';
  elsif ((length(v_lower) - length(replace(v_lower, 'cơ sở', ''))) / greatest(length('cơ sở'),1)) >= 2 then
    v_reason := 'FOLLOWUP_ADDRESS_DUMP';
  elsif new.action = 'acknowledge_contact' and v_contact_status not in ('captured','verified','known') then
    v_reason := 'FOLLOWUP_FALSE_CONTACT_ACK';
  elsif lower(v_last_page_text) ~ '(sđt|số điện thoại|zalo)'
        and v_lower ~ '(sđt|số điện thoại|zalo)' then
    v_reason := 'FOLLOWUP_REPEATED_CONTACT_REQUEST';
  end if;

  if v_reason is not null then
    new.status := 'followup_suppressed';
    new.output := coalesce(new.output, '{}'::jsonb) || jsonb_build_object(
      'should_send', false,
      'transport_locked', true,
      'followup_suppression_reason', v_reason,
      'quality_guard', 'followup_strict_v2'
    );
  else
    new.output := coalesce(new.output, '{}'::jsonb) || jsonb_build_object(
      'quality_guard', 'followup_strict_v2',
      'followup_quality_approved', true
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_v10_zz_followup_quality_guard on public.v9_decisions;
create trigger trg_v10_zz_followup_quality_guard
before update of status, output on public.v9_decisions
for each row execute function public.v10_followup_quality_guard();

create or replace function public.v10_sync_followup_log_from_decision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.goal <> 'follow_up_reengagement' then
    return new;
  end if;

  update public.v10_followup_log
  set status = case
        when new.status = 'shadow_ai_processing' then 'ai_processing'
        when new.status = 'followup_ai_completed' then 'ready_to_send'
        when new.status = 'followup_suppressed' then 'suppressed'
        when new.status = 'shadow_ai_error' then 'ai_failed'
        else status
      end,
      final_reply = coalesce(nullif(new.output ->> 'final_reply', ''), final_reply),
      skip_reason = case
        when new.status = 'followup_suppressed' then coalesce(new.output ->> 'followup_suppression_reason', 'QUALITY_GUARD_SUPPRESSED')
        else skip_reason
      end,
      last_error = case when new.status = 'shadow_ai_error' then new.output ->> 'last_error' else last_error end,
      updated_at = now()
  where decision_id = new.id;

  return new;
end;
$$;

-- Upgrade queued inputs to the strict policy and re-evaluate completed decisions.
update public.v9_decisions
set input_snapshot = input_snapshot,
    output = output,
    updated_at = updated_at
where goal = 'follow_up_reengagement'
  and status in ('shadow_context_ready','shadow_ai_processing','followup_ai_completed');

revoke all on function public.v10_followup_context_policy() from public, anon, authenticated;
revoke all on function public.v10_followup_quality_guard() from public, anon, authenticated;
