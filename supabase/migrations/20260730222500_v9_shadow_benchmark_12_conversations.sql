create table if not exists public.v9_shadow_benchmark_runs (
  id uuid primary key default gen_random_uuid(),
  benchmark_name text not null,
  started_at timestamptz not null,
  target_conversations integer not null check (target_conversations between 1 and 100),
  baseline_conversations integer not null default 0,
  observed_conversations integer not null default 0,
  completed_conversations integer not null default 0,
  status text not null default 'active' check (status in ('active','completed','cancelled')),
  transport_locked boolean not null default true,
  external_bot_mode text not null default 'AICAKE_ACTIVE',
  completed_at timestamptz,
  notes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists v9_shadow_benchmark_one_active_idx
on public.v9_shadow_benchmark_runs ((status)) where status='active';

create table if not exists public.v9_shadow_benchmark_conversations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.v9_shadow_benchmark_runs(id) on delete cascade,
  sequence_no integer not null,
  page_id text not null,
  sender_id text not null,
  first_customer_event_id uuid,
  first_customer_at timestamptz not null,
  last_customer_at timestamptz,
  customer_message text,
  aiguka_decision_id uuid,
  aiguka_status text,
  aiguka_action text,
  aiguka_reply text,
  aiguka_confidence numeric,
  aiguka_latency_ms integer,
  aiguka_should_request_contact boolean,
  aiguka_needs_slides boolean,
  aicake_reply text,
  aicake_reply_at timestamptz,
  aicake_source text,
  aicake_is_automatic boolean,
  comparison jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','aiguka_ready','aicake_observed','complete','timed_out')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id,page_id,sender_id),
  unique(run_id,sequence_no)
);

create index if not exists v9_shadow_benchmark_conversations_run_idx
on public.v9_shadow_benchmark_conversations(run_id,sequence_no);

alter table public.v9_shadow_benchmark_runs enable row level security;
alter table public.v9_shadow_benchmark_conversations enable row level security;
revoke all on public.v9_shadow_benchmark_runs from anon,authenticated,public;
revoke all on public.v9_shadow_benchmark_conversations from anon,authenticated,public;
grant select,insert,update,delete on public.v9_shadow_benchmark_runs to service_role;
grant select,insert,update,delete on public.v9_shadow_benchmark_conversations to service_role;

create or replace function public.v9_refresh_shadow_benchmark_progress(p_run_id uuid)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  v_observed integer;
  v_completed integer;
  v_target integer;
begin
  select count(*),count(*) filter(where status='complete')
  into v_observed,v_completed
  from public.v9_shadow_benchmark_conversations
  where run_id=p_run_id;

  select target_conversations into v_target
  from public.v9_shadow_benchmark_runs where id=p_run_id;

  update public.v9_shadow_benchmark_runs
  set observed_conversations=v_observed,
      completed_conversations=v_completed,
      status=case when v_observed>=v_target and v_completed>=v_target then 'completed' else status end,
      completed_at=case when v_observed>=v_target and v_completed>=v_target then coalesce(completed_at,now()) else completed_at end,
      updated_at=now()
  where id=p_run_id;
end;
$$;

create or replace function public.v9_capture_shadow_benchmark_event()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_run public.v9_shadow_benchmark_runs%rowtype;
  v_sequence integer;
begin
  if new.actor_type<>'customer' or new.event_type not in ('customer_message','customer_postback') or new.sender_id is null then
    return new;
  end if;

  select * into v_run
  from public.v9_shadow_benchmark_runs
  where status='active' and new.created_at>=started_at
  order by started_at desc limit 1;
  if not found then return new; end if;

  perform pg_advisory_xact_lock(hashtext(v_run.id::text));
  if exists(select 1 from public.v9_shadow_benchmark_conversations where run_id=v_run.id and page_id=new.page_id and sender_id=new.sender_id) then
    update public.v9_shadow_benchmark_conversations
    set last_customer_at=greatest(coalesce(last_customer_at,new.created_at),new.created_at),updated_at=now()
    where run_id=v_run.id and page_id=new.page_id and sender_id=new.sender_id;
    return new;
  end if;

  select count(*)+1 into v_sequence
  from public.v9_shadow_benchmark_conversations where run_id=v_run.id;
  if v_sequence>v_run.target_conversations then return new; end if;

  insert into public.v9_shadow_benchmark_conversations(
    run_id,sequence_no,page_id,sender_id,first_customer_event_id,first_customer_at,last_customer_at,customer_message,status
  ) values (
    v_run.id,v_sequence,new.page_id,new.sender_id,new.id,new.created_at,new.created_at,left(new.message_text,2000),'pending'
  ) on conflict(run_id,page_id,sender_id) do nothing;

  perform public.v9_refresh_shadow_benchmark_progress(v_run.id);
  return new;
