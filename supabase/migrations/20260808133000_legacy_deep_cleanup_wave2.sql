-- Deep cleanup wave 2, 2026-08-08.
-- Objects below were verified against:
--   * current GitHub runtime sources,
--   * pg_stat_user_tables / pg_stat_statements,
--   * FK, trigger, view, policy, function and cron dependencies,
--   * current PostgREST/worker activity.
-- V10 Core and current bridge/reporting/catalog paths are intentionally untouched.

-- Historical V7/V8 telemetry or audit tables no longer read or written by the
-- current runtime. None has an incoming FK, trigger, view/function or cron consumer.
drop table if exists public.bot_events;
drop table if exists public.lt_scan_statistics;
drop table if exists public.v8_group_keyword_relations;
drop table if exists public.v8_report_export_log;
drop table if exists public.v8_ads_sync_runs;
drop table if exists public.v8_aicake_monitor_logs;

-- Columns that are NULL for every existing row, have no constraint/index/view/
-- policy/function reference, have zero matching statement usage, and are absent
-- from the current repository contract. Their parent tables remain intact.
alter table if exists public.lt_leads
  drop column if exists note;

alter table if exists public.v8_customer_state_events
  drop column if exists changed_by;

alter table if exists public.v8_webhook_events
  drop column if exists page_name;

-- v8_sale_tasks.created_from_event_id is intentionally retained despite being
-- currently NULL: it owns an FK and index and therefore remains part of the schema
-- contract for traceability/future event-linked tasks.
