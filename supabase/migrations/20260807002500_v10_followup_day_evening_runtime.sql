-- V10 follow-up runtime: separate re-engagement from live unanswered-message handling.
-- The scanner creates AI decisions only after a page/bot reply and customer silence.

create table if not exists public.v10_followup_config (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default true,
  delivery_enabled boolean not null default true,
  timezone text not null default 'Asia/Bangkok',
  day_start_hour smallint not null default 8 check (day_start_hour between 0 and 23),
  evening_start_hour smallint not null default 18 check (evening_start_hour between 0 and 23),
  day_wait_minutes integer not null default 240 check (day_wait_minutes between 15 and 1440),
  evening_wait_minutes integer not null default 120 check (evening_wait_minutes between 15 and 1440),
  scan_interval_minutes integer not null default 15 check (scan_interval_minutes between 1 and 180),
  max_age_hours integer not null default 20 check (max_age_hours between 1 and 23),
  max_per_run integer not null default 20 check (max_per_run between 1 and 100),
  text_only boolean not null default true,
  one_per_conversation_cycle boolean not null default true,
  last_scan_at timestamptz,
  last_scan_result jsonb not null default '{}'::jsonb,
  last_delivery_at timestamptz,
  updated_by text,
  updated_at timestamptz not null default now()
);

insert into public.v10_followup_config(id, enabled, delivery_enabled, updated_by)
values (1, true, true, 'owner_reactivation_20260807')
on conflict (id) do update set
  enabled = true,
  delivery_enabled = true,
  updated_by = excluded.updated_by,
  updated_at = now();

create table if not exists public.v10_followup_log (
  id uuid primary key default gen_random_uuid(),
  anchor_decision_id uuid not null references public.v9_decisions(id) on delete cascade,
  decision_id uuid references public.v9_decisions(id) on delete set null,
  page_id text not null,
  sender_id text not null,
  period text not null check (period in ('daytime','evening')),
  wait_minutes integer not null,
  anchor_customer_at timestamptz not null,
  anchor_page_at timestamptz not null,
  due_at timestamptz not null,
  status text not null default 'queued',
  attempts integer not null default 0,
  final_reply text,
  provider_message_id text,
  skip_reason text,
  last_error text,
  next_retry_at timestamptz,
  queued_at timestamptz not null default now(),
  sent_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(anchor_decision_id),
  unique(decision_id)
);

create index if not exists idx_v10_followup_log_status_due
  on public.v10_followup_log(status, due_at desc);
create index if not exists idx_v10_followup_log_customer
  on public.v10_followup_log(page_id, sender_id, queued_at desc);