end;
$$;

drop trigger if exists trg_v9_capture_shadow_benchmark_event on public.v9_events;
create trigger trg_v9_capture_shadow_benchmark_event
after insert on public.v9_events
for each row execute function public.v9_capture_shadow_benchmark_event();

create or replace function public.v9_capture_shadow_benchmark_decision()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_row public.v9_shadow_benchmark_conversations%rowtype;
  v_run_id uuid;
  v_reply text;
  v_status text;
begin
  if new.status not in ('shadow_ai_completed','shadow_suppressed','shadow_ai_error') then return new; end if;

  select c.* into v_row
  from public.v9_shadow_benchmark_conversations c
  join public.v9_shadow_benchmark_runs r on r.id=c.run_id
  where r.status='active'
    and c.page_id=new.page_id and c.sender_id=new.sender_id
    and new.created_at>=c.first_customer_at
    and c.aiguka_decision_id is null
  order by c.sequence_no asc limit 1;
  if not found then return new; end if;

  v_reply=nullif(new.output->>'final_reply','');
  v_status=case when v_reply is not null or new.status='shadow_suppressed' then 'aiguka_ready' else 'pending' end;

  update public.v9_shadow_benchmark_conversations
  set aiguka_decision_id=new.id,
      aiguka_status=new.status,
      aiguka_action=new.action,
      aiguka_reply=v_reply,
      aiguka_confidence=new.confidence,
      aiguka_latency_ms=new.latency_ms,
      aiguka_should_request_contact=coalesce((new.output->>'should_request_contact')::boolean,false),
      aiguka_needs_slides=coalesce((new.output->>'needs_slides')::boolean,false),
      comparison=comparison||jsonb_build_object(
        'aiguka_reason',new.output->>'reason',
        'aiguka_transport_locked',coalesce((new.output->>'transport_locked')::boolean,true),
        'aiguka_model',new.output->>'model',
        'aiguka_completed_at',new.updated_at
      ),
      status=case when aicake_reply is not null then 'complete' else v_status end,
      updated_at=now()
  where id=v_row.id
  returning run_id into v_run_id;

  perform public.v9_refresh_shadow_benchmark_progress(v_run_id);
  return new;
end;
$$;

drop trigger if exists trg_v9_capture_shadow_benchmark_decision on public.v9_decisions;
create trigger trg_v9_capture_shadow_benchmark_decision
after insert or update of status,output,action,confidence,latency_ms on public.v9_decisions
for each row execute function public.v9_capture_shadow_benchmark_decision();

revoke all on function public.v9_refresh_shadow_benchmark_progress(uuid) from public,anon,authenticated;
revoke all on function public.v9_capture_shadow_benchmark_event() from public,anon,authenticated;
revoke all on function public.v9_capture_shadow_benchmark_decision() from public,anon,authenticated;
grant execute on function public.v9_refresh_shadow_benchmark_progress(uuid) to service_role;

insert into public.v9_shadow_benchmark_runs(
  benchmark_name,started_at,target_conversations,baseline_conversations,status,transport_locked,external_bot_mode,notes
)
select
  'AIGUKA vs AICAKE · 12 hội thoại từ 14:16 30/07/2026',
  timestamptz '2026-07-30 07:16:00+00',
  12,
  0,
  'active',
  true,
  'AICAKE_ACTIVE',
  jsonb_build_object(
    'timezone','Asia/Bangkok',
    'local_started_at','2026-07-30 14:16:00+07:00',
    'selection','12 unique page_id+sender_id customer conversations after start',
    'aiguka_delivery','shadow_only',
    'aicake_delivery','customer_facing',
    'initial_count',0
  )
where not exists (select 1 from public.v9_shadow_benchmark_runs where status='active');