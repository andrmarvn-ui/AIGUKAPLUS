# AIGUKAPLUS Zero-Silent-Drop Architecture

## Invariant

An actionable customer turn must never disappear between pipeline tables.

A response obligation is terminal only when one of these outcomes is recorded:

1. AIGUKAPLUS sent a response and Meta transport was confirmed.
2. A Sale/Admin or another approved responder answered after the customer turn.
3. A newer customer turn superseded the earlier turn.
4. The turn was explicitly classified as low-value, opt-out, or archived history outside the supported delivery window.
5. Messenger delivery is no longer valid and an auditable Sale rescue task was created.

`done`, `completed`, `staged`, or `sent` in an intermediate table is not enough by itself.

## Root causes removed

### Late webhook/history recovery

Recovered messages previously arrived after the live-inbound age guard and could be stored without an AI request. Every current inbound customer message now creates `v8_response_obligations`. History older than 48 hours stays available for reporting but cannot reopen live delivery work.

### Terminal AI errors

An AI request previously stopped after two errors. The obligation watchdog now detects terminal request/decision errors and applies a deterministic, non-inventive text fallback. It escalates to Sale when delivery is not allowed.

### Completed decision without staging

The staging trigger previously performed heavy work inside the AI decision transaction. A staging exception could roll back or leave a completed decision without a reply plan. Staging errors are now caught, persisted, and retried by the watchdog.

### Slide failure cancelled the text reply

Text is still gated behind a requested carousel, but a real carousel transport failure now degrades to a truthful text-only response. Intentional cancellation caused by a newer customer turn or external responder still suppresses the stale response.

### Duplicate slide assets

Selected asset IDs are deduplicated before authoritative output capture. Staging also uses distinct asset IDs, preventing one `INSERT ... ON CONFLICT` statement from updating the same target row twice.

### Final Gate rows stuck in `ready`

The watchdog runs the ready-queue reconciler before and after obligation recovery. External responder cancellations close the response obligation as `resolved_external` instead of looking like an endlessly pending bot response.

### Cron collision

Heavy background jobs are staggered across different minute offsets. Core ingestion, missing-webhook recovery and the obligation watchdog remain frequent; reporting and maintenance jobs no longer all compete at the same second.

## Runtime components

- `v8_response_obligations`: durable end-to-end ledger.
- `v8_zero_silent_drop_tick(limit)`: idempotent database watchdog.
- `response-obligation-worker.js`: Railway worker that wakes the watchdog within seconds when an obligation is due.
- `v8_apply_safe_fallback_for_obligation`: deterministic text rescue.
- `v8_create_response_rescue_task`: deduplicated Sale escalation.
- `v8_response_obligation_status`: health summary for dashboards and alerts.

The database cron remains a one-minute safety net even when Railway is unavailable. PostgreSQL advisory locks prevent the Railway worker and cron from processing the same batch concurrently.

## Required monitoring

Healthy means there is no unresolved non-escalated obligation older than two minutes.

Operational alerts should display:

- unresolved obligations older than 2 and 10 minutes;
- terminal AI errors and fallback count;
- decisions completed without reply plans;
- outbound failures and stale `sending` rows;
- open `bot_delivery_rescue` Sale tasks;
- worker heartbeat for `aiguka-railway-response-obligation`.

## Regression scenarios

Every release touching messaging must verify:

1. Missing AI request is recovered.
2. AI failure after maximum attempts creates a safe fallback.
3. Completed decision without staging is restaged.
4. Duplicate slide asset IDs do not fail the transaction.
5. Failed carousel releases a truthful text fallback.
6. External responder closes the obligation without duplicate bot delivery.
7. Old history cannot create a live response obligation.
8. Outbound transport confirmation is required before terminal bot delivery.
