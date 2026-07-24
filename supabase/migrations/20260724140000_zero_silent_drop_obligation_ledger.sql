-- Every actionable customer turn creates a durable response obligation.
-- A turn is terminal only after bot delivery, a human/external response,
-- an explicit low-value/opt-out decision, or a newer customer turn.

create table if not exists public.v8_response_obligations (
  id uuid primary key default gen_random_uuid(),
  page_id text not null,
  sender_id text not null,
  customer_id uuid,
  message_row_id uuid,
  message_id text not null,
  inbound_at timestamptz not null,
  inbound_text text,
  source_system text,
  obligation_status text not null default 'received',
  is_resolved boolean not null default false,
  resolution_code text,
  resolution_details jsonb not null default '{}'::jsonb,
  ai_request_id uuid,
  ai_decision_id uuid,
  reply_plan_id uuid,
  outbound_id uuid,
  rescue_attempts integer not null default 0,
  next_check_at timestamptz not null default now(),
  last_error text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(page_id,message_id)
);

create index if not exists idx_v8_response_obligations_unresolved
  on public.v8_response_obligations(next_check_at,inbound_at)
  where not is_resolved;
create index if not exists idx_v8_response_obligations_customer
  on public.v8_response_obligations(page_id,sender_id,inbound_at desc);
create index if not exists idx_v8_ai_requests_sender_created
  on public.v8_ai_brain_requests(page_id,sender_id,created_at desc);
create index if not exists idx_v8_ai_decisions_delivery_watch
  on public.v8_ai_decisions(status,completed_at,created_at)
  where status in ('completed','error','revision_required');
create index if not exists idx_v8_outbound_ai_status
  on public.v8_outbound_queue(ai_decision_id,status,created_at desc)
  where ai_decision_id is not null;

create or replace function public.v8_obligation_is_low_value(
  p_text text,
  p_attachments jsonb default '[]'::jsonb
)
returns boolean
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v_text text:=btrim(coalesce(p_text,''));
  v_norm text:=public.v8_normalize_detector_text(coalesce(p_text,''));
begin
  if coalesce(jsonb_array_length(coalesce(p_attachments,'[]'::jsonb)),0)>0 then
    return false;
  end if;
  if v_text='' then return true; end if;
  if v_norm in ('ok','oke','okay','cam on','thanks','thank you','vang','da','uh','um') then
    return true;
  end if;
  if regexp_replace(v_text,'\s','','g') ~ '^[.!?,…❤❤️👍]+$' then return true; end if;
  return false;
end;
$function$;

create or replace function public.v8_track_response_obligation_from_message()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_low boolean:=false;
  v_human boolean:=false;
  v_bot boolean:=false;
  v_external boolean:=false;
  v_obligation_id uuid;
