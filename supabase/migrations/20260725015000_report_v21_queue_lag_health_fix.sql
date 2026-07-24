create or replace function public.v8_report_v21_status()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
select jsonb_build_object(
  'generated_at',now(),
  'fact_version',21,
  'conversation_rows',(select count(*) from public.v8_report_v21_conversation_fact),
  'conversation_fact_ready',coalesce((
    select (state_value->>'ready')::boolean
    from public.v8_report_v21_state
    where state_key='conversation_fact_readiness'
  ),false),
  'customer_day_rows',(select count(*) from public.v8_report_v21_customer_day_fact),
  'ad_day_rows',(select count(*) from public.v8_report_v21_ad_day_fact),
  'referral_rows',(select count(*) from public.v8_report_v21_referral_fact),
  'pending_keys',(select count(*) from public.v8_report_v21_dirty_keys where status in ('pending','retry','processing')),
  'dead_letter_keys',(select count(*) from public.v8_report_v21_dirty_keys where status='dead_letter'),
  'oldest_pending_at',(
    select min(updated_at) from public.v8_report_v21_dirty_keys
    where status in ('pending','retry','processing')
  ),
  'latest_fact_at',(select max(refreshed_at) from public.v8_report_v21_customer_day_fact),
  'latest_ads_fact_at',(select max(refreshed_at) from public.v8_report_v21_ad_day_fact),
  'latest_source_watermark',(
    select state_value->>'watermark' from public.v8_report_v21_state
    where state_key='source_watermark'
  ),
  'healthy',(
    (select count(*)=0 from public.v8_report_v21_dirty_keys where status='dead_letter')
    and
    (select coalesce(min(updated_at)>now()-interval '5 minutes',true)
     from public.v8_report_v21_dirty_keys
     where status in ('pending','retry','processing'))
  )
);
$function$;
