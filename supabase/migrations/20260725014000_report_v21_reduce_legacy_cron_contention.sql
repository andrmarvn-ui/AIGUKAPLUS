create or replace function public.v8_refresh_system_alerts_guarded()
returns jsonb
language plpgsql
security definer
set search_path to 'public','extensions'
as $function$
declare
  v_locked boolean:=false;
begin
  select pg_try_advisory_xact_lock(hashtextextended('v8_refresh_system_alerts_guarded',0))
  into v_locked;
  if not coalesce(v_locked,false) then
    return jsonb_build_object('ok',true,'skipped',true,'reason','already_running');
  end if;

  perform set_config('lock_timeout','1000',true);
  perform set_config('statement_timeout','30000',true);
  return public.v8_refresh_system_alerts();
end;
$function$;

create or replace function public.v8_sync_customer_names_guarded(
  p_triggered_by text default 'scheduled'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','extensions'
as $function$
declare
  v_locked boolean:=false;
begin
  select pg_try_advisory_xact_lock(hashtextextended('v8_sync_customer_names_guarded',0))
  into v_locked;
  if not coalesce(v_locked,false) then
    return jsonb_build_object('ok',true,'skipped',true,'reason','already_running');
  end if;

  perform set_config('lock_timeout','1000',true);
  perform set_config('statement_timeout','30000',true);
  return public.v8_sync_customer_names(coalesce(nullif(btrim(p_triggered_by),''),'scheduled'));
end;
$function$;

select cron.alter_job(
  8,
  schedule => '4,34 * * * *',
  command => 'select public.v8_refresh_system_alerts_guarded();',
  active => true
);

select cron.alter_job(
  9,
  schedule => '6 * * * *',
  command => $$select public.v8_sync_customer_names_guarded('cron');$$,
  active => true
);

revoke all on function public.v8_refresh_system_alerts_guarded() from public;
revoke all on function public.v8_sync_customer_names_guarded(text) from public;
grant execute on function public.v8_refresh_system_alerts_guarded() to service_role;
grant execute on function public.v8_sync_customer_names_guarded(text) to service_role;
