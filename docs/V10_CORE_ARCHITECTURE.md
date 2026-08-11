# AIGUKA V10 Core authority

`v10/core/constitution.js` is the single role and channel-ownership authority.
The priority order is:

1. hard safety and verified human takeover;
2. runtime/Page ownership;
3. latest customer frontier;
4. contact cadence;
5. AI business decision;
6. Knowledge/Mapping advisors;
7. Message Gateway transport.

## Role matrix

| Page mode | Normal text | Media | Operational fallback | Event follow-up |
| --- | --- | --- | --- | --- |
| `OFF` | none | none | none | none |
| `ACTIVE` + `AIGUKA_PRIMARY` | AIGUKA | AIGUKA | none | AIGUKA |
| `SUPPORT` + `AICAKE_PRIMARY_SUPPORT` | AICake | AIGUKA | AIGUKA after the configured wait and live Pancake check | AIGUKA |
| verified human takeover | human only | human only | blocked | blocked |

Automation and AICake are never classified as human. A verified human takeover with
no expiry remains active until a newer customer turn resets it; there is no fixed bot
resume timeout.

## Outbound invariant

`v10/core/message-gateway.js` is the only production module allowed to call the Meta
Messenger send endpoint. Live outbound and follow-up must claim
`v10_message_dispatch` for the Page/customer pair before sending and must release the
lease afterward. A pending live decision blocks a lower-priority follow-up claim.

Delivery bundles/logs provide durable idempotency; the dispatch lease prevents
cross-worker concurrency. Support fallback only creates/reuses Core decisions and has
no direct Meta transport.

## Source invariant

Production entrypoints must never import `patch-v10-*` or any module that rewrites a
worker file. Historical patch files are retained only as audit history. Their final
effects are committed in the active source files and verified by `v10-live-release.js`.

## Contact invariant

The useful answer comes first. A contact request is allowed only for a missing contact
with an active sales need, is placed last and is not repeated within two customer
messages. Known contacts and Messenger-only refusals are always sanitized before
delivery. Contact cadence may not change selected products, catalog keys, media action
or the substantive business answer.

