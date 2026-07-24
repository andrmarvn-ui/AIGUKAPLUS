create or replace function public.v8_report_v21_enqueue_range(
  p_from date,
  p_to date,
  p_page_id text default '*',
  p_priority smallint default 50,
  p_reason text default 'manual_backfill'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_count integer:=0;
begin
  if p_from is null or p_to is null or p_to<p_from then
    raise exception 'INVALID_REPORT_RANGE';
  end if;
  if p_to-p_from>366 then
    raise exception 'REPORT_RANGE_TOO_LARGE';
  end if;

  insert into public.v8_report_v21_dirty_keys(
    report_date,page_id,reason,priority,status,attempts,available_at,
    locked_at,locked_by,last_error,created_at,updated_at
  )
  select d::date,coalesce(nullif(p_page_id,''),'*'),p_reason,p_priority,
         'pending',0,now(),null,null,null,now(),now()
  from generate_series(p_from,p_to,interval '1 day') d
  on conflict(report_date,page_id) do update set
    reason=excluded.reason,
    priority=least(public.v8_report_v21_dirty_keys.priority,excluded.priority),
    status='pending',attempts=0,available_at=now(),locked_at=null,
    locked_by=null,last_error=null,updated_at=now();
  get diagnostics v_count=row_count;

  return jsonb_build_object(
    'ok',true,'queued',v_count,'from',p_from,'to',p_to,
    'page_id',coalesce(nullif(p_page_id,''),'*'),'reason',p_reason
  );
end;
$function$;

create or replace function public.v8_report_v21_discover_dirty()
returns jsonb
language plpgsql
security definer
set search_path to 'public','extensions'
as $function$
declare
  v_locked boolean:=false;
  v_cutoff timestamptz:=clock_timestamp();
  v_last timestamptz;
  v_count integer:=0;
begin
  select pg_try_advisory_xact_lock(hashtextextended('v8_report_v21_discover_dirty',0))
  into v_locked;
  if not coalesce(v_locked,false) then
    return jsonb_build_object('ok',true,'skipped',true,'reason','discover_already_running');
  end if;

  select coalesce((state_value->>'watermark')::timestamptz,now()-interval '2 hours')
  into v_last
  from public.v8_report_v21_state
  where state_key='source_watermark';
  v_last:=coalesce(v_last,now()-interval '2 hours');

  with changed as (
    select distinct
      (coalesce(
        nullif(c.raw #>> '{pancake,inserted_at}','')::timestamptz,
        nullif(c.raw #>> '{pancake,updated_at}','')::timestamptz,
        c.created_at
      ) at time zone 'Asia/Ho_Chi_Minh')::date report_date,
      c.page_id
    from public.lt_conversation_identities c
    where coalesce(c.updated_at,c.created_at)>v_last
      and coalesce(c.updated_at,c.created_at)<=v_cutoff
      and c.page_id is not null
      and coalesce(
        nullif(c.raw #>> '{pancake,inserted_at}','')::timestamptz,
        nullif(c.raw #>> '{pancake,updated_at}','')::timestamptz,
        c.created_at
      ) is not null

    union

    select distinct
      (coalesce(m.sent_at,m.created_at) at time zone 'Asia/Ho_Chi_Minh')::date,
      m.page_id
    from public.v8_messages_raw m
    where m.created_at>v_last and m.created_at<=v_cutoff
      and m.page_id is not null
      and coalesce(m.sent_at,m.created_at) is not null

    union

    select distinct
      (le.created_at at time zone 'Asia/Ho_Chi_Minh')::date,
      le.page_id
    from public.v8_lead_events le
    where le.created_at>v_last and le.created_at<=v_cutoff
      and le.page_id is not null

    union

    select distinct
      (coalesce(l.first_message_at,l.created_at) at time zone 'Asia/Ho_Chi_Minh')::date,
      f.page_id
    from public.lt_leads l
    join public.v8_report_v21_customer_day_fact f on f.sender_id=l.sender_id
    where coalesce(l.updated_at,l.created_at)>v_last
      and coalesce(l.updated_at,l.created_at)<=v_cutoff
      and f.report_date=(coalesce(l.first_message_at,l.created_at) at time zone 'Asia/Ho_Chi_Minh')::date

    union

    select distinct f.report_date,f.page_id
    from public.v8_customers c
    join public.v8_report_v21_customer_day_fact f
      on f.page_id=c.page_id and f.sender_id=c.sender_id
    where c.lead_state_updated_at>v_last
      and c.lead_state_updated_at<=v_cutoff
      and f.report_date>=(now() at time zone 'Asia/Ho_Chi_Minh')::date-180

    union

    select distinct f.report_date,f.page_id
    from public.v8_customers c
    join public.v8_report_v21_customer_day_fact f
      on f.page_id=c.page_id and f.sender_id=c.sender_id
    where greatest(
      coalesce(c.profile_synced_at,'epoch'::timestamptz),
      coalesce(c.assigned_at,'epoch'::timestamptz)
    )>v_last
      and greatest(
        coalesce(c.profile_synced_at,'epoch'::timestamptz),
        coalesce(c.assigned_at,'epoch'::timestamptz)
      )<=v_cutoff
      and f.report_date>=(now() at time zone 'Asia/Ho_Chi_Minh')::date-30

    union

    select distinct a.insight_date,a.page_id
    from public.v8_ads_daily_insights a
    where coalesce(a.updated_at,a.created_at)>v_last
      and coalesce(a.updated_at,a.created_at)<=v_cutoff
      and a.insight_date is not null and a.page_id is not null

    union

    select distinct f.report_date,f.page_id
    from public.v8_report_v21_customer_day_fact f
    join public.ad_mappings m on m.ad_id=f.ad_id
    where m.updated_at>v_last and m.updated_at<=v_cutoff
      and f.report_date>=(now() at time zone 'Asia/Ho_Chi_Minh')::date-180

    union

    select distinct f.report_date,f.page_id
    from public.v8_report_v21_customer_day_fact f
    join public.v8_meta_page_ad_accounts p on p.page_id=f.page_id
    where p.updated_at>v_last and p.updated_at<=v_cutoff
      and f.ad_account_id is null
      and f.report_date>=(now() at time zone 'Asia/Ho_Chi_Minh')::date-180

    union

    select distinct f.report_date,f.page_id
    from public.v8_report_v21_customer_day_fact f
    join public.v8_meta_ad_accounts a on a.ad_account_id=f.ad_account_id
    where a.updated_at>v_last and a.updated_at<=v_cutoff
      and f.report_date>=(now() at time zone 'Asia/Ho_Chi_Minh')::date-180
  )
  insert into public.v8_report_v21_dirty_keys(
    report_date,page_id,reason,priority,status,attempts,available_at,
    locked_at,locked_by,last_error,created_at,updated_at
  )
  select report_date,page_id,'source_changed',20,'pending',0,now(),
         null,null,null,now(),now()
  from changed
  where report_date is not null and page_id is not null
  on conflict(report_date,page_id) do update set
    reason='source_changed',
    priority=least(public.v8_report_v21_dirty_keys.priority,20),
    status='pending',attempts=0,available_at=now(),locked_at=null,
    locked_by=null,last_error=null,updated_at=now();
  get diagnostics v_count=row_count;

  insert into public.v8_report_v21_state(state_key,state_value,updated_at)
  values('source_watermark',jsonb_build_object('watermark',v_cutoff),now())
  on conflict(state_key) do update set
    state_value=excluded.state_value,updated_at=now();

  return jsonb_build_object(
    'ok',true,'skipped',false,'queued',v_count,
    'from_watermark',v_last,'to_watermark',v_cutoff
  );
end;
$function$;

create or replace function public.v8_report_v21_process_dirty(
  p_limit integer default 3,
  p_worker_name text default 'report-v21-db-worker'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','extensions'
as $function$
declare
  v_locked boolean:=false;
  v_limit integer:=least(greatest(coalesce(p_limit,3),1),20);
  v_processed integer:=0;
  v_failed integer:=0;
  v_result jsonb;
  r record;
begin
  select pg_try_advisory_xact_lock(hashtextextended('v8_report_v21_process_dirty',0))
  into v_locked;
  if not coalesce(v_locked,false) then
    return jsonb_build_object('ok',true,'skipped',true,'reason','worker_already_running');
  end if;

  update public.v8_report_v21_dirty_keys
  set status='retry',available_at=now(),locked_at=null,locked_by=null,
      last_error=coalesce(last_error,'STALE_PROCESSING_LOCK'),updated_at=now()
  where status='processing' and locked_at<now()-interval '5 minutes';

  for r in
    with candidates as (
      select report_date,page_id
      from public.v8_report_v21_dirty_keys
      where status in ('pending','retry') and available_at<=now()
      order by priority,available_at,created_at
      for update skip locked
      limit v_limit
    ), claimed as (
      update public.v8_report_v21_dirty_keys q
      set status='processing',attempts=q.attempts+1,locked_at=now(),
          locked_by=p_worker_name,updated_at=now()
      from candidates c
      where q.report_date=c.report_date and q.page_id=c.page_id
      returning q.*
    )
    select * from claimed order by priority,available_at,created_at
  loop
    begin
      v_result:=public.v8_report_v21_refresh_day(
        r.report_date,case when r.page_id='*' then null else r.page_id end
      );
      update public.v8_report_v21_dirty_keys
      set status='completed',locked_at=null,locked_by=null,last_error=null,updated_at=now()
      where report_date=r.report_date and page_id=r.page_id;
      v_processed:=v_processed+1;
    exception when others then
      update public.v8_report_v21_dirty_keys
      set status=case when attempts>=5 then 'dead_letter' else 'retry' end,
          available_at=case
            when attempts>=5 then now()+interval '365 days'
            else now()+least(attempts,5)*interval '1 minute' end,
          locked_at=null,locked_by=null,
          last_error=left(sqlstate||':'||sqlerrm,500),updated_at=now()
      where report_date=r.report_date and page_id=r.page_id;
      v_failed:=v_failed+1;
    end;
  end loop;

  return jsonb_build_object(
    'ok',true,'skipped',false,'processed',v_processed,'failed',v_failed,
    'pending',(select count(*) from public.v8_report_v21_dirty_keys where status in ('pending','retry','processing')),
    'dead_letter',(select count(*) from public.v8_report_v21_dirty_keys where status='dead_letter')
  );
end;
$function$;

create or replace function public.v8_report_v21_tick(p_limit integer default 3)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_discover jsonb;v_process jsonb;
begin
  v_discover:=public.v8_report_v21_discover_dirty();
  v_process:=public.v8_report_v21_process_dirty(p_limit,'report-v21-tick');
  return jsonb_build_object(
    'ok',true,'checked_at',now(),'discover',v_discover,'process',v_process
  );
end;
$function$;

create or replace function public.v8_report_v21_status()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
select jsonb_build_object(
  'generated_at',now(),
  'fact_version',21,
  'conversation_rows',(select count(*) from public.v8_report_v21_conversation_fact),
  'conversation_fact_ready',coalesce((
    select (state_value->>'ready')::boolean
    from public.v8_report_v21_state
    where state_key='conversation_fact_readiness'
  ),false),
  'customer_day_rows',(select count(*) from public.v8_report_v21_customer_day_fact),
  'ad_day_rows',(select count(*) from public.v8_report_v21_ad_day_fact),
  'referral_rows',(select count(*) from public.v8_report_v21_referral_fact),
  'pending_keys',(select count(*) from public.v8_report_v21_dirty_keys where status in ('pending','retry','processing')),
  'dead_letter_keys',(select count(*) from public.v8_report_v21_dirty_keys where status='dead_letter'),
  'oldest_pending_at',(
    select min(created_at) from public.v8_report_v21_dirty_keys
    where status in ('pending','retry','processing')
  ),
  'latest_fact_at',(select max(refreshed_at) from public.v8_report_v21_customer_day_fact),
  'latest_ads_fact_at',(select max(refreshed_at) from public.v8_report_v21_ad_day_fact),
  'latest_source_watermark',(
    select state_value->>'watermark' from public.v8_report_v21_state
    where state_key='source_watermark'
  ),
  'healthy',(
    (select count(*)=0 from public.v8_report_v21_dirty_keys where status='dead_letter')
    and
    (select coalesce(min(created_at)>now()-interval '5 minutes',true)
     from public.v8_report_v21_dirty_keys
     where status in ('pending','retry','processing'))
  )
);
$function$;

revoke all on function public.v8_report_v21_enqueue_range(date,date,text,smallint,text) from public;
revoke all on function public.v8_report_v21_discover_dirty() from public;
revoke all on function public.v8_report_v21_process_dirty(integer,text) from public;
revoke all on function public.v8_report_v21_tick(integer) from public;
revoke all on function public.v8_report_v21_status() from public;

grant execute on function public.v8_report_v21_enqueue_range(date,date,text,smallint,text) to service_role;
grant execute on function public.v8_report_v21_discover_dirty() to service_role;
grant execute on function public.v8_report_v21_process_dirty(integer,text) to service_role;
grant execute on function public.v8_report_v21_tick(integer) to service_role;
