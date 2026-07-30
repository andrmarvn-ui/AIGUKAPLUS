-- Fix the budget report showing Meta Ads spend before VAT while labeling it
-- "spend including tax". Meta Ads Insights returns media spend; the two active
-- VND billing accounts add 10% VAT on the Meta invoice.

alter table public.v8_meta_ad_accounts
  alter column spend_includes_tax set default false;

update public.v8_meta_ad_accounts
set tax_rate = 0.10,
    spend_includes_tax = false,
    updated_at = now()
where ad_account_id in (
  '311242249583664', -- Nguyet Bep - TB Ve Sinh
  '972318199015585'  -- fff
);

-- Backfill the canonical Meta daily insight rows. This is idempotent because
-- spend remains the before-tax amount and the derived columns are recalculated.
update public.v8_ads_daily_insights
set tax_amount = round(spend * 0.10, 2),
    spend_with_tax = round(spend * 1.10, 2),
    updated_at = now()
where ad_account_id in ('311242249583664','972318199015585')
  and insight_date >= date '2026-06-01';

-- Refresh the V2.1 materialized daily report values without rebuilding customer
-- attribution. Spend is already the before-tax value in this table.
update public.v8_report_v21_ad_day_fact
set tax_amount = round(spend * 0.10, 2),
    spend_with_tax = round(spend * 1.10, 2),
    refreshed_at = now()
where ad_account_id in ('311242249583664','972318199015585')
  and report_date >= date '2026-06-01';

-- V9 compatibility facts store spend_with_tax in the spend column and retain
-- spend_before_tax/tax_amount in metadata. Keep both layers consistent.
do $migration$
begin
  if to_regclass('public.fact_daily_ad_performance') is not null then
    execute $sql$
      update public.fact_daily_ad_performance
      set spend = round((metadata->>'spend_before_tax')::numeric * 1.10, 2),
          metadata = jsonb_set(
            jsonb_set(
              metadata,
              '{tax_amount}',
              to_jsonb(round((metadata->>'spend_before_tax')::numeric * 0.10, 2)),
              true
            ),
            '{spend_before_tax}',
            to_jsonb((metadata->>'spend_before_tax')::numeric),
            true
          ),
          updated_at = now()
      where ad_account_id in ('311242249583664','972318199015585')
        and report_date >= date '2026-06-01'
        and metadata ? 'spend_before_tax'
    $sql$;
  end if;
end
$migration$;
