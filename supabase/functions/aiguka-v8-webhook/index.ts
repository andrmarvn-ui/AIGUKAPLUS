import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { processFeedChange, type J } from "./feed.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const H = { "content-type": "application/json", "access-control-allow-origin": "*" };
const out = (x: J, status = 200) => new Response(JSON.stringify(x), { status, headers: H });
const txt = (v: any) => v == null ? null : (String(v).trim() || null);
const db = () => createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const kind = (item: J) =>
  item.message?.is_echo ? "message_echo"
    : item.delivery ? "delivery"
    : item.read ? "read"
    : item.message ? "message"
    : item.postback ? "postback"
    : item.optin ? "marketing_optin"
    : item.referral ? "referral"
    : "unknown_messaging";

function runInBackground(promise: Promise<unknown>) {
  try {
    EdgeRuntime.waitUntil(promise);
  } catch {
    promise.catch(() => {});
  }
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    const verify = Deno.env.get("META_VERIFY_TOKEN") || "AIGUKA_V8_META_VERIFY";
    if (
      url.searchParams.get("hub.mode") === "subscribe" &&
      url.searchParams.get("hub.verify_token") === verify
    ) {
      return new Response(url.searchParams.get("hub.challenge") || "", { status: 200 });
    }
    return out({
      ok: true,
      service: "aiguka-v8-webhook",
      architecture: "bulk-ingest-fast-ack",
      mode: "PRODUCTION",
      version: "2026-07-28-v19-realtime-priority",
      synchronous_profile_sync: false,
      per_event_audit: false,
    });
  }
  if (req.method !== "POST") return out({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);

  let body: J;
  try {
    body = await req.json();
  } catch {
    return out({ ok: false, error: "INVALID_JSON" }, 400);
  }

  const client = db();
  const postId = `post:${Date.now()}:${crypto.randomUUID()}`;
  const first = body.entry?.[0] || {};
  const counters: J = { saved: 0, skipped: 0, failed: 0, echoes: 0, comments: 0, optins: 0 };
  const eventRows: J[] = [];
  const marketingOptins: J[] = [];
  const feedChanges: Array<{ pageId: string; change: J }> = [];

  for (const entry of body.entry || []) {
    const pageId = txt(entry.id);
    for (const item of entry.messaging || []) {
      const eventKind = kind(item);
      if (!["message", "message_echo", "postback", "marketing_optin"].includes(eventKind)) {
        counters.skipped += 1;
        continue;
      }

      const message = item.message || {};
      const postback = item.postback || {};
      const optin = item.optin || {};
      const isEcho = eventKind === "message_echo";
      if (isEcho) counters.echoes += 1;
      const rawSender = txt(item.sender?.id);
      const rawRecipient = txt(item.recipient?.id) || pageId;
      const customer = isEcho ? rawRecipient : rawSender;
      const timestamp = Number(item.timestamp || Date.now());
      const messageId = txt(message.mid) || txt(postback.mid) || (
        eventKind === "marketing_optin"
          ? `optin:${pageId}:${customer}:${timestamp}`
          : `${pageId}:${customer}:${timestamp}`
      );
      const messageText = txt(message.text) || txt(postback.title) || txt(postback.payload) ||
        txt(optin.title) || txt(optin.payload) || txt(optin.notification_messages_status);

      eventRows.push({
        meta_object: body.object,
        page_id: pageId,
        sender_id: rawSender,
        recipient_id: rawRecipient,
        message_id: messageId,
        conversation_id: txt(item.thread_id) || txt(item.conversation_id) || customer,
        message_text: messageText,
        timestamp_ms: timestamp,
        event_time: new Date(timestamp).toISOString(),
        referral: item.referral || message.referral || postback.referral || {},
        attachments: message.attachments || [],
        raw_payload: item,
        process_status: "processed",
      });

      if (eventKind === "marketing_optin") {
        marketingOptins.push({ pageId, customer, optin, timestamp, item });
      }
    }

    counters.skipped += Array.isArray(entry.standby) ? entry.standby.length : 0;
    for (const change of entry.changes || []) feedChanges.push({ pageId, change });
  }

  if (eventRows.length) {
    const { error } = await client.from("v8_meta_events").upsert(eventRows, {
      onConflict: "page_id,message_id",
    });
    if (error) {
      console.error("META_EVENT_BULK_UPSERT_FAILED", error.message);
      return out({ ok: false, received: false, retryable: true, error: "META_EVENT_BULK_UPSERT_FAILED" }, 503);
    }
    counters.saved = eventRows.length;
  }

  const background = async () => {
    const noAudit = async (_row: J) => {};

    for (const x of marketingOptins) {
      const { error } = await client.rpc("v8_record_marketing_optin", {
        p_page_id: x.pageId,
        p_sender_id: x.customer,
        p_optin: x.optin,
        p_event_time: new Date(x.timestamp).toISOString(),
        p_raw_payload: x.item,
      });
      if (!error) counters.optins += 1;
      else console.error("MARKETING_OPTIN_RPC_FAILED", error.message);
    }

    for (const x of feedChanges) {
      try {
        await processFeedChange(client, noAudit, postId, x.pageId, x.change, counters);
      } catch (error) {
        console.error("FEED_CHANGE_BACKGROUND_FAILED", error instanceof Error ? error.message : String(error));
      }
    }

    await client.from("v8_webhook_audit").insert({
      request_id: postId,
      page_id: txt(first.id),
      step: "POST_BULK_INGESTED",
      status: "ok",
      detail: `saved=${counters.saved};skipped=${counters.skipped};comments=${counters.comments}`,
      payload_preview: {
        architecture: "bulk-ingest-fast-ack",
        entry_count: Array.isArray(body.entry) ? body.entry.length : 0,
        saved: counters.saved,
        skipped: counters.skipped,
        echoes: counters.echoes,
        optins: counters.optins,
        comments: counters.comments,
      },
    }).then(({ error }) => {
      if (error) console.error("WEBHOOK_SUMMARY_AUDIT_FAILED", error.message);
    }).catch(() => {});
  };

  runInBackground(background());
  return out({ ok: true, received: true, fast_ack: true, ...counters }, 200);
});
