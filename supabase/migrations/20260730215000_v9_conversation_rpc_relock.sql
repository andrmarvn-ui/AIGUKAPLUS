-- The Railway conversation worker now reads the source view and upserts the
-- materialized fact directly. It no longer depends on PostgREST RPC discovery.
revoke execute on function public.v9_refresh_conversation_fact(timestamptz) from anon,authenticated;
revoke all on function public.v9_refresh_conversation_fact(timestamptz) from public;
grant execute on function public.v9_refresh_conversation_fact(timestamptz) to service_role;

select pg_notify('pgrst','reload schema');
select pg_notify('pgrst','reload config');
