import crypto from "node:crypto";

function text(value) {
  return String(value ?? "").trim();
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function iso(value) {
  const parsed = Date.parse(String(value || ""));
  return new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString();
}

function timestampKey(value) {
  return iso(value).replace(/[-:.TZ]/g, "");
}

function referralId(referral, key) {
  const source = referral && typeof referral === "object" ? referral : {};
  if (key === "ad_id") return text(source.ad_id || source.adId || source.ad?.id) || null;
  if (key === "adset_id") return text(source.adset_id || source.adsetId || source.adset?.id) || null;
  if (key === "campaign_id") return text(source.campaign_id || source.campaignId || source.campaign?.id) || null;
  return null;
}

export function hashReportingContact(value, secret) {
  const normalized = text(value).replace(/[^0-9a-z@.+_-]/gi, "").toLowerCase();
  const key = text(secret);
  if (!normalized || !key) return null;
  return crypto.createHmac("sha256", key).update(normalized).digest("hex");
}

function envelope(sourceType, eventKey, occurredAt, payload) {
  return {
    event_key: eventKey,
    event_type: sourceType,
    occurred_at: iso(occurredAt),
    payload,
  };
}

export function buildReportingEnvelope(sourceType, row, options = {}) {
  if (!row || typeof row !== "object") throw new TypeError("REPORTING_SOURCE_ROW_REQUIRED");
  const updated = row.updated_at || row.created_at || row.occurred_at || row.captured_at || new Date().toISOString();

  if (sourceType === "page_dimension") {
    const pageId = text(row.page_id);
    if (!pageId) throw new TypeError("REPORTING_PAGE_ID_REQUIRED");
    return envelope(sourceType, `page:${pageId}:${timestampKey(updated)}`, updated, {
      page_id: pageId,
      page_name: row.page_name || null,
      timezone: row.timezone || "Asia/Bangkok",
      operating_mode: row.operating_mode || null,
      is_active: row.is_active !== false,
      attributes: { coexistence_mode: row.coexistence_mode || null, canary_percent: row.canary_percent ?? null },
      first_seen_at: row.created_at || updated,
      last_seen_at: updated,
    });
  }

  if (sourceType === "customer_dimension") {
    const pageId = text(row.page_id);
    const customerId = text(row.customer_id);
    if (!pageId || !customerId) throw new TypeError("REPORTING_CUSTOMER_KEY_REQUIRED");
    return envelope(sourceType, `customer:${pageId}:${customerId}:${timestampKey(updated)}`, updated, {
      page_id: pageId,
      customer_id: customerId,
      display_name: row.display_name || null,
      gender: row.gender || null,
      preferred_salutation: row.preferred_salutation || null,
      attributes: {},
      first_seen_at: row.first_seen_at || row.created_at || updated,
      last_seen_at: row.last_seen_at || updated,
    });
  }

  if (sourceType === "message_fact") {
    const id = text(row.id || row.source_event_id);
    if (!id) throw new TypeError("REPORTING_MESSAGE_ID_REQUIRED");
    const referral = row.referral || {};
    return envelope(sourceType, `message:${id}`, row.occurred_at || updated, {
      source_event_id: id,
      page_id: row.page_id || null,
      customer_id: row.customer_id || null,
      occurred_at: row.occurred_at || updated,
      actor_type: row.actor_type || null,
      event_type: row.event_type || null,
      message_length: text(row.message_text).length,
      attachment_count: array(row.attachments).length,
      has_referral: Boolean(referral && Object.keys(referral).length),
      ad_id: referralId(referral, "ad_id"),
      attributes: {
        campaign_id: referralId(referral, "campaign_id"),
        adset_id: referralId(referral, "adset_id"),
        source_system: row.source_system || null,
      },
    });
  }

  if (sourceType === "contact_fact") {
    const id = text(row.id);
    if (!id) throw new TypeError("REPORTING_CONTACT_ID_REQUIRED");
    return envelope(sourceType, `contact:${id}`, row.captured_at || updated, {
      source_contact_id: id,
      page_id: row.page_id,
      customer_id: row.customer_id,
      contact_type: row.contact_type,
      contact_hash: hashReportingContact(row.normalized_value || row.contact_value, options.contactHashSecret),
      confidence: row.confidence ?? null,
      captured_at: row.captured_at || updated,
      attributes: { source_event_id: row.source_event_id || null },
    });
  }

  if (sourceType === "ai_decision_fact") {
    const id = text(row.id);
    if (!id) throw new TypeError("REPORTING_DECISION_ID_REQUIRED");
    const output = row.output && typeof row.output === "object" ? row.output : {};
    return envelope(sourceType, `decision:${id}:${timestampKey(updated)}`, updated, {
      source_decision_id: id,
      source_event_id: row.source_event_id || null,
      page_id: row.page_id,
      customer_id: row.sender_id,
      occurred_at: row.created_at || updated,
      mode: row.mode || null,
      status: row.status || null,
      action: row.action || output.action || null,
      confidence: row.confidence ?? output.confidence ?? null,
      model: output.model || null,
      knowledge_version: row.knowledge_version || null,
      should_request_contact: output.should_request_contact ?? null,
      needs_slides: output.needs_slides ?? null,
      risk_flags: array(output.risk_flags || row.risk_flags),
      latency_ms: row.latency_ms ?? null,
      attributes: {
        transport_locked: output.transport_locked === true,
        should_send: output.should_send === true,
      },
    });
  }

  if (sourceType === "delivery_fact") {
    const id = text(row.id);
    if (!id) throw new TypeError("REPORTING_DELIVERY_ID_REQUIRED");
    return envelope(sourceType, `delivery:${id}:${timestampKey(updated)}`, updated, {
      source_bundle_id: id,
      source_decision_id: row.decision_id || null,
      page_id: row.page_id,
      customer_id: row.sender_id,
      created_at: row.created_at || updated,
      status: row.status || null,
      text_length: text(row.text_body).length,
      asset_count: array(row.asset_refs).length,
      sent_at: row.sent_at || null,
      attempt_count: Number(row.attempt_count || 0),
      last_error: row.last_error || null,
      attributes: {},
    });
  }

  if (sourceType === "sla_fact") {
    const id = text(row.id);
    if (!id) throw new TypeError("REPORTING_SLA_ID_REQUIRED");
    const started = Date.parse(String(row.created_at || ""));
    const resolved = Date.parse(String(row.resolved_at || ""));
    return envelope(sourceType, `sla:${id}:${timestampKey(updated)}`, updated, {
      source_sla_id: id,
      source_event_id: row.source_event_id || null,
      page_id: row.page_id,
      customer_id: row.sender_id,
      deadline_at: row.deadline_at,
      status: row.status,
      resolution: row.resolution || null,
      resolved_at: row.resolved_at || null,
      response_ms: Number.isFinite(started) && Number.isFinite(resolved) ? Math.max(0, resolved - started) : null,
      attributes: {},
    });
  }

  throw new TypeError(`REPORTING_SOURCE_TYPE_UNSUPPORTED:${sourceType}`);
}

const FORBIDDEN_REPORTING_KEYS = new Set([
  "message_text",
  "contact_value",
  "normalized_value",
  "phone",
  "zalo",
  "token_cipher",
  "api_key",
]);

function assertPrivacyKeys(value, path = "payload", seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPrivacyKeys(item, `${path}[${index}]`, seen));
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = String(key).trim().toLowerCase();
    if (FORBIDDEN_REPORTING_KEYS.has(normalizedKey)) {
      throw new Error(`REPORTING_PRIVACY_FIELD_FORBIDDEN:${normalizedKey}:${path}`);
    }
    assertPrivacyKeys(nested, `${path}.${key}`, seen);
  }
}

export function assertReportingPayloadPrivacy(value) {
  assertPrivacyKeys(value);
  return value;
}
