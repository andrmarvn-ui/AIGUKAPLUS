# AIGUKA V10 runtime audit

Audit date: 2026-08-06 (Asia/Ho_Chi_Minh)

This document classifies runtime components by actual production dependency. A version prefix alone is not a reason to delete a component: compatibility components remain only when current traffic or reporting still depends on them.

## Active V10 customer runtime

These components own the live customer flow and must remain single-authority:

- `v10-direct-core-worker.js` — builds customer context and prepares AI decision work.
- `v10-ai-worker.js` / `v10-ai-worker-v2.js` — AI decision scheduler and provider routing.
- `v10-outbound-worker.js` — the only active Messenger delivery worker.
- `v10-decision-queue-janitor.js` — stale/superseded queue hygiene only.
- `v10-customer-profile-worker.js` — profile-only enrichment, no outbound path.
- `v10-mode-compat-worker.js` — imports legacy admin Page modes into Core only when stable values change.

## Required compatibility components

These cannot be removed yet without replacing their live source contract:

- `v9-legacy-inbox-bridge.js` — required because Meta webhook events currently land in `v8_webhook_inbox` before Core ingestion. It has no outbound authority.
- `v9-reporting-publisher.js` and `v9-reporting-sync-worker.js` — publish privacy-safe Core history into the Reporting read model used for long-range Lead pagination and export.
- `patch-server.js` and `patch-direct-meta-dashboard.js` — currently materialize the Railway HTTP server and direct-Meta dashboard. They need consolidation, but deleting them now would remove routes.

## Compatibility reporting scheduled for retirement

These workers duplicate data already available from direct Meta/Core paths. They remain temporarily enabled until dashboard filters and customer metrics are fully independent of stored ad snapshots:

- `v9-reporting-legacy-refresh-worker-v2.js`
- `v9-reporting-conversation-refresh-worker.js`
- `v9-meta-ads-insights-worker.js`
- `v9-meta-ad-page-resolver-worker.js`
- `v9-meta-orphan-ad-resolver-worker.js`

Retirement gate:

1. Filter inventory comes directly from Meta Graph API.
2. Customer/ad/day metrics come from `v10_report_customer_metrics` in Core.
3. Long-range Lead history and Excel export continue to pass tests without `fact_daily_ad_performance` refresh.
4. Meta outage fallback is explicitly defined and tested.

## Permanently retired in this audit

- V8 customer `webhook-inbox-worker`, AI dispatch, outbound and profile workers can no longer be started by `AIGUKA_V8_BACKGROUND_WORKERS`.
- `v8-v9-mode-sync-worker.js` is no longer started; its replacement suppresses unchanged writes and polls less frequently.
- Unused V7 Pancake service and its runtime source patches were deleted:
  - `v7-pancake-service.cjs`
  - `patch-v7-pancake-classifier.js`
  - `patch-v7-pancake-history.js`
  - `patch-v7-pancake-tag-parser.js`
  - `patch-v7-pancake-tag-final.js`

## Known architecture debt still open

### AI worker runtime patch chain

`v10-ai-worker.js` still mutates `v10-ai-worker-v2.js` through load-balancer and decision-integrity patches before starting. The production heartbeat therefore reports `v10_ai_quality_guard_v12`, while the committed base source identifies itself as `v10_ai_sovereign_scheduler_v2`.

This must be replaced with one committed final worker artifact. Until that consolidation has an exact behavioral parity test, deleting individual patches is unsafe.

### HTTP server patch chain

The Railway server is still materialized by sequential server/UI patches. Routes are working, but source ownership is unclear. The target is a single committed server entrypoint with no startup source rewriting.

### Legacy schema names

Core tables and several RPCs retain `v9_`/`v8_` names for schema compatibility. Names alone do not create duplicate runtime authority. Rename/drop work should occur only after callers and migrations are cut over.

## Production evidence used for decisions

- The legacy webhook inbox processed 791 events in the previous 24 hours with no pending/error rows, so its bridge remains required.
- Current V10 job queue had completed or superseded work only; no active dead-letter backlog was observed.
- Historical delivery constraint and Meta `#551` error bursts had stopped before this audit; current delivery bundles continue to be sent.
- The old mode-sync worker reported page changes every poll because it compared JSON containing a newly generated timestamp. The V10 compatibility worker removes volatile timestamps from equality checks.
