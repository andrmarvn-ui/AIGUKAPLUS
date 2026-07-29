create index if not exists idx_v9_jobs_event_id
  on public.v9_jobs(event_id)
  where event_id is not null;

create index if not exists idx_v9_decisions_turn_id
  on public.v9_decisions(turn_id)
  where turn_id is not null;

create index if not exists idx_v9_delivery_bundles_decision_id
  on public.v9_delivery_bundles(decision_id)
  where decision_id is not null;
