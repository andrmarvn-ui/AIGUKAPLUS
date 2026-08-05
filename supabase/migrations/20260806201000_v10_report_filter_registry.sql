create or replace function public.v10_report_filter_registry()
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_result jsonb;
begin
  with pages as (
    select distinct
      r.page_id,
      r.page_name,
      r.bot_mode,
      r.is_active,
      r.connection_status,
      r.webhook_status
    from public.v8_meta_page_registry r
    where coalesce(r.is_active, true)
  ),
  scoped_accounts as (
    select distinct
      a.ad_account_id,
      a.ad_account_name,
      a.currency,
      coalesce(a.timezone_name, 'Asia/Ho_Chi_Minh') as timezone_name,
      a.account_status,
      a.payment_method_last4,
      coalesce(a.reporting_enabled, true) as reporting_enabled,
      coalesce(a.is_active, true) as is_active
    from public.v8_meta_page_ad_accounts pa
    join public.v8_meta_ad_account_registry a
      on a.ad_account_id = pa.ad_account_id
    join pages p
      on p.page_id = pa.page_id
    where coalesce(a.reporting_enabled, true)
      and coalesce(a.is_active, true)
      and coalesce(pa.purpose, 'reporting') in ('reporting','advertising')
  ),
  mapped_ads as (
    select distinct on (m.ad_id)
      m.ad_id,
      coalesce(nullif(m.ad_name,''), nullif(am.metadata->>'ad_name','')) as ad_name,
      replace(coalesce(m.ad_account_id,''),'act_','') as ad_account_id,
      m.ad_account_name,
      m.campaign_id,
      m.campaign_name,
      m.adset_id,
      m.adset_name,
      am.page_id,
      p.page_name,
      coalesce(nullif(m.effective_status,''), nullif(m.account_status,'')) as effective_status,
      coalesce(m.product_item_key, m.product_group, m.product_type) as product_key,
      coalesce(m.product_name, m.recognition_name) as product_name,
      coalesce(m.is_active, m.enabled, true) as is_active,
      m.updated_at
    from public.ad_mappings m
    left join public.ai_ad_mappings am
      on am.ad_id = m.ad_id and coalesce(am.is_active, true)
    left join pages p
      on p.page_id = am.page_id
    join scoped_accounts a
      on a.ad_account_id = replace(coalesce(m.ad_account_id,''),'act_','')
    where nullif(btrim(m.ad_id),'') is not null
      and coalesce(m.is_active, m.enabled, true)
    order by m.ad_id, m.updated_at desc nulls last
  )
  select jsonb_build_object(
    'ok', true,
    'data', jsonb_build_object(
      'pages', coalesce((select jsonb_agg(to_jsonb(p) order by p.page_name) from pages p), '[]'::jsonb),
      'ad_accounts', coalesce((select jsonb_agg(to_jsonb(a) order by a.ad_account_name) from scoped_accounts a), '[]'::jsonb),
      'ads', coalesce((select jsonb_agg(to_jsonb(m) order by m.ad_account_name, m.campaign_name, m.adset_name, m.ad_name) from mapped_ads m), '[]'::jsonb)
    ),
    'source', 'v10_static_registry_and_mapping'
  ) into v_result;

  return v_result;
end;
$function$;

revoke all on function public.v10_report_filter_registry() from public;
grant execute on function public.v10_report_filter_registry() to anon, authenticated, service_role;
