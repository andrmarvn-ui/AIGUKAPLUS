# Production validation — 2026-07-24

The architecture was applied to Supabase project `ezygfpeeqbbirdeazene` before opening the pull request.

Validated in production:

- durable obligations were backfilled for the prior 48 hours;
- the watchdog recovered terminal AI failures and completed-but-unstaged decisions;
- external responder cancellations closed obligations without duplicate bot sends;
- messages older than 48 hours did not reopen live delivery work;
- duplicate slide asset IDs were reduced to one before staging;
- a forced carousel failure released a truthful text-only fallback;
- repeated fallback SLA writes were idempotent;
- cron jobs were staggered and the watchdog continued succeeding every minute;
- unresolved cases outside the valid Messenger window created deduplicated Sale rescue tasks.

Regression helpers returned `ok: true`:

```sql
select public.v8_regression_test_zero_silent_drop();
select public.v8_regression_test_slide_failure_text_fallback();
```

The Railway response-obligation worker is added by this pull request. Until the PR is deployed, the database cron remains the active one-minute safety net.
