do $migration$
declare
  v_definition text;
  v_old text := E'  insert into public.v8_report_v21_state(state_key,state_value,updated_at)\n  values(\n    ''conversation_fact_readiness'',\n    jsonb_build_object(\n      ''ready'',false,\n      ''reason'',''customer_day_and_ad_day_parity_precedes_conversation_grain_cutover'',\n      ''updated_at'',now()\n    ),\n    now()\n  )\n  on conflict(state_key) do update set\n    state_value=excluded.state_value,updated_at=now();\n';
  v_new text := E'  insert into public.v8_report_v21_state(state_key,state_value,updated_at)\n  values(\n    ''conversation_fact_readiness'',\n    jsonb_build_object(\n      ''ready'',true,\n      ''owner'',''v9_refresh_conversation_fact'',\n      ''request_source'',''v8_report_v21_conversation_fact'',\n      ''daily_refresh_delete_disabled'',true,\n      ''updated_at'',now()\n    ),\n    now()\n  )\n  on conflict(state_key) do update set\n    state_value=excluded.state_value,updated_at=now();\n';
begin
  select pg_get_functiondef(p.oid)
  into v_definition
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname='v8_report_v21_refresh_day'
    and pg_get_function_identity_arguments(p.oid)='p_report_date date, p_page_id text';

  if v_definition is null then raise exception 'v8_report_v21_refresh_day_not_found'; end if;
  if position(v_old in v_definition)=0 then raise exception 'conversation_readiness_false_block_not_found'; end if;
  execute replace(v_definition,v_old,v_new);
end;
$migration$;

update public.v8_report_v21_state
set state_value=jsonb_build_object(
      'ready',true,
      'owner','v9_refresh_conversation_fact',
      'request_source','v8_report_v21_conversation_fact',
      'daily_refresh_delete_disabled',true,
      'updated_at',now()
    ),updated_at=now()
where state_key='conversation_fact_readiness';

select pg_notify('pgrst','reload schema');
select pg_notify('pgrst','reload config');
