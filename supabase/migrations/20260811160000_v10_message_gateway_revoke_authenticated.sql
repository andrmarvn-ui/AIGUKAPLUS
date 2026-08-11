-- Core's database bridge calls as anon with x-aiguka-core-bridge. Signed-in client
-- sessions are not a valid transport owner and must not execute dispatch RPCs.
revoke all on function public.v10_claim_message_dispatch(text,text,text,text,integer,integer) from authenticated;
revoke all on function public.v10_release_message_dispatch(text,text,text,text,text) from authenticated;

select pg_notify('pgrst','reload schema');

