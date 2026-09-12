import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = String(Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = String(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "");
const ALLOWED_TABLE = new Set([
  "v9_runtime_config", "v9_pages", "v9_customers", "v9_contacts",
  "v9_actor_registry", "v9_events", "v9_conversation_state", "v9_turns",
  "v9_jobs", "v9_decisions", "v9_delivery_bundles", "v9_delivery_attempts",
  "v9_reporting_outbox", "v9_worker_cursors", "v9_worker_heartbeats",
  "v9_shadow_observations", "v9_sla_events", "v9_integrations",
  "ai_runtime_config", "ai_providers", "ai_drive_connections", "ai_documents",
  "ai_catalog_nodes", "ai_assets", "ai_catalog_assets", "ai_ad_mappings",
  "ai_published_snapshots", "v10_followup_config", "v10_followup_log",
  "v10_pancake_media_cache", "v10_data_retention", "v10_report_scope",
]);
const ALLOWED_RPC = new Set([
  "v9_claim_jobs",
  "v9_ingest_meta_batch",
  "v10_capacity_guard_tick",
  "v10_enqueue_due_followups",
  "v10_claim_message_dispatch",
  "v10_release_message_dispatch",
]);

function response(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function validBridge(key: string): Promise<boolean> {
  if (!key || !SUPABASE_URL || !SERVICE_ROLE_KEY) return false;
  const check = await fetch(`${SUPABASE_URL}/rest/v1/rpc/v10_validate_core_bridge`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ p_key: key }),
    signal: AbortSignal.timeout(8_000),
  });
  return check.ok && await check.json().catch(() => false) === true;
}

function allowed(restPath: string): boolean {
  const clean = restPath.replace(/^\/+/, "").split("?", 1)[0];
  const parts = clean.split("/");
  if (parts[0] === "rpc") return parts.length === 2 && ALLOWED_RPC.has(parts[1]);
  return parts.length === 1 && ALLOWED_TABLE.has(parts[0]);
}

Deno.serve(async (req: Request) => {
  if (!["GET", "POST", "PATCH"].includes(req.method)) return response({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
  const bridgeKey = String(req.headers.get("x-aiguka-core-bridge") || "");
  if (!await validBridge(bridgeKey)) return response({ ok: false, error: "BRIDGE_UNAUTHORIZED" }, 401);

  const incoming = new URL(req.url);
  const marker = "/rest/v1/";
  const at = incoming.pathname.indexOf(marker);
  if (at < 0) return response({ ok: false, error: "REST_PATH_REQUIRED" }, 400);
  const restPath = incoming.pathname.slice(at + marker.length);
  if (!allowed(restPath)) return response({ ok: false, error: "RESOURCE_NOT_ALLOWED" }, 403);

  const body = req.method === "GET" ? undefined : await req.arrayBuffer();
  if (body && body.byteLength > 2_000_000) return response({ ok: false, error: "BODY_TOO_LARGE" }, 413);
  const upstream = await fetch(`${SUPABASE_URL}/rest/v1/${restPath}${incoming.search}`, {
    method: req.method,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "content-type": req.headers.get("content-type") || "application/json",
      prefer: req.headers.get("prefer") || "return=representation",
      ...(req.headers.get("range") ? { range: req.headers.get("range")! } : {}),
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const headers = new Headers({
    "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  const contentRange = upstream.headers.get("content-range");
  if (contentRange) headers.set("content-range", contentRange);
  return new Response(upstream.body, { status: upstream.status, headers });
});
