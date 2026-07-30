-- Railway uses the database bridge with the Core publishable role plus a
-- verified x-aiguka-core-bridge header. Normal anonymous requests still fail
-- the RLS predicate.
grant select,insert,update,delete on public.v9_shadow_benchmark_runs to anon;
grant select,insert,update,delete on public.v9_shadow_benchmark_conversations to anon;

drop policy if exists v9_database_bridge_access on public.v9_shadow_benchmark_runs;
create policy v9_database_bridge_access
on public.v9_shadow_benchmark_runs
for all
to anon
using (aiguka_private.v9_bridge_authorized())
with check (aiguka_private.v9_bridge_authorized());

drop policy if exists v9_database_bridge_access on public.v9_shadow_benchmark_conversations;
create policy v9_database_bridge_access
on public.v9_shadow_benchmark_conversations
for all
to anon
using (aiguka_private.v9_bridge_authorized())
with check (aiguka_private.v9_bridge_authorized());