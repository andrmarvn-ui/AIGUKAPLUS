-- The isolated V9/V10 Core bridge currently authenticates PostgREST as anon.
-- Match the least privileges needed by the server-side follow-up worker and admin API.
grant select, update on table public.v10_followup_config to anon;
grant select, update on table public.v10_followup_log to anon;
grant execute on function public.v10_enqueue_due_followups(integer, boolean) to anon;
