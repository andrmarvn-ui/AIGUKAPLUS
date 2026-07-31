insert into public.fact_messages (
  source_event_id,
  page_id,
  customer_id,
  occurred_at,
  actor_type,
  event_type,
  message_length,
  attachment_count,
  has_referral,
  ad_id,
  attributes,
  ingested_at
)
select
  'v8_inbox:' || i.id::text,
  i.page_id,
  i.sender_id,
  i.event_time,
  'customer',
  case when i.payload->>'event_kind'='postback' then 'customer_postback' else 'customer_message' end,
  length(coalesce(i.payload->'event'->>'message_text','')),
  case
    when jsonb_typeof(i.payload->'event'->'attachments')='array'
      then jsonb_array_length(i.payload->'event'->'attachments')
    else 0
  end,
  coalesce(i.payload->'event'->'referral','{}'::jsonb) <> '{}'::jsonb,
  nullif(btrim(coalesce(
    i.payload->'event'->'referral'->>'ad_id',
    i.payload->'event'->'referral'->'ads_context_data'->>'ad_id'
  )),''),
  jsonb_strip_nulls(jsonb_build_object(
    'source_system','v8_webhook_inbox_backfill',
    'legacy_inbox_id',i.id::text,
    'campaign_id',nullif(btrim(i.payload->'event'->'referral'->>'campaign_id'),''),
    'adset_id',nullif(btrim(i.payload->'event'->'referral'->>'adset_id'),'')
  )),
  now()
from public.v8_webhook_inbox i
where i.payload->>'kind'='meta_event'
  and i.payload->>'event_kind' in ('message','postback')
  and nullif(btrim(i.page_id),'') is not null
  and nullif(btrim(i.sender_id),'') is not null
  and i.sender_id<>i.page_id
  and not exists (
    select 1
    from public.fact_messages m
    where m.page_id=i.page_id
      and m.customer_id=i.sender_id
      and m.occurred_at=i.event_time
      and m.event_type=case when i.payload->>'event_kind'='postback' then 'customer_postback' else 'customer_message' end
  )
on conflict (source_event_id) do nothing;
