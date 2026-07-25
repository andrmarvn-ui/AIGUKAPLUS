-- Keep the deterministic zero-token address fast path synchronized with the
-- production AI context. This prevents quota optimization from overriding
-- newly edited showroom locations with a single hard-coded address.

create or replace function public.v8_extract_showroom_locations_from_context(p_content text)
returns jsonb
language sql
immutable
set search_path='public'
as $function$
  with lines as (
    select
      ordinality as ord,
      btrim(regexp_replace(line, '^[[:space:]]*[-•][[:space:]]*', '')) as clean_line
    from regexp_split_to_table(coalesce(p_content,''), E'\\r?\\n')
         with ordinality as t(line, ordinality)
  ), locations as (
    select ord, clean_line
    from lines
    where public.v8_normalize_detector_text(clean_line) ~ '^co so (chinh|[0-9]+)'
  )
  select coalesce(jsonb_agg(clean_line order by ord), '[]'::jsonb)
  from locations;
$function$;

create or replace function public.v8_apply_showroom_locations_from_context(
  p_context_key text,
  p_content text,
  p_context_updated_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path='public'
as $function$
declare
  v_locations jsonb:='[]'::jsonb;
  v_address_text text;
begin
  v_locations:=public.v8_extract_showroom_locations_from_context(p_content);

  -- Do not replace a valid profile with an incomplete/accidental context edit.
  if jsonb_array_length(v_locations)<2 then
    return false;
  end if;

  select E'các cơ sở:\n- '||string_agg(value, E'\n- ' order by ord)
    into v_address_text
  from jsonb_array_elements_text(v_locations) with ordinality as x(value,ord);

  insert into public.v8_config_hub(
    scope,key,value,description,is_active,updated_at
  ) values (
    'business',
    'showroom_contact_profile',
    jsonb_build_object(
      'address',v_address_text,
      'locations',v_locations,
      'multi_location_enabled',true,
      'source_context_key',p_context_key,
      'source_context_updated_at',coalesce(p_context_updated_at,now()),
      'synced_at',now()
    ),
    'Thông tin liên hệ và danh sách cơ sở showroom; tự đồng bộ từ ngữ cảnh production.',
    true,
    now()
  )
  on conflict(scope,key) do update
  set value=coalesce(public.v8_config_hub.value,'{}'::jsonb)||excluded.value,
      description=excluded.description,
      is_active=true,
      updated_at=now();

  return true;
end;
$function$;

create or replace function public.v8_sync_showroom_locations_context_trigger()
returns trigger
language plpgsql
security definer
set search_path='public'
as $function$
begin
  if coalesce(new.is_active,false)
     and coalesce(new.usage_mode,'')='PRODUCTION'
     and jsonb_array_length(public.v8_extract_showroom_locations_from_context(new.content))>=2 then
    perform public.v8_apply_showroom_locations_from_context(
      new.context_key,
      new.content,
      new.updated_at
    );
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_v8_sync_showroom_locations_context on public.v8_ai_contexts;
create trigger trg_v8_sync_showroom_locations_context
after insert or update of content,is_active,usage_mode
on public.v8_ai_contexts
for each row execute function public.v8_sync_showroom_locations_context_trigger();

-- Backfill immediately from the newest production context that contains the
-- complete location list. Future admin edits are handled by the trigger above.
do $block$
declare
  v_row record;
begin
  select context_key,content,updated_at
    into v_row
  from public.v8_ai_contexts
  where is_active
    and usage_mode='PRODUCTION'
    and jsonb_array_length(public.v8_extract_showroom_locations_from_context(content))>=2
  order by updated_at desc,priority asc
  limit 1;

  if found then
    perform public.v8_apply_showroom_locations_from_context(
      v_row.context_key,
      v_row.content,
      v_row.updated_at
    );
  end if;
end;
$block$;

insert into public.v8_config_hub(scope,key,value,description,is_active,updated_at)
values(
  'runtime',
  'showroom_multi_address_sync',
  jsonb_build_object(
    'enabled',true,
    'version','showroom_context_sync_v1',
    'zero_token_address_fast_path',true,
    'minimum_locations',2,
    'activated_at',now()
  ),
  'Đồng bộ danh sách cơ sở từ ngữ cảnh production sang fast path địa chỉ 0 token.',
  true,
  now()
)
on conflict(scope,key) do update
set value=excluded.value,description=excluded.description,is_active=true,updated_at=now();