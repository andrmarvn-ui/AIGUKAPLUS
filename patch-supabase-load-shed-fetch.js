const ORIGINAL_FETCH = globalThis.fetch.bind(globalThis);
const SUPABASE_ORIGIN = String(
  process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "",
).replace(/\/$/, "");

if (!SUPABASE_ORIGIN) {
  console.warn("[AIGUKA load shed] Supabase origin missing; fetch circuit breaker disabled");
} else if (globalThis.__AIGUKA_SUPABASE_LOAD_SHED_V1__) {
  console.log("[AIGUKA load shed] Shared Supabase circuit breaker already installed");
} else {
  globalThis.__AIGUKA_SUPABASE_LOAD_SHED_V1__ = true;

  const ORIGIN = new URL(SUPABASE_ORIGIN).origin;
  const LOW_PRIORITY = [
    "/rest/v1/v8_worker_heartbeats",
    "/rest/v1/v8_response_obligations",
    "/rest/v1/v8_pages",
    "/rest/v1/rpc/v8_report_v21_tick",
    "/rest/v1/v8_slide_mapping",
    "/rest/v1/rpc/v8_create_follow_up_tasks",
    "/rest/v1/rpc/v8_reconcile_meta_sync_responses",
    "/rest/v1/rpc/v8_claim_conversation_sync_batch",
    "/rest/v1/rpc/v8_claim_ai_dispatch_batch",
    "/rest/v1/rpc/v8_claim_outbound_batch",
    "/rest/v1/rpc/v8_claim_webhook_inbox_batch",
    "/rest/v1/rpc/v8_dispatch_drive_asset_delivery_checks",
    "/rest/v1/rpc/v8_reconcile_drive_asset_delivery_checks",
  ];
  const MEDIUM_PRIORITY = [
    "/rest/v1/rpc/v8_zero_silent_drop_tick",
    "/rest/v1/rpc/v8_retry_recoverable_ai_errors",
    "/rest/v1/rpc/v8_recover_missing_meta_webhooks_from_pancake",
  ];

  let pressureUntil = 0;
  let backoffMs = 15_000;
  let successStreak = 0;
  let lastMediumProbeAt = 0;
  let lastCriticalFinishedAt = 0;
  let criticalTail = Promise.resolve();
  let criticalQueued = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const syntheticPressure = (path, priority) => new Response(
    JSON.stringify({
      message: "AIGUKA_SUPABASE_PRESSURE_CIRCUIT_OPEN",
      path,
      priority,
      retry_after_ms: Math.max(0, pressureUntil - Date.now()),
    }),
    {
      status: 503,
      headers: {
        "content-type": "application/json",
        "x-aiguka-load-shed": "1",
      },
    },
  );

  function classify(pathname) {
    if (LOW_PRIORITY.some((path) => pathname.startsWith(path))) return "low";
    if (MEDIUM_PRIORITY.some((path) => pathname.startsWith(path))) return "medium";
    return "critical";
  }

  function openCircuit(reason) {
    const now = Date.now();
    pressureUntil = Math.max(pressureUntil, now + backoffMs);
    backoffMs = Math.min(120_000, backoffMs * 2);
    successStreak = 0;
    if (now - Number(globalThis.__AIGUKA_LAST_PRESSURE_LOG_AT__ || 0) > 10_000) {
      globalThis.__AIGUKA_LAST_PRESSURE_LOG_AT__ = now;
      console.error(
        `[AIGUKA load shed] Supabase pressure detected (${reason}); background calls paused ${Math.ceil((pressureUntil - now) / 1000)}s`,
      );
    }
  }

  function recordSuccess(priority) {
    if (priority !== "critical") return;
    const wasOpen = pressureUntil > 0;
    successStreak += 1;
    if (successStreak >= 5) {
      pressureUntil = 0;
      backoffMs = 15_000;
      successStreak = 0;
      if (wasOpen) console.log("[AIGUKA load shed] Supabase recovered; circuit closed");
    }
  }

  async function executeCritical(request) {
    if (criticalQueued >= 100) {
      return syntheticPressure(request.pathname, "critical_queue_full");
    }
    criticalQueued += 1;
    let release;
    const mine = new Promise((resolve) => { release = resolve; });
    const previous = criticalTail;
    criticalTail = mine;
    await previous.catch(() => {});
    try {
      const gap = Date.now() - lastCriticalFinishedAt;
      if (gap < 120) await sleep(120 - gap);
      return await request.run();
    } finally {
      lastCriticalFinishedAt = Date.now();
      criticalQueued -= 1;
      release();
    }
  }

  globalThis.fetch = async function aigukaSupabaseLoadShedFetch(input, init) {
    let url;
    try {
      url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    } catch {
      return ORIGINAL_FETCH(input, init);
    }
    // Edge Functions, Storage and Auth are independent services with different
    // latency/error profiles. Only Data API traffic may affect the DB circuit.
    if (url.origin !== ORIGIN || !url.pathname.startsWith("/rest/v1/")) {
      return ORIGINAL_FETCH(input, init);
    }

    const priority = classify(url.pathname);
    const now = Date.now();
    const circuitOpen = pressureUntil > now;

    if (circuitOpen && priority === "low") {
      return syntheticPressure(url.pathname, priority);
    }
    if (circuitOpen && priority === "medium") {
      if (now - lastMediumProbeAt < 20_000) {
        return syntheticPressure(url.pathname, priority);
      }
      lastMediumProbeAt = now;
    }

    const run = async () => {
      try {
        const response = await ORIGINAL_FETCH(input, init);
        if ([429, 500, 502, 503, 504].includes(response.status)) {
          openCircuit(`HTTP_${response.status}:${url.pathname}`);
        } else if (response.ok) {
          recordSuccess(priority);
        }
        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/timeout|connection|reset|fetch failed|socket|econn/i.test(message)) {
          openCircuit(`${message}:${url.pathname}`);
        }
        throw error;
      }
    };

    if (circuitOpen && priority === "critical") {
      return executeCritical({ pathname: url.pathname, run });
    }
    return run();
  };

  console.log("[AIGUKA load shed] Shared Supabase pressure circuit breaker installed");
}
