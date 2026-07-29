-- Guard fresh deployments against carrying the previous event UUID into a duplicate
-- item in the same JSON batch. Production already contains this reset; this migration
-- is intentionally a no-op when the function is already correct.
do $$
declare
  v_oid regprocedure:='public.v9_ingest_meta_batch(jsonb)'::regprocedure;
  v_definition text;
  v_patched text;
begin
  v_definition:=pg_get_functiondef(v_oid);
  if position('v_event_id:=null;' in replace(v_definition,' ',''))>0 then
    return;
  end if;

  v_patched:=regexp_replace(
    v_definition,
    '(for[[:space:]]+v_input[[:space:]]+in[[:space:]]+select[[:space:]]+value[[:space:]]+from[[:space:]]+jsonb_array_elements\(v_items\)[[:space:]]*loop[[:space:]]*begin[[:space:]]*)',
    E'\\1v_event_id:=null;\n',
    'i'
  );

  if v_patched=v_definition or position('v_event_id:=null;' in replace(v_patched,' ',''))=0 then
    raise exception 'V9_INGEST_EVENT_ID_RESET_PATCH_FAILED';
  end if;

  execute v_patched;
end $$;

revoke all on function public.v9_ingest_meta_batch(jsonb) from public,anon,authenticated;
grant execute on function public.v9_ingest_meta_batch(jsonb) to service_role;
