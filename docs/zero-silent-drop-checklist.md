# Release checklist

- [ ] Apply Supabase migrations in timestamp order.
- [ ] Run `supabase/tests/zero_silent_drop_regression.sql`.
- [ ] Verify `v8_response_obligation_status()->>'healthy'` is `true`.
- [ ] Confirm cron job `aiguka_v8_delivery_sla_reconcile` succeeds.
- [ ] Deploy Railway and verify heartbeat `aiguka-railway-response-obligation`.
- [ ] Confirm no unresolved non-escalated obligation is older than two minutes.
- [ ] Review open `bot_delivery_rescue` Sale tasks; do not close them without a real customer response.
