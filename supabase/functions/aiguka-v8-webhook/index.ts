import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type J = Record<string, any>;
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
    : item.message ? "message"
    : item.postback ? "postback"
    : item.optin ? "marketing_optin"
    : item.referral ? "referral"
    : item.delivery ? "delivery"
    : item.read ? "read"
    : "unknown_messaging";

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
      architecture: "durable-inbox-fast-ack",
      version: "2026-07-28-v21-durable-inbox",
      ack_boundary: "v8_webhook_inbox",
      downstream_processing: "railway-worker",
      duplicate_message_policy: "ignore_without_update",
    });
  }
  if (req.method !== "POST") return out({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);

  let body: J;
  try {
    body = await req.json();
  } catch {
    return out({ ok: false, error: "INVALID_JSON" }, 400);
  }

  const rows: J[] = [];
  let skipped = 0;
  let echoes = 0;
  let comments = 0;
  let optins = 0;

  for (const entry of body.entry || []) {
    const pageId = txt(entry.id);
    for (const item of entry.messaging || []) {
      const eventKind = kind(item);
      if (["delivery", "read", "unknown_messaging"].includes(eventKind)) {
        skipped += 1;
        continue;
      }

      const message = item.message || {};
      const postback = item.postback || {};
      const optin = item.optin || {};
      const isEcho = eventKind === "message_echo";
      if (isEcho) echoes += 1;
      if (eventKind === "marketing_optin") optins += 1;

      const rawSender = txt(item.sender?.id);
      const rawRecipient = txt(item.recipient?.id) || pageId;
      const customer = isEcho ? rawRecipient : rawSender;
      const timestamp = Number(item.timestamp || Date.now());
      const messageId = txt(message.mid) || txt(postback.mid) || (
        eventKind === "marketing_optin"
          ? `optin:${pageId}:${customer}:${timestamp}`
          : eventKind === "referral"
            ? `referral:${pageId}:${customer}:${timestamp}`
            : `${pageId}:${customer}:${timestamp}`
      );
      const messageText = txt(message.text) || txt(postback.title) || txt(postback.payload) ||
        txt(optin.title) || txt(optin.payload) || txt(optin.notification_messages_status);
      const eventTime = new Date(timestamp).toISOString();
      const event = {
        meta_object: body.object,
        page_id: pageId,
        sender_id: rawSender,
        recipient_id: rawRecipient,
        message_id: messageId,
        conversation_id: txt(item.thread_id) || txt(item.conversation_id) || customer,
        message_text: messageText,
        timestamp_ms: timestamp,
        event_time: eventTime,
        referral: item.referral || message.referral || postback.referral || {},
        attachments: message.attachments || [],
        raw_payload: item,
        process_status: "processed",
      };
      rows.push({
        page_id: pageId,
        sender_id: rawSender,
        recipient_id: rawRecipient,
        message_id: messageId,
        event_time: eventTime,
        payload: {
          kind: "meta_event",
          event,
          event_kind: eventKind,
          marketing_optin: eventKind === "marketing_optin" ? {
            page_id: pageId,
            sender_id: customer,
            optin,
            event_time: eventTime,
            raw_payload: item,
          } : null,
        },
      });
    }

    skipped += Array.isArray(entry.standby) ? entry.standby.length : 0;
    for (const change of entry.changes || []) {
      const value = change?.value || {};
      const timestamp = Number(value.created_time || entry.time || Date.now());
      const eventTime = new Date(timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp).toISOString();
      const identity = txt(value.comment_id) || txt(value.post_id) || crypto.randomUUID();
      const verb = txt(value.verb) || "change";
      rows.push({
        page_id: pageId,
        sender_id: txt(value.from?.id),
        recipient_id: pageId,
        message_id: `feed:${pageId}:${identity}:${verb}:${eventTime}`,
        event_time: eventTime,
        payload: { kind: "feed_change", page_id: pageId, change },
      });
      comments += 1;
    }
  }

  if (!rows.length) {
    return out({ ok: true, received: true, durable: true, queued: 0, skipped }, 200);
  }

  const { error } = await db().from("v8_webhook_inbox").upsert(rows, {
    onConflict: "page_id,message_id",
    ignoreDuplicates: true,
  });
  if (error) {
    console.error("WEBHOOK_INBOX_INSERT_FAILED", error.message);
    return out({ ok: false, received: false, retryable: true, error: "WEBHOOK_INBOX_INSERT_FAILED" }, 503);
  }

  return out({
    ok: true,
    received: true,
    durable: true,
    fast_ack: true,
    queued: rows.length,
    skipped,
    echoes,
    comments,
    optins,
  }, 200);
});