begin
  if new.direction='inbound' and coalesce(new.actor_type,'customer')='customer' then
    -- History sync may touch months-old rows. Those rows remain reportable but
    -- must never reopen live Messenger delivery work.
    if new.sent_at<now()-interval '48 hours' then
      update public.v8_response_obligations
      set obligation_status='resolved_archived_history',
          is_resolved=true,
          resolution_code='HISTORY_TOO_OLD_FOR_DELIVERY',
          resolved_at=coalesce(resolved_at,now()),
          updated_at=now()
      where page_id=new.page_id and message_id=new.message_id and not is_resolved;
      return new;
    end if;

    v_low:=public.v8_obligation_is_low_value(new.message_text,new.attachments);
    insert into public.v8_response_obligations(
      page_id,sender_id,customer_id,message_row_id,message_id,inbound_at,
      inbound_text,source_system,obligation_status,is_resolved,resolution_code,
      resolution_details,next_check_at,updated_at
    ) values(
      new.page_id,new.sender_id,new.customer_id,new.id,new.message_id,new.sent_at,
      new.message_text,new.source_system,
      case when v_low then 'resolved_low_value' else 'received' end,
      v_low,
      case when v_low then 'LOW_VALUE_TURN' else null end,
      jsonb_build_object('source','message_trigger','tracked_at',now()),
      case when v_low then now()+interval '365 days' else now()+interval '15 seconds' end,
      now()
    )
    on conflict(page_id,message_id) do update set
      sender_id=excluded.sender_id,
      customer_id=coalesce(excluded.customer_id,public.v8_response_obligations.customer_id),
      message_row_id=coalesce(excluded.message_row_id,public.v8_response_obligations.message_row_id),
      inbound_at=excluded.inbound_at,
      inbound_text=excluded.inbound_text,
      source_system=excluded.source_system,
      obligation_status=case
        when public.v8_response_obligations.is_resolved
          then public.v8_response_obligations.obligation_status
        else excluded.obligation_status end,
      is_resolved=case
        when public.v8_response_obligations.is_resolved then true
        else excluded.is_resolved end,
      resolution_code=case
        when public.v8_response_obligations.is_resolved
          then public.v8_response_obligations.resolution_code
        else excluded.resolution_code end,
      resolution_details=coalesce(public.v8_response_obligations.resolution_details,'{}'::jsonb)
        || excluded.resolution_details,
      next_check_at=case
        when public.v8_response_obligations.is_resolved
          then public.v8_response_obligations.next_check_at
        else excluded.next_check_at end,
      updated_at=now()
    returning id into v_obligation_id;

    update public.v8_response_obligations o
    set obligation_status='resolved_superseded',
        is_resolved=true,
        resolution_code='NEWER_CUSTOMER_TURN',
        resolution_details=coalesce(o.resolution_details,'{}'::jsonb)
          || jsonb_build_object('superseded_by_message_id',new.message_id,'superseded_at',now()),
        resolved_at=now(),
        updated_at=now()
    where o.page_id=new.page_id
      and o.sender_id=new.sender_id
      and not o.is_resolved
      and o.message_id<>new.message_id
      and o.inbound_at<new.sent_at;
    return new;
  end if;

  if new.direction='outbound' then
    v_bot:=coalesce(new.source_system,'') in ('aiguka','aiguka_v8')
      or coalesce(new.actor_type,'') in ('bot','aiguka');
    v_human:=public.v8_is_confirmed_human_outbound(
      new.source_system,new.message_text,new.attachments,new.is_automatic,
      new.actor_type,new.source_detail,new.actor_app_id
    );
    v_external:=public.v8_is_actionable_external_outbound(
      new.source_system,new.message_text,new.attachments,new.is_automatic,
      new.actor_type,new.source_detail
    );

    if v_bot or v_human or v_external then
      select o.id into v_obligation_id
      from public.v8_response_obligations o
      where o.page_id=new.page_id
        and o.sender_id=new.sender_id
        and not o.is_resolved
        and o.inbound_at<=new.sent_at
        and not exists(
          select 1 from public.v8_messages_raw ni
          where ni.page_id=o.page_id
            and ni.sender_id=o.sender_id
            and ni.direction='inbound'
            and coalesce(ni.actor_type,'customer')='customer'
            and ni.sent_at>o.inbound_at
            and ni.sent_at<=new.sent_at
        )
      order by o.inbound_at desc,o.created_at desc
      limit 1
      for update;

      if v_obligation_id is not null then
        update public.v8_response_obligations
        set obligation_status=case
              when v_bot then 'resolved_sent'
              when v_human then 'resolved_human'
              else 'resolved_external' end,
            is_resolved=true,
            resolution_code=case
              when v_bot then 'BOT_DELIVERED'
              when v_human then 'HUMAN_REPLIED'
              else 'EXTERNAL_RESPONDER_REPLIED' end,
            resolution_details=coalesce(resolution_details,'{}'::jsonb)
              || jsonb_build_object(
                'outbound_message_id',new.message_id,
                'outbound_source',new.source_system,
                'outbound_actor',new.actor_type,
                'outbound_at',new.sent_at
              ),
            resolved_at=now(),
            updated_at=now(),
            last_error=null
        where id=v_obligation_id;
      end if;
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_v8_track_response_obligation on public.v8_messages_raw;
create trigger trg_v8_track_response_obligation
after insert or update of direction,actor_type,source_system,sent_at,message_text,attachments
on public.v8_messages_raw
for each row execute function public.v8_track_response_obligation_from_message();

insert into public.v8_response_obligations(
  page_id,sender_id,customer_id,message_row_id,message_id,inbound_at,
  inbound_text,source_system,obligation_status,is_resolved,resolution_code,
  resolution_details,next_check_at
)
select m.page_id,m.sender_id,m.customer_id,m.id,m.message_id,m.sent_at,
       m.message_text,m.source_system,
       case when public.v8_obligation_is_low_value(m.message_text,m.attachments)
         then 'resolved_low_value' else 'received' end,
       public.v8_obligation_is_low_value(m.message_text,m.attachments),
       case when public.v8_obligation_is_low_value(m.message_text,m.attachments)
         then 'LOW_VALUE_TURN' else null end,
       jsonb_build_object('source','migration_backfill','backfilled_at',now()),
       now()
from public.v8_messages_raw m
where m.direction='inbound'
  and coalesce(m.actor_type,'customer')='customer'
  and m.sent_at>=now()-interval '48 hours'
on conflict(page_id,message_id) do nothing;
