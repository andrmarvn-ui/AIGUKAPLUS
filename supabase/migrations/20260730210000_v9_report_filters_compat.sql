create or replace function public.v8_report_filters_test()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.v8_assert_admin_request();
  perform set_config('statement_timeout','3000',true);
  return jsonb_build_object(
    'ok',true,
    'data',jsonb_build_object(
      'pages',coalesce((
        select jsonb_agg(to_jsonb(x) order by x.page_name)
        from (
          select page_id,page_name,operating_mode as bot_mode,is_active
          from public.dim_pages
          where page_id is not null
        ) x
      ),'[]'::jsonb),
      'ad_accounts',coalesce((
        select jsonb_agg(to_jsonb(x) order by x.ad_account_name)
        from (
          select
            a.ad_account_id,
            a.ad_account_name,
            a.account_status,
            coalesce(f.currency,'VND') as currency,
            coalesce(f.timezone_name,'Asia/Ho_Chi_Minh') as timezone_name
          from (
            select ad_account_id,max(ad_account_name) ad_account_name,
                   coalesce(max(attributes->>'account_status'),'UNKNOWN') account_status
            from public.dim_ads
            where page_id is not null and ad_account_id is not null
            group by ad_account_id
          ) a
          left join (
            select ad_account_id,max(metadata->>'currency') currency,
                   max(metadata->>'account_timezone') timezone_name
            from public.fact_daily_ad_performance
            group by ad_account_id
          ) f using(ad_account_id)
        ) x
      ),'[]'::jsonb),
      'ads',coalesce((
        select jsonb_agg(to_jsonb(x) order by x.campaign_name,x.adset_name,x.ad_name)
        from (
          select ad_account_id,ad_account_name,campaign_id,campaign_name,
                 adset_id,adset_name,ad_id,ad_name,effective_status
          from public.dim_ads
          where page_id is not null and ad_id is not null
        ) x
      ),'[]'::jsonb)
    ),
    'source','v9_reporting_dimensions'
  );
end;
$function$;

revoke all on function public.v8_report_filters_test() from public;
grant execute on function public.v8_report_filters_test() to anon,authenticated,service_role;
