-- Close legacy follow-up PostgREST exposure without breaking the Railway Core bridge.
-- The bridge header remains the only anon-role path; service_role continues to bypass RLS.

alter table public.v10_followup_config enable row level security;
alter table public.v10_followup_events enable row level security;
alter table public.v10_followup_log enable row level security;
alter table public.v10_followup_contact_guard enable row level security;

drop policy if exists v10_followup_bridge_access on public.v10_followup_config;
create policy v10_followup_bridge_access
  on public.v10_followup_config
  for all
  to anon
  using (aiguka_private.v9_bridge_authorized())
  with check (aiguka_private.v9_bridge_authorized());

drop policy if exists v10_followup_bridge_access on public.v10_followup_events;
create policy v10_followup_bridge_access
  on public.v10_followup_events
  for all
  to anon
  using (aiguka_private.v9_bridge_authorized())
  with check (aiguka_private.v9_bridge_authorized());

drop policy if exists v10_followup_bridge_access on public.v10_followup_log;
create policy v10_followup_bridge_access
  on public.v10_followup_log
  for all
  to anon
  using (aiguka_private.v9_bridge_authorized())
  with check (aiguka_private.v9_bridge_authorized());

drop policy if exists v10_followup_bridge_access on public.v10_followup_contact_guard;
create policy v10_followup_bridge_access
  on public.v10_followup_contact_guard
  for all
  to anon
  using (aiguka_private.v9_bridge_authorized())
  with check (aiguka_private.v9_bridge_authorized());

revoke all on table public.v10_followup_config from public, authenticated;
revoke all on table public.v10_followup_events from public, authenticated;
revoke all on table public.v10_followup_log from public, authenticated;
revoke all on table public.v10_followup_contact_guard from public, authenticated;

-- These SECURITY DEFINER RPCs predate the bridge. Inject the same fail-closed
-- authorization check used by the V10 message gateway before any business work.
do $migration$
declare
  v_function record;
  v_definition text;
  v_begin_at integer;
  v_guard constant text := E'\nbegin\n  if not aiguka_private.v9_bridge_request_allowed() then\n    raise exception \'V10_CORE_BRIDGE_FORBIDDEN\' using errcode = \'42501\';\n  end if;\n';
begin
  for v_function in
    select p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'v10_apply_followup_admin',
        'v10_delete_followup_event',
        'v10_enqueue_due_followups',
        'v10_learning_conversation_detail',
        'v10_learning_conversation_list',
        'v10_replace_followup_events',
        'v10_report_customer_metrics',
        'v10_save_followup_config_only',
        'v10_upsert_followup_event'
      )
  loop
    v_definition := pg_get_functiondef(v_function.oid);
    if position('V10_CORE_BRIDGE_FORBIDDEN' in v_definition) = 0 then
      v_begin_at := position(E'\nbegin\n' in lower(v_definition));
      if v_begin_at = 0 then
        raise exception 'V10_BRIDGE_GUARD_INJECTION_POINT_MISSING:%', v_function.oid::regprocedure;
      end if;
      v_definition := overlay(v_definition placing v_guard from v_begin_at for length(E'\nbegin\n'));
      execute v_definition;
    end if;
  end loop;
end;
$migration$;

revoke all on function public.v10_apply_followup_admin(jsonb, jsonb, text) from public, authenticated;
revoke all on function public.v10_delete_followup_event(uuid, text) from public, authenticated;
revoke all on function public.v10_enqueue_due_followups(integer, boolean) from public, authenticated;
revoke all on function public.v10_learning_conversation_detail(text, text) from public, authenticated;
revoke all on function public.v10_learning_conversation_list(text, integer, integer) from public, authenticated;
revoke all on function public.v10_replace_followup_events(jsonb, text) from public, authenticated;
revoke all on function public.v10_report_customer_metrics(date, date, text, text) from public, authenticated;
revoke all on function public.v10_save_followup_config_only(jsonb, text) from public, authenticated;
revoke all on function public.v10_upsert_followup_event(jsonb, text) from public, authenticated;

grant execute on function public.v10_apply_followup_admin(jsonb, jsonb, text) to anon, service_role;
grant execute on function public.v10_delete_followup_event(uuid, text) to anon, service_role;
grant execute on function public.v10_enqueue_due_followups(integer, boolean) to anon, service_role;
grant execute on function public.v10_learning_conversation_detail(text, text) to anon, service_role;
grant execute on function public.v10_learning_conversation_list(text, integer, integer) to anon, service_role;
grant execute on function public.v10_replace_followup_events(jsonb, text) to anon, service_role;
grant execute on function public.v10_report_customer_metrics(date, date, text, text) to anon, service_role;
grant execute on function public.v10_save_followup_config_only(jsonb, text) to anon, service_role;
grant execute on function public.v10_upsert_followup_event(jsonb, text) to anon, service_role;

-- Trigger execution does not require client EXECUTE; remove its public RPC surface.
revoke all on function public.v10_followup_schedule_next_after_delivery() from public, anon, authenticated;
grant execute on function public.v10_followup_schedule_next_after_delivery() to service_role;

create index if not exists v10_followup_log_event_id_idx
  on public.v10_followup_log(event_id);

