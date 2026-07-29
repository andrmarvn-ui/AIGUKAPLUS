const AI_CAKE_PATTERN = /(?:\bai\s*cake\b|\baicake\b)/i;
const AIGUKA_PATTERN = /\baiguka\b/i;
const AUTOMATION_PATTERN = /(?:automation|automatic|auto_reply|page_automation|botcake|chatbot)/i;
const HUMAN_TYPES = new Set(["human_admin", "human_sale", "admin", "sale"]);

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function lower(value) {
  return String(value || "").trim().toLowerCase();
}

function parseTime(value, fallbackMs = Date.now()) {
  const parsed = Date.parse(String(value || ""));
  return new Date(Number.isFinite(parsed) ? parsed : fallbackMs).toISOString();
}

function registryActor(row, registry = []) {
  const appId = String(row.actor_app_id || "");
  if (!appId) return null;
  return registry.find((item) => item && item.is_active !== false && String(item.app_id || "") === appId) || null;
}

export function resolveMessageActor(row, registry = []) {
  const direction = lower(row.direction);
  const declaredType = lower(row.actor_type);
  const sourceSystem = lower(row.source_system);
  const actorName = String(row.actor_name || "");
  const detail = asObject(row.source_detail);
  const registryEntry = registryActor(row, registry);
  const combined = [declaredType, sourceSystem, actorName, row.actor_confidence, detail.classification, detail.source]
    .filter(Boolean)
    .join(" ");

  if (["inbound", "incoming"].includes(direction) || declaredType === "customer") {
    return {
      actorType: "customer",
      provider: "meta",
      confidence: 1,
      humanVerified: false,
      method: "direction_customer_v1",
      signals: ["inbound_direction"],
    };
  }

  if (registryEntry) {
    const registeredType = lower(registryEntry.actor_type);
    if (["sale", "admin"].includes(registeredType) && row.is_automatic !== true) {
      return {
        actorType: registeredType,
        provider: lower(registryEntry.source_system) || "registry",
        confidence: 1,
        humanVerified: true,
        method: "active_actor_registry_v1",
        signals: [`registry:${registryEntry.app_id}`],
      };
    }
    if (["automation", "bot"].includes(registeredType)) {
      return {
        actorType: registeredType,
        provider: lower(registryEntry.source_system) || "registry",
        confidence: 1,
        humanVerified: false,
        method: "active_actor_registry_v1",
        signals: [`registry:${registryEntry.app_id}`],
      };
    }
  }

  if (AI_CAKE_PATTERN.test(combined)) {
    return {
      actorType: "automation",
      provider: "aicake",
      confidence: 0.99,
      humanVerified: false,
      method: "aicake_evidence_v1",
      signals: ["aicake_signature"],
    };
  }

  if (AIGUKA_PATTERN.test(combined) || sourceSystem === "aiguka_v8" || declaredType === "bot") {
    return {
      actorType: "bot",
      provider: "aiguka",
      confidence: 0.99,
      humanVerified: false,
      method: "aiguka_outbound_evidence_v1",
      signals: [sourceSystem || declaredType || "aiguka_signature"],
    };
  }

  if (row.is_automatic === true || AUTOMATION_PATTERN.test(combined) || declaredType === "page_automation") {
    return {
      actorType: "automation",
      provider: sourceSystem || "meta_page_automation",
      confidence: 0.97,
      humanVerified: false,
      method: "automatic_flag_or_template_v1",
      signals: [row.is_automatic === true ? "is_automatic" : "automation_signature"],
    };
  }

  const humanEvidence = detail.human_verified === true;
  if (HUMAN_TYPES.has(declaredType) && row.is_automatic === false && humanEvidence) {
    return {
      actorType: declaredType.includes("sale") ? "sale" : "admin",
      provider: sourceSystem || "meta_history",
      confidence: 0.99,
      humanVerified: true,
      method: "verified_human_history_v1",
      signals: [String(detail.human_evidence || row.actor_confidence || "human_verified")],
    };
  }

  return {
    actorType: "page_unknown",
    provider: sourceSystem || null,
    confidence: 0.2,
    humanVerified: false,
    method: "unverified_page_outbound_v1",
    signals: [declaredType || "page_or_system_unknown"],
  };
}

function eventTypeFor(actorType) {
  if (actorType === "customer") return "customer_message";
  if (actorType === "sale" || actorType === "admin") return "human_message";
  if (actorType === "automation") return "automation_message";
  if (actorType === "bot") return "bot_message";
  return "page_message";
}

export function normalizeV8RawMessage(row, registry = [], nowMs = Date.now()) {
  if (!row || !row.id) throw new TypeError("V9_RAW_MESSAGE_ID_REQUIRED");
  const actor = resolveMessageActor(row, registry);
  const sourceDetail = asObject(row.source_detail);
  return {
    sourceSystem: "v8_messages_raw",
    sourceEventId: String(row.id),
    pageId: row.page_id == null ? null : String(row.page_id),
    senderId: row.direction === "outbound" ? (row.page_id == null ? null : String(row.page_id)) : (row.sender_id == null ? null : String(row.sender_id)),
    recipientId: row.direction === "outbound" ? (row.sender_id == null ? null : String(row.sender_id)) : (row.page_id == null ? null : String(row.page_id)),
    customerId: row.sender_id == null ? null : String(row.sender_id),
    messageId: row.message_id == null ? null : String(row.message_id),
    actorType: actor.actorType,
    actorEvidence: {
      method: actor.method,
      provider: actor.provider,
      confidence: actor.confidence,
      human_verified: actor.humanVerified,
      signals: actor.signals,
      declared_actor_type: row.actor_type ?? null,
      actor_name: row.actor_name ?? null,
      actor_app_id: row.actor_app_id ?? null,
      source_system: row.source_system ?? null,
      is_automatic: row.is_automatic ?? null,
      actor_confidence: row.actor_confidence ?? null,
      source_detail: sourceDetail,
    },
    eventType: eventTypeFor(actor.actorType),
    text: row.message_text == null ? null : String(row.message_text),
    attachments: row.attachments ?? [],
    referral: null,
    occurredAt: parseTime(row.sent_at || row.created_at, nowMs),
    receivedAt: parseTime(row.created_at || row.sent_at, nowMs),
    payload: row.raw_payload ?? {},
  };
}
