-- V10: a newly captured phone must continue through the AI decision pipeline so
-- the customer receives one acknowledgement. Duplicate phones do not fire this
-- trigger because v9_contacts uses ON CONFLICT DO NOTHING before this point.

create or replace function aiguka_private.v10_enqueue_new_contact_ack_job()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_event public.v9_events%rowtype;
  v_config public.v9_runtime_config%rowtype;
  v_page_mode text;
  v_coexistence_mode text;
begin
  if new.contact_type <> 'phone' or new.source_event_id is null then
    return new;
  end if;

  select *
  into v_event
  from public.v9_events
  where source_event_id = new.source_event_id
    and page_id = new.page_id
    and customer_id = new.customer_id
    and actor_type = 'customer'
  order by created_at desc
  limit 1;

  if not found then
    return new;
  end if;

  select * into v_config
  from public.v9_runtime_config
  where id = 1;

  if not found
     or v_config.mode not in ('ACTIVE', 'SHADOW')
     or v_config.ingest_mode <> 'DIRECT_CORE' then
    return new;
  end if;

  select operating_mode, coexistence_mode
  into v_page_mode, v_coexistence_mode
  from public.v9_pages
  where page_id = new.page_id
    and is_active
  limit 1;

  if not found or v_page_mode = 'OFF' then
    return new;
  end if;

  insert into public.v9_jobs(
    source_event_id,
    event_id,
    job_type,
    dedupe_key,
    page_id,
    sender_id,
    status,
    run_after,
    payload,
    created_at,
    updated_at
  ) values (
    new.source_event_id,
    v_event.id,
    'decision_shadow',
    new.page_id || ':' || new.customer_id || ':' || new.source_event_id || ':contact_ack',
    new.page_id,
    new.customer_id,
    'queued',
    now(),
    jsonb_build_object(
      'goal', 'acknowledge_contact',
      'mode', 'SHADOW',
      'coexistence_mode', v_coexistence_mode,
      'source', 'new_contact_capture_trigger',
      'contact_type', new.contact_type
    ),
    now(),
    now()
  )
  on conflict(source_event_id, job_type) do nothing;

  return new;
end;
$$;

drop trigger if exists v10_enqueue_new_contact_ack_job on public.v9_contacts;
create trigger v10_enqueue_new_contact_ack_job
after insert on public.v9_contacts
for each row
execute function aiguka_private.v10_enqueue_new_contact_ack_job();
