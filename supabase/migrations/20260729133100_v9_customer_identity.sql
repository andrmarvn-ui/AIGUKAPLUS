-- Keep the raw Meta sender identity while keying a V9 conversation by the customer PSID.

alter table public.v9_events
  add column if not exists customer_id text;

create index if not exists idx_v9_events_customer_conversation_time
  on public.v9_events(page_id, customer_id, occurred_at desc);

comment on column public.v9_events.sender_id is 'Raw Meta sender id for the event.';
comment on column public.v9_events.customer_id is 'Customer PSID used as the stable V9 conversation key.';
