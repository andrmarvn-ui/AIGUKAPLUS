create or replace function public.v9_ingest_meta_batch(p_events jsonb)
returns jsonb
language plpgsql
set search_path to 'public','aiguka_private','auth','extensions'
as $$
declare
  v_result jsonb;
  v_item jsonb;
  v_event record;
  v_config public.v9_runtime_config%rowtype;
  v_coexistence_mode text;
begin
  if not aiguka_private.v9_bridge_request_allowed() then
    raise exception 'V9_CORE_BRIDGE_UNAUTHORIZED' using errcode='42501';
  end if;

  v_result := aiguka_private.v9_ingest_meta_batch_internal(p_events);
  select * into v_config from public.v9_runtime_config where id=1;

  -- Every newly inserted decision-eligible customer event becomes the sole queued
  -- decision source for the conversation, including contact-capture messages.
  -- Older queued work is cancelled; the newest job waits for debounce and then V10
  -- rebuilds the complete conversation before the AI decides.
  for v_item in
    select value from jsonb_array_elements(coalesce(v_result->'results','[]'::jsonb))
  loop
    if coalesce(v_item->>'status','') <> 'inserted'
       or coalesce((v_item->>'decision_eligible')::boolean,false) is not true
       or coalesce(v_item->>'actor_type','') <> 'customer' then
      continue;
    end if;

    select e.id, e.page_id, e.customer_id, e.source_event_id, e.received_at
      into v_event
    from public.v9_events e
    where e.source_event_id = v_item->>'source_event_id'
    order by e.received_at desc
    limit 1;

    if not found or v_event.customer_id is null then
      continue;
    end if;

    update public.v9_jobs
    set status='cancelled',
        completed_at=now(),
        locked_by=null,
        locked_at=null,
        last_error='merged_into_newer_customer_cluster',
        updated_at=now()
    where page_id=v_event.page_id
      and sender_id=v_event.customer_id
      and job_type='decision_shadow'
      and status='queued'
      and source_event_id <> v_event.source_event_id;

    select coexistence_mode into v_coexistence_mode
    from public.v9_pages
    where page_id=v_event.page_id
    limit 1;

    insert into public.v9_jobs(
      source_event_id,event_id,job_type,dedupe_key,page_id,sender_id,status,
      run_after,payload,created_at,updated_at
    ) values (
      v_event.source_event_id,
      v_event.id,
      'decision_shadow',
      v_event.page_id||':'||v_event.customer_id||':'||v_event.source_event_id,
      v_event.page_id,
      v_event.customer_id,
      'queued',
      greatest(now(), v_event.received_at + make_interval(secs=>coalesce(v_config.debounce_seconds,20))),
      jsonb_build_object(
        'goal',v_config.contact_goal,
        'mode','SHADOW',
        'coexistence_mode',coalesce(v_coexistence_mode,'AICAKE_DISABLED'),
        'source','v10_latest_customer_cluster',
        'merge_all_prior_unanswered_customer_messages',true
      ),
      now(),now()
    )
    on conflict(source_event_id,job_type) do update set
      event_id=excluded.event_id,
      dedupe_key=excluded.dedupe_key,
      page_id=excluded.page_id,
      sender_id=excluded.sender_id,
      status='queued',
      run_after=excluded.run_after,
      payload=coalesce(public.v9_jobs.payload,'{}'::jsonb)||excluded.payload,
      attempts=0,
      locked_by=null,
      locked_at=null,
      completed_at=null,
      last_error=null,
      updated_at=now();
  end loop;

  return v_result;
end;
$$;

comment on function public.v9_ingest_meta_batch(jsonb) is
  'V10 authoritative ingest: every eligible customer message resets one debounced decision job; newest job rebuilds and answers the full customer cluster.';
