-- Fresh Meta history can represent a missed live webhook.
-- Enqueue only bounded-lag rows and route them through the normal model worker.

update public.v8_config_hub
set value=coalesce(value,'{}'::jsonb)||jsonb_build_object(
      'fresh_history_inbound_is_live',true,
      'fresh_history_max_lag_minutes',45,
      'fresh_history_requires_no_live_duplicate',true,
      'fresh_history_ai_authority','model_runtime',
      'updated_at',now()
    ),
    updated_at=now()
where scope='conversation' and key='follow_up_policy';

create or replace function public.v8_enqueue_ai_brain_from_live_inbound()
returns trigger
language plpgsql
security definer
set search_path='public'
as $function$
declare
  v_request_id uuid;
  v_cluster_start timestamptz;
  v_cluster_size integer:=1;
  v_cluster_message_ids jsonb:='[]'::jsonb;
  v_requested_by text;
  v_cfg jsonb:='{}'::jsonb;
  v_debounce_seconds integer:=15;
  v_cluster_seconds integer:=30;
  v_allow_fresh_history boolean:=false;
  v_fresh_history_max_lag integer:=45;
begin
  if new.direction<>'inbound' then return new; end if;
  if coalesce(new.actor_type,'customer')<>'customer' then return new; end if;
  if coalesce(new.source_system,'') not in ('meta_customer','meta_customer_history') then return new; end if;
  if coalesce(nullif(trim(new.message_text),''),'')=''
     and coalesce(jsonb_array_length(coalesce(new.attachments,'[]'::jsonb)),0)=0 then return new; end if;
  if not exists(
    select 1 from public.v8_ai_brain_runtime r
    where r.page_id=new.page_id and r.mode<>'OFF'
  ) then return new; end if;

  select value into v_cfg
  from public.v8_config_hub
  where scope='conversation' and key='follow_up_policy' and is_active
  order by updated_at desc limit 1;
  v_cfg:=coalesce(v_cfg,'{}'::jsonb);
  v_debounce_seconds:=least(greatest(coalesce((v_cfg->>'rapid_turn_debounce_seconds')::integer,15),5),30);
  v_cluster_seconds:=least(greatest(coalesce((v_cfg->>'rapid_turn_cluster_seconds')::integer,30),10),60);
  v_allow_fresh_history:=coalesce((v_cfg->>'fresh_history_inbound_is_live')::boolean,false);
  v_fresh_history_max_lag:=least(greatest(coalesce((v_cfg->>'fresh_history_max_lag_minutes')::integer,45),5),60);

  if new.source_system='meta_customer' then
    if new.sent_at<now()-interval '3 minutes' then return new; end if;
  else
    if not v_allow_fresh_history then return new; end if;
    if new.sent_at is null
       or new.sent_at<now()-make_interval(mins=>v_fresh_history_max_lag)
       or coalesce(new.created_at,now())>new.sent_at+make_interval(mins=>v_fresh_history_max_lag) then
      return new;
    end if;
    if exists(
      select 1 from public.v8_messages_raw live
      where live.page_id=new.page_id
        and live.message_id=new.message_id
        and live.source_system='meta_customer'
    ) then return new; end if;
  end if;

  select min(m.sent_at),count(*)::integer,
         coalesce(jsonb_agg(m.message_id order by m.sent_at,m.created_at,m.id),'[]'::jsonb)
  into v_cluster_start,v_cluster_size,v_cluster_message_ids
  from public.v8_messages_raw m
  where m.page_id=new.page_id
    and m.sender_id=new.sender_id
    and m.direction='inbound'
    and coalesce(m.actor_type,'customer')='customer'
    and m.sent_at between new.sent_at-make_interval(secs=>v_cluster_seconds) and new.sent_at+interval '2 seconds';

  update public.v8_ai_brain_requests r
  set status='skipped',
      completed_at=now(),
      dispatch_locked_at=null,
      dispatch_locked_by=null,
      last_error='superseded_by_newer_customer_turn',
      dispatch_details=coalesce(r.dispatch_details,'{}'::jsonb)||jsonb_build_object(
        'superseded_by_message_id',new.message_id,
        'superseded_at',now(),
        'turn_cluster_start_at',v_cluster_start,
        'turn_cluster_size',v_cluster_size,
        'quota_guard_version','quota_guard_v1_20260723'
      )
  where r.page_id=new.page_id
    and r.sender_id=new.sender_id
    and r.message_id<>new.message_id
    and r.requested_by<>'follow_up_scan'
    and r.status in ('pending','error')
    and r.decision_id is null
    and r.created_at>=now()-interval '5 minutes';

  v_requested_by:=case
    when new.source_system='meta_customer_history' then 'monitor_recovery_latest_turn'
    else 'live_inbound_debounced'
  end;

  v_request_id:=public.v8_enqueue_ai_brain_request(
    new.page_id,new.sender_id,new.message_id,v_requested_by
  );

  update public.v8_ai_brain_requests
  set status=case when status in ('error','skipped') then 'pending' else status end,
      dispatch_locked_at=null,
      dispatch_locked_by=null,
      completed_at=case when status in ('error','skipped') then null else completed_at end,
      last_error=case when status in ('error','skipped') then null else last_error end,
      requested_by=v_requested_by,
      dispatch_details=coalesce(dispatch_details,'{}'::jsonb)||jsonb_build_object(
        'not_before',now()+make_interval(secs=>v_debounce_seconds),
        'turn_cluster_start_at',coalesce(v_cluster_start,new.sent_at),
        'turn_cluster_size',coalesce(v_cluster_size,1),
        'turn_cluster_message_ids',coalesce(v_cluster_message_ids,'[]'::jsonb),
        'turn_aggregation_mode','rapid_inbound_cumulative_v2',
        'source_system',new.source_system,
        'latest_message_id',new.message_id,
        'debounce_seconds',v_debounce_seconds,
        'cluster_seconds',v_cluster_seconds,
        'fresh_history_recovery',new.source_system='meta_customer_history',
        'fresh_history_max_lag_minutes',v_fresh_history_max_lag,
        'quota_guard_version','quota_guard_v1_20260723'
      )
  where id=v_request_id and decision_id is null;

  return new;
end;
$function$;