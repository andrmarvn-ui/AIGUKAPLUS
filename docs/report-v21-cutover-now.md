# Report V2.1 immediate cutover

V2.1 is now the default report source. The Railway report API retains explicit `version=1` rollback and automatically falls back to V1 for one minute when a V2.1 RPC fails without a usable stale cache.

Safety controls:

- V2.1 cache and in-flight request coalescing remain enabled.
- A failed V2.1 request opens a short circuit breaker and marks fallback response headers.
- The report worker uses a smaller batch every 30 seconds to reduce database contention.
- Report processing does not call AI.
- V1 RPCs are not removed and remain available for immediate rollback.
