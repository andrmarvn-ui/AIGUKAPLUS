import fs from "node:fs";

const file = "v10-ai-worker-v2.js";
const MARK = "AIGUKA_V10_DECISION_INTEGRITY_V3";
if (!fs.existsSync(file)) throw new Error("V10_DECISION_INTEGRITY_V3_WORKER_MISSING");
let source = fs.readFileSync(file, "utf8");

if (!source.includes(MARK)) {
  const processMarker = "async function processOne(row, availableProviders, knowledgeSnapshot) {";
  if (!source.includes(processMarker)) throw new Error("V10_DECISION_INTEGRITY_V3_PROCESS_TARGET_MISSING");

  const helpers = String.raw`
function qualityNormalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9\s/+_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const DECISION_LEAK_PATTERN = /(selected_catalog_keys|selected_products|final_reply|decision_reason|needs_slides|follow_up_plan|tool[_ .-]?call|system prompt|schema|not a valid key|we need|customer mentioned|provide concise|keep reply|internal reasoning|analysis:|assistant to=|developer message|hidden instruction|zddw)/i;
const DECISION_GIBBERISH_PATTERN = /[ŏŎ]|\b(showoom|bèn em|phó keo|gia làm|nŏii)\b/i;

function customerMessagesFrom(modelInput) {
  const messages = modelInput && modelInput.conversation && Array.isArray(modelInput.conversation.messages)
    ? modelInput.conversation.messages
    : [];
  return messages.filter(function (message) { return message && message.role === "customer"; });
}

function salutationStyle(modelInput) {
  const recent = customerMessagesFrom(modelInput).slice(-12).map(function (message) { return String(message.text || ""); }).join(" ");
  const normalized = qualityNormalize(recent);
  const customer = modelInput && modelInput.customer ? modelInput.customer : {};
  const preferred = qualityNormalize(customer.preferred_salutation || "");
  if (/\bco\b/.test(normalized) || preferred === "co") return { customer: "cô", self: "cháu" };
  if (/\bchu\b/.test(normalized) || preferred === "chu") return { customer: "chú", self: "cháu" };
  if (/\bbac\b/.test(normalized) || preferred === "bac") return { customer: "bác", self: "cháu" };
  if (/\bchi\b/.test(normalized) || preferred === "chi") return { customer: "chị", self: "em" };
  if (/\banh\b/.test(normalized) || preferred === "anh") return { customer: "anh", self: "em" };
  return { customer: "anh/chị", self: "em" };
}

function applySalutation(value, style) {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return text;
  if (["cô", "chú", "bác"].includes(style.customer)) {
    text = text
      .replace(/\banh\s*\/\s*chị\b/gi, style.customer)
      .replace(/\banh chị\b/gi, style.customer)
      .replace(/\bchị\b/gi, style.customer)
      .replace(/\banh\b/gi, style.customer)
      .replace(/\bbên em\b/gi, "bên " + style.self)
      .replace(/\bem\b/gi, style.self);
    if (!(new RegExp("\\b" + style.customer + "\\b", "i")).test(text)) {
      text = "Dạ " + style.customer + ", " + text.charAt(0).toLocaleLowerCase("vi-VN") + text.slice(1);
    }
  } else if (style.customer === "chị") {
    text = text.replace(/\banh\s*\/\s*chị\b/gi, "chị").replace(/\banh chị\b/gi, "chị");
  } else if (style.customer === "anh") {
    text = text.replace(/\banh\s*\/\s*chị\b/gi, "anh").replace(/\banh chị\b/gi, "anh");
  }
  return text;
}

function contactIsKnown(modelInput) {
  const state = modelInput && modelInput.state ? modelInput.state : {};
  const customer = modelInput && modelInput.customer ? modelInput.customer : {};
  return Boolean(state.phone || state.zalo || customer.phone || customer.zalo || ["captured", "verified", "known"].includes(String(state.contact_status || "").toLowerCase()));
}

function exactCatalogContext(modelInput) {
  const advisor = modelInput && modelInput.knowledge_advisors ? modelInput.knowledge_advisors : {};
  const catalog = Array.isArray(advisor.catalog) ? advisor.catalog : [];
  const allowed = new Map();
  for (const item of catalog) {
    const key = String(item && item.catalog_key || "").trim();
    if (key) allowed.set(key, item);
  }
  const slideSource = Array.isArray(advisor.slide_catalog)
    ? advisor.slide_catalog
    : catalog.filter(function (item) { return Number(item && item.asset_count || 0) > 0; });
  const slide = new Set(slideSource.map(function (item) { return String(item && item.catalog_key || "").trim(); }).filter(Boolean));
  return { allowed: allowed, slide: slide };
}

function canonicalCatalogKey(value, allowed) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 100 || DECISION_LEAK_PATTERN.test(raw)) return "";
  const clean = raw.replace(/^[\s\[\]\x60'\"]+|[\s\[\]\x60'\".,;:]+$/g, "");
  return allowed.has(clean) ? clean : "";
}

function latestExplicitText(modelInput) {
  const messages = customerMessagesFrom(modelInput);
  const latest = messages.length ? messages[messages.length - 1] : null;
  return qualityNormalize(latest && latest.text || "");
}

function activeProductText(modelInput) {
  return qualityNormalize(customerMessagesFrom(modelInput).slice(-5).map(function (message) { return message.text || ""; }).join(" "));
}

function scopedSlideKeys(modelInput, slideKeys) {
  const latest = latestExplicitText(modelInput);
  const active = activeProductText(modelInput);
  const output = [];
  function key(value) { return slideKeys.has(value) ? value : null; }
  function add() {
    for (const value of arguments) {
      if (value && !output.includes(value)) output.push(value);
    }
  }

  const sink = /\b(chau|voi rua|bon rua|rua bat|rua chen)\b/.test(latest);
  const stove = /\b(bep tu|hut mui|may hut|hut khoi)\b/.test(latest);
  const broadKitchen = /\b(phong bep|nha bep|noi that.{0,12}bep|thiet bi.{0,12}bep|toan bo.{0,20}bep|bep an)\b/.test(latest || active);
  const bathroom = /\b(phong tam|nha tam|nha ve sinh|thiet bi ve sinh|combo.{0,10}(tam|ve sinh))\b/.test(latest || active);
  const toilet = /\b(bon cau|bet lien khoi|bet thong minh)\b/.test(latest);
  const fan = /\b(quat tran|quat 10 canh|quat 8 canh|quat 5 canh|quat 6 canh)\b/.test(latest || active);

  if (sink) add(key("chau_voi_rua_bat"));
  else if (stove) add(key("bep_tu_hut_mui"), key("bep_tu"), key("may_hut_mui"));
  else if (broadKitchen) add(key("bep_tu_hut_mui"), key("chau_voi_rua_bat"));

  if (toilet) add(key("bon_cau"), key("bon_cau_lien_khoi"), key("bon_cau_thong_minh"));
  else if (bathroom) add(key("combo_phong_tam_ban_chay"), key("combo_phong_tam_dep_moi"), key("combo_phong_tam"));

  if (fan) add(key("quat_10_canh_gold"), key("quat_10_canh_wood"), key("quat_10_canh_black"), key("quat_10_canh_brown"), key("quat_tran"));
  return output;
}

function enforceDecisionIntegrity(input, modelInput) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("V10_DECISION_INTEGRITY_OBJECT_REQUIRED");
  const decision = structuredClone(input);
  const modelValueText = [
    decision.final_reply,
    decision.decision_reason,
    decision.contact_benefit,
    ...(Array.isArray(decision.intents) ? decision.intents : []),
    ...(Array.isArray(decision.selected_products) ? decision.selected_products : []),
    ...(Array.isArray(decision.selected_catalog_keys) ? decision.selected_catalog_keys : []),
    ...(Array.isArray(decision.follow_up_plan) ? decision.follow_up_plan : []),
  ].map(function (value) { return String(value || ""); }).join(" ");
  if (DECISION_LEAK_PATTERN.test(modelValueText)) throw new Error("V10_DECISION_INTERNAL_TEXT_REJECTED");

  const reply = String(decision.final_reply || "").trim();
  if (DECISION_GIBBERISH_PATTERN.test(reply)) throw new Error("V10_DECISION_GIBBERISH_REJECTED");
  if (reply === "final_reply" || reply === "reply" || reply.length > 650) throw new Error("V10_DECISION_REPLY_INVALID");

  const catalogContext = exactCatalogContext(modelInput);
  const allowed = catalogContext.allowed;
  const slide = catalogContext.slide;
  const selected = [];
  const rawKeys = Array.isArray(decision.selected_catalog_keys) ? decision.selected_catalog_keys : [];
  for (const value of rawKeys) {
    const selectedKey = canonicalCatalogKey(value, allowed);
    if (selectedKey && !selected.includes(selectedKey)) selected.push(selectedKey);
  }

  const scope = scopedSlideKeys(modelInput, slide);
  if (scope.length && (decision.needs_slides || decision.action === "reply_with_slides")) {
    decision.selected_catalog_keys = scope.slice(0, 6);
  } else {
    decision.selected_catalog_keys = selected.filter(function (selectedKey) { return slide.has(selectedKey); }).slice(0, 6);
  }

  if (decision.needs_slides || decision.action === "reply_with_slides") {
    if (!decision.selected_catalog_keys.length) {
      decision.needs_slides = false;
      if (decision.action === "reply_with_slides") decision.action = "reply_text";
    } else {
      decision.needs_slides = true;
      decision.action = "reply_with_slides";
    }
  }

  decision.selected_products = decision.selected_catalog_keys.map(function (selectedKey) {
    const item = allowed.get(selectedKey);
    return String(item && item.display_name || selectedKey);
  });

  const known = contactIsKnown(modelInput);
  if (known) {
    decision.contact_state = "known";
    decision.should_request_contact = false;
  }

  const latest = latestExplicitText(modelInput);
  const style = salutationStyle(modelInput);
  if (known && /\b(goi di|goi cho co|dang ranh|co dang ranh)\b/.test(latest)) {
    decision.action = "reply_text";
    decision.needs_slides = false;
    decision.selected_catalog_keys = [];
    decision.selected_products = [];
    decision.contact_state = "known";
    decision.should_request_contact = false;
    decision.final_reply = "Dạ " + style.customer + ", " + style.self + " đã ghi nhận số và chuyển yêu cầu gọi tư vấn ngay ạ.";
  } else {
    decision.final_reply = applySalutation(reply, style);
  }

  if (DECISION_LEAK_PATTERN.test(String(decision.final_reply || ""))) throw new Error("V10_DECISION_FINAL_REPLY_LEAK_REJECTED");
  return decision;
}
// ${MARK}
`;

  source = source.replace(processMarker, helpers + "\n" + processMarker);
  const callTarget = "        result = await providerCall(provider, modelInput);";
  if (!source.includes(callTarget)) throw new Error("V10_DECISION_INTEGRITY_V3_CALL_TARGET_MISSING");
  source = source.replace(callTarget, callTarget + "\n        result.decision = enforceDecisionIntegrity(result.decision, modelInput);");

  source = source.replace(/v10_ai_quota_aware_balancer_v\d+/, "v10_ai_quality_guard_v7");
  const heartbeatTarget = "        provider_failover_enabled: true,";
  if (!source.includes(heartbeatTarget)) throw new Error("V10_DECISION_INTEGRITY_V3_HEARTBEAT_TARGET_MISSING");
  source = source.replace(heartbeatTarget, heartbeatTarget + "\n        decision_integrity_guard: true,\n        exact_catalog_guard: true,\n        salutation_guard: true,\n        context_documents_deduplicated: true,");

  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA V10] decision integrity v3 enabled: exact catalog, clean output and salutation guard");
}
