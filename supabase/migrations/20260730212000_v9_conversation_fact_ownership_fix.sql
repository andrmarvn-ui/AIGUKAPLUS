do $migration$
declare
  v_definition text;
  v_old text := E'  delete from public.v8_report_v21_conversation_fact f\n  where f.conversation_date_vn=p_report_date\n    and (v_page is null or f.page_id=v_page);\n';
  v_new text := E'  -- Conversation grain is owned by v9_refresh_conversation_fact.\n  -- The daily customer/ad refresh must never delete independently materialized Lead rows.\n';
begin
  select pg_get_functiondef(p.oid)
  into v_definition
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname='v8_report_v21_refresh_day'
    and pg_get_function_identity_arguments(p.oid)='p_report_date date, p_page_id text';

  if v_definition is null then
    raise exception 'v8_report_v21_refresh_day_not_found';
  end if;
  if position(v_old in v_definition)=0 then
    raise exception 'conversation_fact_delete_block_not_found';
  end if;

  execute replace(v_definition,v_old,v_new);
end;
$migration$;

insert into public.v8_report_v21_state(state_key,state_value,updated_at)
values(
  'conversation_fact_readiness',
  jsonb_build_object(
    'ready',true,
    'owner','v9_refresh_conversation_fact',
    'request_source','v8_report_v21_conversation_fact',
    'daily_refresh_delete_disabled',true,
    'updated_at',now()
  ),
  now()
)
on conflict(state_key) do update set
  state_value=excluded.state_value,
  updated_at=excluded.updated_at;

select public.v9_refresh_conversation_fact('epoch'::timestamptz);
notify pgrst,'reload schema';
