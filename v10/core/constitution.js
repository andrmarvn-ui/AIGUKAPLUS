export const CONSTITUTION_VERSION = "v10_constitution_v1_single_authority";

export const AUTHORITY_ORDER = Object.freeze([
  "hard_safety_and_verified_human_takeover",
  "runtime_and_page_channel_ownership",
  "latest_customer_frontier",
  "contact_cadence",
  "ai_business_decision",
  "knowledge_and_mapping_advisors",
  "message_gateway_transport",
]);

export const ACTOR_AUTHORITY = Object.freeze({
  HUMAN: "human",
  AIGUKA: "aiguka",
  AICAKE: "aicake",
  AUTOMATION: "automation",
});

function upper(value) {
  return String(value || "").trim().toUpperCase();
}

function denied(reason, mode = "OFF") {
  return { allowed: false, reason, mode, text_owner: null, media_owner: null };
}

// This is the sole channel-ownership matrix. Workers may enforce additional safety
// gates, but may not redefine which actor owns text or media for a page mode.
export function resolveChannelAuthority({ runtime = {}, page = {}, channel = "live" } = {}) {
  if (upper(runtime.mode) !== "ACTIVE") return denied("RUNTIME_NOT_ACTIVE");
  if (upper(runtime.ingest_mode) !== "DIRECT_CORE") return denied("INGEST_NOT_DIRECT_CORE");
  if (!page?.is_active) return denied("PAGE_NOT_ACTIVE");

  const operatingMode = upper(page.operating_mode);
  const coexistenceMode = upper(page.coexistence_mode);
  const externalBotMode = upper(runtime.external_bot_mode);
  const externalBotPolicy = upper(runtime.external_bot_policy);

  if (operatingMode === "ACTIVE") {
    if (externalBotMode !== "AICAKE_DISABLED" || externalBotPolicy !== "AIGUKA_PRIMARY") {
      return denied("PRIMARY_RUNTIME_OWNERSHIP_MISMATCH", "ACTIVE");
    }
    if (coexistenceMode !== "AICAKE_DISABLED") return denied("PRIMARY_PAGE_OWNERSHIP_MISMATCH", "ACTIVE");
    return {
      allowed: true,
      reason: "AIGUKA_PRIMARY",
      mode: "ACTIVE",
      text_owner: ACTOR_AUTHORITY.AIGUKA,
      media_owner: ACTOR_AUTHORITY.AIGUKA,
      followup_owner: ACTOR_AUTHORITY.AIGUKA,
      operational_fallback_owner: null,
    };
  }

  if (operatingMode === "SUPPORT") {
    if (externalBotMode !== "AICAKE_ACTIVE" || externalBotPolicy !== "AICAKE_PRIMARY_SUPPORT") {
      return denied("SUPPORT_RUNTIME_OWNERSHIP_MISMATCH", "SUPPORT");
    }
    if (coexistenceMode !== "AICAKE_ACTIVE") return denied("SUPPORT_PAGE_OWNERSHIP_MISMATCH", "SUPPORT");
    if (page?.settings?.support_enabled !== true) return denied("PAGE_SUPPORT_NOT_ENABLED", "SUPPORT");
    return {
      allowed: true,
      reason: "AICAKE_PRIMARY_AIGUKA_ASSIST",
      mode: "SUPPORT",
      text_owner: ACTOR_AUTHORITY.AICAKE,
      media_owner: ACTOR_AUTHORITY.AIGUKA,
      followup_owner: channel === "followup" ? ACTOR_AUTHORITY.AIGUKA : null,
      operational_fallback_owner: ACTOR_AUTHORITY.AIGUKA,
    };
  }

  return denied("PAGE_MODE_OFF_OR_UNKNOWN", operatingMode || "OFF");
}

export function humanTakeoverActive(state = {}, nowMs = Date.now()) {
  if (!state?.human_takeover) return false;
  const until = Date.parse(String(state.human_takeover_until || ""));
  return !Number.isFinite(until) || until > nowMs;
}