create or replace function public.v10_enqueue_due_followups(
  p_limit integer default null,
  p_force boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg public.v10_followup_config%rowtype;
  v_now timestamptz := now();
  v_limit integer;
  v_created integer := 0;
  v_considered integer := 0;
  v_log_id uuid;
  v_decision_id uuid;
  v_wait_minutes integer;
  v_period text;
  v_due_at timestamptz;
  v_page_text text;
  v_messages jsonb;
  v_conversation jsonb;
  v_followup jsonb;
  v_snapshot jsonb;
  r record;
begin
  select * into v_cfg from public.v10_followup_config where id = 1 for update;
  if not found then
    raise exception 'V10_FOLLOWUP_CONFIG_MISSING';
  end if;

  if not v_cfg.enabled then
    return jsonb_build_object('ok', true, 'enabled', false, 'created', 0, 'reason', 'FOLLOWUP_DISABLED');
  end if;

  if not p_force
     and v_cfg.last_scan_at is not null
     and v_cfg.last_scan_at > v_now - make_interval(mins => v_cfg.scan_interval_minutes) then
    return jsonb_build_object(
      'ok', true,
      'enabled', true,
      'created', 0,
      'reason', 'SCAN_INTERVAL_NOT_DUE',
      'last_scan_at', v_cfg.last_scan_at
    );
  end if;

  v_limit := least(100, greatest(1, coalesce(p_limit, v_cfg.max_per_run)));
  update public.v10_followup_config
  set last_scan_at = v_now,
      updated_at = v_now
  where id = 1;

  for r in
    with latest_context as (
      select distinct on (s.page_id, s.sender_id)
        s.page_id,
        s.sender_id,
        s.contact_status,
        s.phone,
        s.zalo,
        s.human_takeover,
        s.human_takeover_until,
        s.last_customer_event_at,
        s.last_page_event_at,
        d.id as anchor_decision_id,
        d.input_snapshot,
        d.output,
        d.created_at as decision_created_at,
        d.updated_at as decision_updated_at,
        p.page_name,
        p.timezone as page_timezone
      from public.v9_conversation_state s
      join public.v9_pages p
        on p.page_id = s.page_id
       and p.is_active
       and p.operating_mode = 'ACTIVE'
       and p.coexistence_mode = 'AICAKE_DISABLED'
      join lateral (
        select x.*
        from public.v9_decisions x
        where x.page_id = s.page_id
          and x.sender_id = s.sender_id
          and x.goal <> 'follow_up_reengagement'
          and x.input_snapshot ->> 'architecture' = 'v10_ai_sovereign_advisory'
          and x.created_at >= coalesce(s.last_customer_event_at, '-infinity'::timestamptz) - interval '15 minutes'
        order by x.created_at desc
        limit 1
      ) d on true
      where s.last_customer_event_at is not null
        and s.last_page_event_at is not null
        and s.last_page_event_at > s.last_customer_event_at
        and coalesce(nullif(btrim(s.phone), ''), nullif(btrim(s.zalo), '')) is null
        and lower(coalesce(s.contact_status, 'missing')) not in ('captured','verified','known','opt_out')
        and not (
          s.human_takeover
          and (s.human_takeover_until is null or s.human_takeover_until > v_now)
        )
        and v_now - s.last_customer_event_at <= make_interval(hours => v_cfg.max_age_hours)
        and not exists (
          select 1 from public.v10_followup_log l
          where l.anchor_decision_id = d.id
        )
      order by s.page_id, s.sender_id, d.created_at desc
    )
    select *
    from latest_context
    order by last_page_event_at asc
    limit v_limit
  loop
    v_considered := v_considered + 1;
    if extract(hour from (r.last_page_event_at at time zone v_cfg.timezone)) >= v_cfg.day_start_hour
       and extract(hour from (r.last_page_event_at at time zone v_cfg.timezone)) < v_cfg.evening_start_hour then
      v_period := 'daytime';
      v_wait_minutes := v_cfg.day_wait_minutes;
    else
      v_period := 'evening';
      v_wait_minutes := v_cfg.evening_wait_minutes;
    end if;

    v_due_at := r.last_page_event_at + make_interval(mins => v_wait_minutes);
    if v_due_at > v_now then
      continue;
    end if;

    insert into public.v10_followup_log(
      anchor_decision_id, page_id, sender_id, period, wait_minutes,
      anchor_customer_at, anchor_page_at, due_at, status, queued_at, updated_at
    ) values (
      r.anchor_decision_id, r.page_id, r.sender_id, v_period, v_wait_minutes,
      r.last_customer_event_at, r.last_page_event_at, v_due_at, 'queued', v_now, v_now
    )
    on conflict (anchor_decision_id) do nothing
    returning id into v_log_id;

    if v_log_id is null then
      continue;
    end if;

    v_page_text := case
      when r.output ? 'final_reply'
       and nullif(btrim(r.output ->> 'final_reply'), '') is not null
       and abs(extract(epoch from (r.last_page_event_at - r.decision_updated_at))) <= 300
      then r.output ->> 'final_reply'
      else ''
    end;

    v_conversation := coalesce(r.input_snapshot -> 'conversation', '{}'::jsonb);
    v_messages := coalesce(v_conversation -> 'messages', '[]'::jsonb);
    if v_page_text <> '' then
      v_messages := v_messages || jsonb_build_array(jsonb_build_object(
        'id', 'followup-anchor:' || r.anchor_decision_id::text,
        'role', 'bot',
        'text', v_page_text,
        'event_type', 'page_reply',
        'attachments', '[]'::jsonb,
        'occurred_at', r.last_page_event_at
      ));
    end if;

    v_followup := jsonb_build_object(
      'enabled', true,
      'kind', 'scheduled_reengagement',
      'period', v_period,
      'wait_minutes', v_wait_minutes,
      'anchor_decision_id', r.anchor_decision_id,
      'anchor_customer_at', r.last_customer_event_at,
      'anchor_page_at', r.last_page_event_at,
      'due_at', v_due_at,
      'text_only', v_cfg.text_only,
      'instruction', 'Đây là lượt chăm sóc lại sau khi khách đã được trả lời nhưng im lặng. Đọc toàn bộ nhu cầu cũ, chỉ gửi một tin ngắn có giá trị hoặc suppress. Không lặp câu cũ, không xin SĐT/Zalo nếu tin gần nhất đã xin, không hỏi dồn và không nói như quảng cáo đại trà.'
    );

    v_conversation := v_conversation || jsonb_build_object(
      'messages', v_messages,
      'requires_ai', true,
      'hard_stop_reason', null,
      'follow_up', v_followup
    );

    v_snapshot := r.input_snapshot || jsonb_build_object(
      'architecture', 'v10_ai_sovereign_advisory',
      'page_id', r.page_id,
      'state', jsonb_build_object(
        'phone', r.phone,
        'zalo', r.zalo,
        'contact_status', r.contact_status,
        'human_takeover', r.human_takeover,
        'human_takeover_until', r.human_takeover_until,
        'last_customer_event_at', r.last_customer_event_at,
        'last_page_event_at', r.last_page_event_at
      ),
      'conversation', v_conversation,
      'follow_up', v_followup
    );

    insert into public.v9_decisions(
      source_event_id, turn_id, page_id, sender_id, mode, status, goal,
      action, confidence, input_snapshot, output, risk_flags, created_at, updated_at
    ) values (
      'followup:' || r.anchor_decision_id::text,
      null,
      r.page_id,
      r.sender_id,
      'ACTIVE',
      'shadow_context_ready',
      'follow_up_reengagement',
      null,
      null,
      v_snapshot,
      jsonb_build_object(
        'should_send', false,
        'transport_locked', true,
        'follow_up', v_followup,
        'followup_log_id', v_log_id
      ),
      '[]'::jsonb,
      v_now,
      v_now
    )
    on conflict (source_event_id) do update set
      input_snapshot = excluded.input_snapshot,
      output = excluded.output,
      updated_at = excluded.updated_at
    returning id into v_decision_id;

    update public.v10_followup_log
    set decision_id = v_decision_id,
        status = 'ai_queued',
        updated_at = v_now
    where id = v_log_id;

    v_created := v_created + 1;
    v_log_id := null;
    v_decision_id := null;
  end loop;

  update public.v10_followup_config
  set last_scan_result = jsonb_build_object(
        'ok', true,
        'scanned_at', v_now,
        'considered', v_considered,
        'created', v_created,
        'force', p_force
      ),
      updated_at = v_now
  where id = 1;

  return jsonb_build_object(
    'ok', true,
    'enabled', true,
    'scanned_at', v_now,
    'considered', v_considered,
    'created', v_created
  );
end;
$$;

create or replace function public.v10_route_followup_ai_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.goal = 'follow_up_reengagement' and new.status = 'shadow_ai_completed' then
    new.status := 'followup_ai_completed';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_v10_route_followup_ai_status on public.v9_decisions;
create trigger trg_v10_route_followup_ai_status
before update of status on public.v9_decisions
for each row execute function public.v10_route_followup_ai_status();

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
        when new.status = 'shadow_ai_error' then 'ai_failed'
        else status
      end,
      final_reply = coalesce(nullif(new.output ->> 'final_reply', ''), final_reply),
      last_error = case when new.status = 'shadow_ai_error' then new.output ->> 'last_error' else last_error end,
      updated_at = now()
  where decision_id = new.id;

  return new;
end;
$$;

drop trigger if exists trg_v10_sync_followup_log_from_decision on public.v9_decisions;
create trigger trg_v10_sync_followup_log_from_decision
after update of status, output on public.v9_decisions
for each row execute function public.v10_sync_followup_log_from_decision();

revoke all on table public.v10_followup_config from public, anon, authenticated;
revoke all on table public.v10_followup_log from public, anon, authenticated;
grant all on table public.v10_followup_config to service_role;
grant all on table public.v10_followup_log to service_role;
revoke all on function public.v10_enqueue_due_followups(integer, boolean) from public, anon, authenticated;
grant execute on function public.v10_enqueue_due_followups(integer, boolean) to service_role;
revoke all on function public.v10_route_followup_ai_status() from public, anon, authenticated;
revoke all on function public.v10_sync_followup_log_from_decision() from public, anon, authenticated;
