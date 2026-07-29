# AIGUKA V9 rollout

## Business goals

1. No valid customer turn is silently dropped.
2. P95 customer response target: 45 seconds; every turn has a final state or an SLA breach record by 90 seconds.
3. Every sales conversation is optimized toward capturing a phone number or Zalo after answering the customer's actual question.
4. Dashboard/reporting is outside the realtime customer path.

## Foundation deployment

This change introduces an isolated `SHADOW` lane only:

- reads new rows from `v8_meta_events` without changing V8;
- writes a canonical immutable `v9_events` timeline;
- keeps one `v9_conversation_state` row per Page/customer;
- creates explicit delayed jobs after a 20 second debounce;
- detects phone/Zalo contact and applies Contact Lock;
- records 90 second SLA status;
- builds shadow decision snapshots with `output.should_send=false`;
- never calls Meta outbound and never sends a customer message.

## Safety rules

- `ACTIVE` is deliberately rejected by the foundation worker.
- V9 tables have RLS enabled and no anon/authenticated grants.
- There are no V9 business triggers, database HTTP calls or realtime cron scans.
- The worker starts from the migration timestamp, so it does not replay the full V8 backlog.
- V8 remains the production responder until actor, context, AI decision and delivery comparisons pass.

## Runtime control

`public.v9_runtime_config.mode`:

- `OFF`: worker stays idle;
- `SHADOW`: ingest and evaluate without sending;
- `ACTIVE`: blocked in this foundation release.

Default values:

- debounce: 20 seconds;
- response SLA: 90 seconds;
- batch: 10 events;
- contact goal: `capture_phone_or_zalo`;
- dashboard isolated: true.

## Next implementation gates

1. Actor Resolver: distinguish verified Sale/Admin from Page automation using evidence, never volume heuristics.
2. Context Builder: debounce all customer messages in one turn and preserve multi-product intent.
3. AI Decision Worker: one structured decision, contact-focused, no transport side effects.
4. Delivery Bundle: text and media handled atomically with a final human-takeover check.
5. Dashboard outbox: copy facts to `AIGUKA-DashBoard` without querying realtime tables.
6. Replay and canary: compare V9 against real V8 conversations before enabling any Page.

## Acceptance metrics before ACTIVE

- canonical event capture >= 99.99%;
- unresolved customer turns = 0;
- actor misclassification < 0.1%;
- duplicate responses < 0.1%;
- wrong catalog sends = 0;
- no text claiming media was sent when media failed;
- dashboard failure has zero effect on webhook, decision or delivery workers.
