drop index if exists public.v10_followup_events_event_no_key;

alter table public.v10_followup_events
  add constraint v10_followup_events_event_no_key
  unique (event_no)
  deferrable initially immediate;

create or replace function public.v10_upsert_followup_event(
  p_event jsonb,
  p_updated_by text default 'followup_admin_event_safe_v5'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_id uuid;
  v_event_no integer;
  v_old_no integer;
  v_count integer;
  v_conflict_id uuid;
  v_name text;
  v_message text;
  v_wait integer;
  v_images jsonb;
  v_pages text[];
  v_enabled boolean;
  v_saved public.v10_followup_events%rowtype;
  v_enabled_count integer;
begin
  if p_event is null or jsonb_typeof(p_event) <> 'object' then
    raise exception 'FOLLOWUP_EVENT_OBJECT_REQUIRED';
  end if;

  begin
    v_id := nullif(p_event->>'id','')::uuid;
  exception when invalid_text_representation then
    raise exception 'FOLLOWUP_EVENT_ID_INVALID';
  end;

  lock table public.v10_followup_events in share row exclusive mode;
  set constraints v10_followup_events_event_no_key deferred;

  select count(*)::integer into v_count
  from public.v10_followup_events;

  v_event_no := coalesce(
    nullif(p_event->>'event_no','')::integer,
    v_count + 1
  );

  if v_id is not null and exists(
    select 1 from public.v10_followup_events where id = v_id
  ) then
    v_event_no := greatest(1, least(greatest(v_count, 1), v_event_no));
  else
    if v_count >= 20 then
      raise exception 'FOLLOWUP_EVENT_LIMIT_20';
    end if;
    v_event_no := greatest(1, least(v_count + 1, v_event_no));
  end if;

  v_name := coalesce(nullif(btrim(p_event->>'event_name'), ''), 'Event ' || v_event_no::text);
  v_message := btrim(coalesce(p_event->>'message_text', ''));
  v_wait := coalesce(
    nullif(p_event->>'wait_minutes','')::integer,
    case when v_event_no = 1 then 180 else 360 end
  );
  v_images := coalesce(p_event->'image_urls', '[]'::jsonb);
  v_enabled := coalesce((p_event->>'enabled')::boolean, true);

  if length(v_message) < 1 or length(v_message) > 2000 then
    raise exception 'FOLLOWUP_EVENT_MESSAGE_INVALID';
  end if;
  if v_wait not between 15 and 1200 then
    raise exception 'FOLLOWUP_EVENT_WAIT_INVALID';
  end if;
  if jsonb_typeof(v_images) <> 'array' then
    raise exception 'FOLLOWUP_EVENT_IMAGES_ARRAY_REQUIRED';
  end if;
  if jsonb_array_length(v_images) > 10 then
    raise exception 'FOLLOWUP_EVENT_IMAGES_LIMIT_10';
  end if;
  if coalesce(jsonb_typeof(p_event->'page_ids'), 'array') <> 'array' then
    raise exception 'FOLLOWUP_EVENT_PAGES_ARRAY_REQUIRED';
  end if;

  select coalesce(array_agg(value), '{}'::text[])
  into v_pages
  from jsonb_array_elements_text(coalesce(p_event->'page_ids', '[]'::jsonb));

  if v_id is not null and exists(
    select 1 from public.v10_followup_events where id = v_id
  ) then
    select event_no into v_old_no
    from public.v10_followup_events
    where id = v_id
    for update;

    if v_old_no <> v_event_no then
      select id into v_conflict_id
      from public.v10_followup_events
      where event_no = v_event_no
        and id <> v_id
      for update;

      if v_conflict_id is not null then
        update public.v10_followup_events
        set event_no = v_old_no,
            apply_followup_no = v_old_no,
            sort_order = v_old_no * 100,
            updated_by = p_updated_by,
            updated_at = now()
        where id = v_conflict_id;
      end if;
    end if;

    update public.v10_followup_events
    set event_name = left(v_name, 160),
        message_text = v_message,
        image_urls = v_images,
        page_ids = v_pages,
        enabled = v_enabled,
        event_no = v_event_no,
        apply_followup_no = v_event_no,
        wait_minutes = v_wait,
        sort_order = v_event_no * 100,
        updated_by = p_updated_by,
        updated_at = now()
    where id = v_id
    returning * into v_saved;
  else
    update public.v10_followup_events
    set event_no = event_no + 1,
        apply_followup_no = event_no + 1,
        sort_order = (event_no + 1) * 100,
        updated_by = p_updated_by,
        updated_at = now()
    where event_no >= v_event_no;

    insert into public.v10_followup_events(
      event_name, message_text, image_urls, page_ids, enabled,
      event_no, apply_followup_no, wait_minutes, sort_order,
      updated_by, created_at, updated_at
    ) values (
      left(v_name, 160), v_message, v_images, v_pages, v_enabled,
      v_event_no, v_event_no, v_wait, v_event_no * 100,
      p_updated_by, now(), now()
    )
    returning * into v_saved;
  end if;

  set constraints v10_followup_events_event_no_key immediate;

  select count(*)::integer into v_enabled_count
  from public.v10_followup_events
  where enabled;

  update public.v10_followup_config
  set max_followups_per_cycle = greatest(1, least(20, v_enabled_count))::smallint,
      last_scan_at = null,
      updated_by = p_updated_by,
      updated_at = now()
  where id = 1 and mode = 'event';

  return jsonb_build_object('ok', true, 'event', to_jsonb(v_saved));
end;
$function$;
