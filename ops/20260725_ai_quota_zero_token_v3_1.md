# AI quota optimization v3.1 — 2026-07-25

## Baseline after evidence-first v2

Measured from `2026-07-23T13:21:59Z` until the v3 production activation:

- 165 AI requests across 78 conversations: 2.12 requests/conversation.
- 111 actual model calls.
- 269,776 measured tokens in the exact replay window.
- No decision used more than one model call; the remaining waste was caused by deterministic customer turns still entering the model pipeline.

Largest avoidable groups included showroom address/contact questions, customers providing phone/Zalo, greetings/acknowledgements, price requests with no verified price candidate, and fixed Meta CTA postbacks.

## Changes

1. Added zero-token fast paths for:
   - phone/Zalo supplied by customer;
   - no-value acknowledgements;
   - simple greetings;
   - showroom address/contact questions;
   - price questions when there is no verified price candidate;
   - fixed Meta postbacks `Tư vấn nội thất nhà mới` and `Tư vấn gạch ốp lát`.
2. Increased rapid-turn debounce from 15 seconds to 20 seconds.
3. Kept the model path when:
   - an image exists in the latest 60-second customer turn;
   - a verified mapped price exists;
   - the request is ambiguous or requires product consultation.
4. Added daily visibility through `v8_ai_quota_fast_path_daily`.

## Historical replay result

Against the 111-call baseline:

- 60 calls removed by zero-token paths.
- 4 additional calls removed by the 20-second rapid-turn debounce.
- Total model-call reduction: **64/111 = 57.66%**.
- Replayed token avoidance: **139,942/269,776 = 51.87%**.

This meets the requested additional 50% quota reduction without replacing image understanding, verified-price answers, or complex product consultation with static rules.

## Production state

Production migrations applied successfully:

- `ai_quota_zero_token_fast_paths_v3`
- `ai_quota_known_postbacks_and_debounce_v3_1`

Runtime config version: `zero_token_common_intents_v3_1`.
