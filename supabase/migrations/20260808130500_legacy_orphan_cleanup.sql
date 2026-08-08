-- AIGUKA legacy/knowledge cleanup, 2026-08-08.
-- Scope is intentionally conservative: only objects proven unused by the current
-- V10 runtime, current repository, DB dependencies/cron, and recent API activity.
-- Do not add the duplicate Legacy v9_* shell tables here; some old diagnostics may
-- still query them even though customer traffic is isolated in the Core project.

begin;

-- Empty audit/static tables with no FK, trigger, view, function, cron, repository,
-- or current runtime references.
drop table if exists public.v8_external_source_audit;
drop table if exists public.v8_database_audit_notes;
drop table if exists public.v8_meta_permission_audit;
drop table if exists public.v8_static_page_chunks;

-- Duplicate Google Drive credential table. The active compatibility/runtime table is
-- public.v8_google_drive_connections; ai_drive_connections contained the same legacy
-- connection payload and had no runtime/function/view dependency.
drop table if exists public.ai_drive_connections;

-- Retired pre-V8/V8 reply scheduler. V8 customer decision/background workers are
-- permanently disabled in start.js; V10 follow-up uses Core v10_followup_* tables.
-- This table had no FK/trigger/view/function/cron/current-repository dependency and
-- no new row had been created since 2026-07-08.
drop table if exists public.pending_replies;

-- ai_assets is still active, but these four columns have remained NULL for every row
-- and are absent from the current published-snapshot contract and mapping resolver.
-- Keep the fields actually consumed by V10: id/provider/external_id/folder_id/
-- file_name/mime_type/source_url/file_size/metadata/is_active/sync timestamps.
alter table if exists public.ai_assets
  drop column if exists thumbnail_url,
  drop column if exists width,
  drop column if exists height,
  drop column if exists checksum;

commit;
