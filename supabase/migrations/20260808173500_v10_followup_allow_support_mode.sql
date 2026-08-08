do $$
declare
  v_def text;
  v_old text := 'join public.v9_pages p on p.page_id=s.page_id and p.is_active and p.operating_mode=''ACTIVE'' and p.coexistence_mode=''AICAKE_DISABLED''';
  v_new text := 'join public.v9_pages p on p.page_id=s.page_id and p.is_active and ((p.operating_mode=''ACTIVE'' and p.coexistence_mode=''AICAKE_DISABLED'') or (p.operating_mode=''SUPPORT'' and p.coexistence_mode=''AICAKE_ACTIVE'' and coalesce((p.settings->>''support_enabled'')::boolean,true)))';
begin
  select pg_get_functiondef('public.v10_enqueue_due_followups(integer,boolean)'::regprocedure) into v_def;
  if position(v_old in v_def)=0 then
    raise exception 'FOLLOWUP_SUPPORT_JOIN_ANCHOR_NOT_FOUND';
  end if;
  v_def := replace(v_def, v_old, v_new);
  execute v_def;
end $$;

comment on function public.v10_enqueue_due_followups(integer,boolean) is
  'Queues follow-up independently from live reply mode. Supports AIGUKA primary and AIGUKA SUPPORT/AICAKE primary while preserving contact, takeover, silence and 20h safety guards.';
