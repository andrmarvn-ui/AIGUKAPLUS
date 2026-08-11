-- One conversation may have many producers, but exactly one transport owner at a time.
-- The table is intentionally inaccessible through the Data API; callers use the two
-- bridge-authorized SECURITY DEFINER functions below.
create table if not exists public.v10_message_dispatch (
  page_id text not null,
  sender_id text not null,
  owner text not null check (owner in ('aiguka_live','aiguka_followup')),
  dedupe_key text not null,
  priority smallint not null default 0,
  lease_expires_at timestamptz not null,
  claimed_at timestamptz not null default now(),
  released_at timestamptz,
  last_result text,
  updated_at timestamptz not null default now(),
  primary key (page_id, sender_id)
);

create index if not exists v10_message_dispatch_lease_idx
  on public.v10_message_dispatch(lease_expires_at)
  where released_at is null;

alter table public.v10_message_dispatch enable row level security;
revoke all on table public.v10_message_dispatch from public, anon, authenticated;
grant select, insert, update, delete on table public.v10_message_dispatch to service_role;

create or replace function public.v10_claim_message_dispatch(
  p_page_id text,
  p_sender_id text,
  p_owner text,
  p_dedupe_key text,
  p_priority integer default 0,
  p_lease_seconds integer default 90
) returns table(
  granted boolean,
  current_owner text,
  current_dedupe_key text,
  lease_expires_at timestamptz,
  reason text
)
language plpgsql
security definer
set search_path to 'public','aiguka_private','auth','extensions'
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_lease_seconds integer := greatest(15, least(300, coalesce(p_lease_seconds,90)));
  v_row public.v10_message_dispatch%rowtype;
begin
  if not aiguka_private.v9_bridge_request_allowed() then
    raise exception 'V10_MESSAGE_GATEWAY_UNAUTHORIZED' using errcode='42501';
  end if;
  if nullif(btrim(p_page_id),'') is null
     or nullif(btrim(p_sender_id),'') is null
     or nullif(btrim(p_dedupe_key),'') is null
     or p_owner not in ('aiguka_live','aiguka_followup') then
    raise exception 'V10_MESSAGE_GATEWAY_ARGUMENT_INVALID' using errcode='22023';
  end if;

  -- A scheduled follow-up must never begin while a normal live decision for the same
  -- customer is waiting or recovering. Live delivery is always the higher priority.
  if p_owner='aiguka_followup' and exists (
    select 1
    from public.v9_decisions d
    where d.page_id=p_page_id
      and d.sender_id=p_sender_id
      and coalesce(d.goal,'') <> 'follow_up_reengagement'
      and d.status in ('shadow_ai_completed','live_delivery_processing','live_delivery_failed')
      and d.created_at > v_now - interval '2 hours'
  ) then
    return query select false, 'aiguka_live'::text, null::text, null::timestamptz, 'LIVE_DECISION_PENDING'::text;
    return;
  end if;

  insert into public.v10_message_dispatch(
    page_id,sender_id,owner,dedupe_key,priority,lease_expires_at,claimed_at,released_at,last_result,updated_at
  ) values (
    p_page_id,p_sender_id,p_owner,p_dedupe_key,coalesce(p_priority,0),
    v_now + make_interval(secs=>v_lease_seconds),v_now,null,null,v_now
  ) on conflict(page_id,sender_id) do nothing;

  select * into v_row
  from public.v10_message_dispatch
  where page_id=p_page_id and sender_id=p_sender_id
  for update;

  if v_row.owner=p_owner and v_row.dedupe_key=p_dedupe_key then
    update public.v10_message_dispatch
    set lease_expires_at=v_now + make_interval(secs=>v_lease_seconds),
        released_at=null,
        priority=coalesce(p_priority,0),
        updated_at=v_now
    where page_id=p_page_id and sender_id=p_sender_id
    returning * into v_row;
    return query select true,v_row.owner,v_row.dedupe_key,v_row.lease_expires_at,'CLAIM_RENEWED'::text;
    return;
  end if;

  if v_row.released_at is not null or v_row.lease_expires_at <= v_now then
    update public.v10_message_dispatch
    set owner=p_owner,
        dedupe_key=p_dedupe_key,
        priority=coalesce(p_priority,0),
        lease_expires_at=v_now + make_interval(secs=>v_lease_seconds),
        claimed_at=v_now,
        released_at=null,
        last_result=null,
        updated_at=v_now
    where page_id=p_page_id and sender_id=p_sender_id
    returning * into v_row;
    return query select true,v_row.owner,v_row.dedupe_key,v_row.lease_expires_at,'CLAIM_ACQUIRED'::text;
    return;
  end if;

  return query select false,v_row.owner,v_row.dedupe_key,v_row.lease_expires_at,'LEASE_BUSY'::text;
end;
$$;

create or replace function public.v10_release_message_dispatch(
  p_page_id text,
  p_sender_id text,
  p_owner text,
  p_dedupe_key text,
  p_result text default 'released'
) returns table(released boolean)
language plpgsql
security definer
set search_path to 'public','aiguka_private','auth','extensions'
as $$
begin
  if not aiguka_private.v9_bridge_request_allowed() then
    raise exception 'V10_MESSAGE_GATEWAY_UNAUTHORIZED' using errcode='42501';
  end if;

  update public.v10_message_dispatch
  set released_at=clock_timestamp(),
      lease_expires_at=clock_timestamp(),
      last_result=left(coalesce(p_result,'released'),120),
      updated_at=clock_timestamp()
  where page_id=p_page_id
    and sender_id=p_sender_id
    and owner=p_owner
    and dedupe_key=p_dedupe_key
    and released_at is null;

  return query select found;
end;
$$;

revoke all on function public.v10_claim_message_dispatch(text,text,text,text,integer,integer) from public;
revoke all on function public.v10_release_message_dispatch(text,text,text,text,text) from public;
revoke all on function public.v10_claim_message_dispatch(text,text,text,text,integer,integer) from authenticated;
revoke all on function public.v10_release_message_dispatch(text,text,text,text,text) from authenticated;
grant execute on function public.v10_claim_message_dispatch(text,text,text,text,integer,integer) to anon,service_role;
grant execute on function public.v10_release_message_dispatch(text,text,text,text,text) to anon,service_role;

comment on table public.v10_message_dispatch is
  'Single Message Gateway lease: prevents live AIGUKA, support recovery and event follow-up from sending concurrently to one conversation.';
comment on function public.v10_claim_message_dispatch(text,text,text,text,integer,integer) is
  'Atomic bridge-authorized conversation transport claim; live work blocks lower-priority follow-up work.';

select pg_notify('pgrst','reload schema');
