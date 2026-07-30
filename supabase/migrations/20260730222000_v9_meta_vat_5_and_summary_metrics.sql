-- Business rule confirmed by the owner: Meta VAT is 5%, not 10%.
update public.v8_meta_ad_accounts
set tax_rate=0.05,
    spend_includes_tax=false,
    updated_at=now()
where ad_account_id in ('972318199015585','311242249583664');

update public.v8_ads_daily_insights
set tax_amount=round(spend*0.05,2),
    spend_with_tax=round(spend*1.05,2),
    updated_at=now()
where ad_account_id in ('972318199015585','311242249583664')
  and insight_date >= current_date-93;

create or replace view public.v9_report_compat_performance as
select
  report_date,
  page_id,
  coalesce(nullif(metadata->>'page_name',''),page_id) page_name,
  ad_account_id,
  coalesce(nullif(metadata->>'ad_account_name',''),ad_account_id) ad_account_name,
  campaign_id,
  coalesce(nullif(metadata->>'campaign_name',''),campaign_id) campaign_name,
  adset_id,
  coalesce(nullif(metadata->>'adset_name',''),adset_id) adset_name,
  ad_id,
  coalesce(nullif(metadata->>'ad_name',''),ad_id) ad_name,
  coalesce(nullif(metadata->>'effective_status',''),'UNKNOWN') effective_status,
  coalesce(nullif(metadata->>'currency',''),'VND') currency,
  coalesce(nullif(metadata->>'account_timezone',''),'Asia/Ho_Chi_Minh') account_timezone,
  nullif(metadata->>'payment_method_last4','') payment_method_last4,
  coalesce(nullif(metadata->>'spend_before_tax','')::numeric,
           case when spend>0 then round(spend/1.05,2) else 0 end) spend,
  round(coalesce(nullif(metadata->>'spend_before_tax','')::numeric,
           case when spend>0 then round(spend/1.05,2) else 0 end)*0.05,2) tax_amount,
  round(coalesce(nullif(metadata->>'spend_before_tax','')::numeric,
           case when spend>0 then round(spend/1.05,2) else 0 end)*1.05,2)::numeric(18,4) spend_with_tax,
  impressions,reach,clicks,
  coalesce(nullif(metadata->>'link_clicks','')::bigint,0) link_clicks,
  coalesce(nullif(metadata->>'meta_conversations','')::bigint,0) meta_conversations,
  conversations,contacts,
  coalesce(nullif(metadata->>'hot_leads','')::bigint,0) hot_leads,
  coalesce(nullif(metadata->>'message_count','')::bigint,0) message_count,
  coalesce(nullif(metadata->>'meta_leads','')::bigint,0) meta_leads,
  coalesce(nullif(metadata->>'data_match_status',''),'unknown') data_match_status,
  updated_at
from public.fact_daily_ad_performance;

comment on view public.v9_report_compat_performance is
'V9 reporting compatibility read model. Meta VAT fixed at 5 percent per business requirement.';