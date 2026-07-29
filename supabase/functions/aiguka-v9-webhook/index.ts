import "jsr:@supabase/functions-js/edge-runtime.d.ts";

type JsonObject = Record<string, unknown>;

const SUPABASE_URL = String(Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = String(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "");
const VERIFY_TOKEN = String(Deno.env.get("META_VERIFY_TOKEN") || "AIGUKA_V8_META_VERIFY");
const META_APP_SECRET = String(Deno.env.get("META_APP_SECRET") || "");

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  const result = String(value ?? "").trim();
  return result || null;
}

function isoFromMeta(value: unknown): string {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const millis = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return new Date(millis).toISOString();
  }
  const parsed = Date.parse(String(value || ""));
  return new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString();
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

async function hmacSha256(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function verifyMetaSignature(rawBody: string, signature: string | null): Promise<boolean> {
  if (!META_APP_SECRET || !signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${await hmacSha256(META_APP_SECRET, rawBody)}`;
  return constantTimeEqual(expected, signature.toLowerCase());
}

function detectPhone(value: string | null): string | null {
  const source = String(value || "");
  const match = source.match(/(?:\+?84|0)[\s.\-]*(?:\d[\s.\-]*){9,10}/);
  if (!match) return null;
  const digits = match[0].replace(/\D/g, "");
  const local = digits.startsWith("84") ? `0${digits.slice(2)}` : digits;
  return /^0\d{9}$/.test(local) ? local : null;
}

function referral(raw: JsonObject, message: JsonObject, postback: JsonObject): JsonObject | null {
  const candidate = object(raw.referral || message.referral || postback.referral);
  return Object.keys(candidate).length ? candidate : null;
}

async function sourceId(pageId: string, kind: string, raw: JsonObject): Promise<string> {
  const message = object(raw.message);
  const postback = object(raw.postback);
  const optin = object(raw.optin);
  const stable = text(message.mid || postback.mid || optin.user_ref);
  if (stable) return `meta:${pageId}:${kind}:${stable}`;
  return `meta:${pageId}:${kind}:${await sha256(JSON.stringify(raw))}`;
}

async function normalizeMessaging(pageId: string, itemValue: unknown): Promise<JsonObject | null> {
  const raw = object(itemValue);
  const message = object(raw.message);
  const postback = object(raw.postback);
  const optin = object(raw.optin);
  const rawReferral = object(raw.referral);
  const isEcho = message.is_echo === true;
  const kind = isEcho
    ? "message_echo"
    : Object.keys(message).length
      ? "message"
      : Object.keys(postback).length
        ? "postback"
        : Object.keys(optin).length
          ? "marketing_optin"
          : Object.keys(rawReferral).length
            ? "referral"
            : "unknown";
  if (kind === "unknown") return null;

  const sender = text(object(raw.sender).id);
  const recipient = text(object(raw.recipient).id) || pageId;
  const customerId = isEcho ? recipient : sender;
  if (!customerId) return null;
  const messageText = text(message.text || postback.title || postback.payload || optin.title || optin.payload);
  const attachments = array(message.attachments);
  const actorAppId = text(message.app_id || raw.app_id);
  const eventType = isEcho
    ? "page_message"
    : kind === "message"
      ? "customer_message"
      : kind === "postback"
        ? "customer_postback"
        : kind === "referral"
          ? "customer_referral"
          : "customer_optin";

  return {
    source_system: "meta_direct_webhook",
    source_event_id: await sourceId(pageId, kind, raw),
    page_id: pageId,
    sender_id: isEcho ? pageId : sender,
    recipient_id: isEcho ? customerId : recipient,
    customer_id: customerId,
    message_id: text(message.mid || postback.mid),
    actor_type: isEcho ? "page_unknown" : "customer",
    actor_app_id: actorAppId,
    actor_evidence: {
      method: isEcho ? "meta_echo_unverified_v1" : "meta_inbound_direction_v1",
      human_verified: false,
      is_echo: isEcho,
      app_id: actorAppId,
      event_kind: kind,
    },
    event_type: eventType,
    message_text: messageText,
    attachments,
    referral: referral(raw, message, postback),
    occurred_at: isoFromMeta(raw.timestamp),
    received_at: new Date().toISOString(),
    payload: { kind: "meta_event", event_kind: kind, raw_payload: raw },
    decision_eligible: !isEcho && ["message", "postback"].includes(kind) && Boolean(messageText || attachments.length),
    contact_phone: !isEcho ? detectPhone(messageText) : null,
  };
}

async function normalizeFeedChange(pageId: string, changeValue: unknown): Promise<JsonObject | null> {
  const change = object(changeValue);
  if (change.field !== "feed") return null;
  const value = object(change.value);
  const sender = text(object(value.from).id);
  if (!sender) return null;
  return {
    source_system: "meta_direct_webhook",
    source_event_id: `meta:${pageId}:feed:${await sha256(JSON.stringify(change))}`,
    page_id: pageId,
    sender_id: sender,
    recipient_id: pageId,
    customer_id: sender,
    message_id: text(value.comment_id || value.post_id),
    actor_type: "customer",
    actor_evidence: { method: "meta_feed_change_v1", human_verified: false },
    event_type: "customer_comment",
    message_text: text(value.message),
    attachments: [],
    referral: null,
    occurred_at: isoFromMeta(value.created_time),
    received_at: new Date().toISOString(),
    payload: { kind: "feed_change", change },
    decision_eligible: false,
    contact_phone: null,
  };
}

async function normalizeBody(body: JsonObject): Promise<JsonObject[]> {
  if (body.object !== "page") return [];
  const events: JsonObject[] = [];
  for (const entryValue of array(body.entry)) {
    const entry = object(entryValue);
    const pageId = text(entry.id);
    if (!pageId) continue;
    for (const item of array(entry.messaging)) {
      const event = await normalizeMessaging(pageId, item);
      if (event) events.push(event);
    }
    for (const change of array(entry.changes)) {
      const event = await normalizeFeedChange(pageId, change);
      if (event) events.push(event);
    }
  }
  return events;
}

async function ingest(events: JsonObject[]): Promise<unknown> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/v9_ingest_meta_batch`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ p_events: events }),
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await response.text();
  let data: unknown;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw: raw.slice(0, 500) }; }
  if (!response.ok) throw new Error(`V9_CORE_RPC_${response.status}:${raw.slice(0, 300)}`);
  return data;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    if (url.searchParams.get("hub.mode") !== "subscribe") return new Response("Not Found", { status: 404 });
    if (url.searchParams.get("hub.verify_token") !== VERIFY_TOKEN) return new Response("Forbidden", { status: 403 });
    return new Response(url.searchParams.get("hub.challenge") || "", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ ok: false, error: "CORE_CONFIGURATION_MISSING" }, 503);
  if (!META_APP_SECRET) return json({ ok: false, error: "META_APP_SECRET_NOT_CONFIGURED" }, 503);

  const rawBody = await req.text();
  if (!await verifyMetaSignature(rawBody, req.headers.get("x-hub-signature-256"))) {
    return json({ ok: false, error: "INVALID_META_SIGNATURE" }, 401);
  }

  let body: JsonObject;
  try { body = object(JSON.parse(rawBody)); }
  catch { return json({ ok: false, error: "INVALID_JSON" }, 400); }

  try {
    const events = await normalizeBody(body);
    if (!events.length) return json({ ok: true, accepted: 0, ignored: true });
    const result = await ingest(events);
    return json({ ok: true, accepted: events.length, result });
  } catch (error) {
    console.error("[AIGUKA V9 webhook]", error instanceof Error ? error.message : String(error));
    return json({ ok: false, error: "V9_INGEST_FAILED" }, 503);
  }
});
