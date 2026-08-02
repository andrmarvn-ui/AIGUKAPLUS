import { PRODUCT_LABELS, normalizeVietnamese } from "./semantic-conversation-intelligence.js";

const unique = (values) => [...new Set((values || []).filter(Boolean))];
const GEMINI_MIN_INTERVAL_MS = Math.max(5_000, Number(process.env.AIGUKA_GEMINI_FREE_MIN_INTERVAL_MS || 8_000));
const GEMINI_MAX_COOLDOWN_MS = Math.max(60_000, Number(process.env.AIGUKA_GEMINI_FREE_MAX_COOLDOWN_MS || 300_000));

const geminiState = {
  nextAllowedAt: 0,
  cooldownUntil: 0,
  consecutive429: 0,
};

function contactKnown(snapshot = {}) {
  return Boolean(
    snapshot?.turn?.contact?.contactCaptured
    || snapshot?.customer?.phone
    || snapshot?.customer?.zalo
    || ["captured", "verified"].includes(String(snapshot?.state?.contact_status || "").toLowerCase())
  );
}

function productLabel(key, selectedKnowledge = {}) {
  const node = (selectedKnowledge.catalog || []).find((item) => item?.catalog_key === key);
  return node?.display_name || PRODUCT_LABELS[key] || String(key || "sản phẩm").replaceAll("_", " ");
}

function productListLabel(keys, selectedKnowledge = {}) {
  return unique(keys).map((key) => productLabel(key, selectedKnowledge)).join(", ");
}

function contactTail(shouldRequestContact) {
  return shouldRequestContact
    ? " Anh/chị có thể để lại SĐT/Zalo để bên em gửi báo giá và tư vấn đúng từng nhóm; nếu chưa tiện, bên em vẫn trao đổi trực tiếp tại Messenger ạ."
    : " Bên em sẽ trao đổi trực tiếp tại Messenger, không yêu cầu mình để lại SĐT/Zalo ạ.";
}

function safeDecision({
  action = "reply_text",
  final_reply = "",
  products = [],
  intents = [],
  needs_slides = false,
  should_request_contact = false,
  reason = "Semantic deterministic policy.",
  confidence = 0.99,
}) {
  return {
    action,
    final_reply,
    should_request_contact,
    contact_benefit: should_request_contact ? "Gửi báo giá và tư vấn đúng từng nhóm sản phẩm." : "",
    products: unique(products),
    intents: unique(intents),
    needs_slides,
    confidence,
    reason,
    risk_flags: ["semantic_deterministic"],
  };
}

function pendingText(signals = {}, selectedKnowledge = {}) {
  const pending = Array.isArray(signals.pendingProducts) ? signals.pendingProducts : [];
  if (!pending.length) return "";
  return ` Các nhóm đang để sau (${productListLabel(pending, selectedKnowledge)}) vẫn được giữ trong kế hoạch và sẽ không bị quên.`;
}

function activeProductText(products, selectedKnowledge = {}) {
  const labels = productListLabel(products, selectedKnowledge);
  if (products.length <= 1) return labels;
  return `${labels} (tách mẫu theo từng nhóm, không trộn catalog)`;
}

export function semanticDeterministicDecision(snapshot = {}, selectedKnowledge = {}) {
  const externalPolicy = String(snapshot.external_bot_policy || snapshot.external_bot_mode || "").toUpperCase();
  if (externalPolicy.includes("AICAKE_PRIMARY") || externalPolicy.includes("SUPPORT")) return null;

  const turn = snapshot.turn || {};
  const signals = turn.salesSignals || {};
  const intents = Array.isArray(signals.intents) ? signals.intents : [];
  const products = Array.isArray(signals.allowedProducts) && signals.allowedProducts.length
    ? unique(signals.allowedProducts)
    : Array.isArray(signals.products) ? unique(signals.products) : [];
  const primary = signals.primaryProduct || products[0] || null;
  const currentText = String(turn.combinedText || "");
  const normalized = normalizeVietnamese(currentText);
  const refused = signals.contactRefused === true || signals.preferredChannel === "messenger";
  const shouldRequest = Boolean(turn.shouldRequestContact && !contactKnown(snapshot) && !refused);
  const label = productLabel(primary, selectedKnowledge);
  const allLabels = activeProductText(products, selectedKnowledge);
  const isMulti = products.length > 1;

  if (turn?.contact?.newlyCaptured) {
    return safeDecision({
      action: "contact_captured",
      final_reply: "",
      products,
      intents,
      needs_slides: false,
      should_request_contact: false,
      reason: "Semantic policy: contact newly captured in current turn.",
    });
  }

  if (intents.includes("address")) {
    return safeDecision({
      final_reply: "Dạ showroom Ánh Dương tại 254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội ạ. Anh/chị cho em biết quận/huyện hiện tại để em hướng dẫn đường đi và kiểm tra hỗ trợ vận chuyển phù hợp nhé.",
      products,
      intents,
      should_request_contact: false,
      reason: "Semantic policy: verified address intent.",
    });
  }

  if (intents.includes("brand_verification")) {
    return safeDecision({
      final_reply: "Dạ với thông tin hiện có, bên em chưa thể khẳng định sản phẩm có phải của đúng thương hiệu anh/chị hỏi hay không và không nói đoán. Anh/chị gửi ảnh tem hoặc mã model trên thân/hộp, bên em sẽ kiểm tra và trả lời chính xác ngay tại Messenger ạ.",
      products,
      intents,
      should_request_contact: false,
      reason: "Semantic policy: brand must be verified from model/label evidence.",
    });
  }

  if (products.length === 1 && primary === "phong_bep") {
    return safeDecision({
      final_reply: `Dạ anh/chị đang cần tư vấn thiết bị phòng bếp. Mình đang ưu tiên bếp từ/máy hút mùi hay chậu vòi rửa bát để em gửi đúng nhóm trước ạ.${contactTail(shouldRequest)}`,
      products: [],
      intents,
      should_request_contact: shouldRequest,
      reason: "Semantic policy: broad kitchen-only request must be clarified before media.",
    });
  }

  if (products.length && (intents.includes("samples") || /\btu van\b/.test(normalized) || signals.multiProduct)) {
    const finalReply = isMulti
      ? `Dạ em ghi nhận đồng thời các nhu cầu: ${allLabels}. Em gửi mẫu chia đều theo từng nhóm để anh/chị xem, không quy toàn bộ về một sản phẩm.${pendingText(signals, selectedKnowledge)}${contactTail(shouldRequest)}`
      : `Dạ em ghi nhận đúng nhu cầu ${label}. Em gửi một số mẫu đúng nhóm để anh/chị xem trước.${pendingText(signals, selectedKnowledge)}${contactTail(shouldRequest)}`;
    return safeDecision({
      action: "reply_with_slides",
      final_reply: finalReply,
      products,
      intents,
      needs_slides: true,
      should_request_contact: shouldRequest,
      reason: isMulti
        ? "Semantic policy: complete multi-product request plan with balanced media."
        : "Semantic policy: hard product lock with sample/advice intent.",
    });
  }

  if (products.length && intents.includes("price")) {
    const refusalPrefix = refused
      ? "Dạ bên em trao đổi giá trực tiếp tại Messenger, không bắt buộc SĐT/Zalo. "
      : "Dạ ";
    const priceTarget = isMulti ? allLabels : label;
    return safeDecision({
      final_reply: `${refusalPrefix}Anh/chị đang hỏi giá cho ${priceTarget}. Giá phải theo đúng mã, màu và cấu hình của từng nhóm; hệ thống không có giá xác thực thì bên em không báo bừa.${contactTail(shouldRequest)}`,
      products,
      intents,
      should_request_contact: shouldRequest,
      reason: "Semantic policy: price intent keeps every active product group.",
    });
  }

  if (products.length && intents.includes("specs")) {
    const specTarget = isMulti ? allLabels : label;
    return safeDecision({
      final_reply: `Dạ anh/chị đang hỏi thông số cho ${specTarget}. Kích thước, công suất và cấu hình phải đối chiếu theo đúng mã của từng nhóm; bên em không lấy thông số của sản phẩm khác để trả lời ạ.`,
      products,
      intents,
      should_request_contact: false,
      reason: "Semantic policy: specs preserve every active product group.",
    });
  }

  if (products.length) {
    const finalReply = isMulti
      ? `Dạ em ghi nhận đồng thời các nhu cầu: ${allLabels}. Em gửi mẫu cân bằng theo từng nhóm, không trộn và không bỏ sót nhóm nào.${pendingText(signals, selectedKnowledge)}${contactTail(shouldRequest)}`
      : `Dạ em ghi nhận đúng nhu cầu ${label}. Em gửi mẫu đúng nhóm để anh/chị tham khảo trước.${pendingText(signals, selectedKnowledge)}${contactTail(shouldRequest)}`;
    return safeDecision({
      action: "reply_with_slides",
      final_reply: finalReply,
      products,
      intents,
      needs_slides: true,
      should_request_contact: shouldRequest,
      reason: isMulti
        ? "Semantic policy: hard multi-product request plan bypasses provider."
        : "Semantic policy: hard product lock bypasses provider.",
    });
  }

  if (refused) {
    return safeDecision({
      final_reply: "Dạ bên em sẽ trao đổi trực tiếp tại Messenger, không yêu cầu SĐT/Zalo. Anh/chị nói giúp em đúng sản phẩm hoặc hạng mục cần xem, bên em trả lời ngay tại đây ạ.",
      products: [],
      intents,
      should_request_contact: false,
      reason: "Semantic policy: customer explicitly prefers Messenger.",
    });
  }

  return null;
}

function stripContactRequest(value) {
  const text = String(value || "");
  return text
    .replace(/[^.!?\n]*(?:SĐT|số điện thoại|Zalo)[^.!?\n]*[.!?]?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function enforceSemanticProductLock(rawDecision, snapshot = {}) {
  if (!rawDecision || typeof rawDecision !== "object") return rawDecision;
  const signals = snapshot?.turn?.salesSignals || {};
  const allowed = Array.isArray(signals.allowedProducts) ? unique(signals.allowedProducts) : [];
  const refused = signals.contactRefused === true || signals.preferredChannel === "messenger";
  const result = { ...rawDecision };

  if (allowed.length) {
    const proposed = Array.isArray(result.products) ? unique(result.products.map(String)) : [];
    const invalid = proposed.filter((key) => !allowed.includes(key));
    const missing = allowed.filter((key) => !proposed.includes(key));

    // The request plan is authoritative. A provider may improve wording but cannot
    // drop requested groups or replace them with an advertising/mapping candidate.
    result.products = [...allowed];

    if (allowed.length > 1 && (result.needs_slides === true || result.action === "reply_with_slides")
      && (missing.length || invalid.length)) {
      const labels = allowed.map((key) => PRODUCT_LABELS[key] || key.replaceAll("_", " ")).join(", ");
      result.action = "reply_with_slides";
      result.needs_slides = true;
      result.final_reply = `Dạ em ghi nhận đồng thời các nhu cầu: ${labels}. Em gửi mẫu chia đều theo từng nhóm để anh/chị xem, không trộn catalog và không bỏ sót nhóm nào ạ.`;
      result.reason = `${result.reason || "Provider decision"}; corrected to complete multi-product request plan.`;
      result.risk_flags = unique([...(result.risk_flags || []), "multi_product_plan_restored"]);
    } else if (invalid.length) {
      result.reason = `${result.reason || "Provider decision"}; cross-catalog products removed by semantic lock.`;
      result.risk_flags = unique([...(result.risk_flags || []), "cross_catalog_corrected"]);
    }
  } else if (result.needs_slides === true) {
    result.action = "ask_clarification";
    result.needs_slides = false;
    result.products = [];
    result.final_reply = "Dạ anh/chị nói giúp em đúng sản phẩm hoặc hạng mục cần xem để bên em gửi chính xác, tránh gửi nhầm mẫu ạ.";
    result.reason = `${result.reason || "Provider decision"}; media blocked because no semantic product lock.`;
    result.risk_flags = unique([...(result.risk_flags || []), "semantic_product_unresolved"]);
  }

  if (refused) {
    result.should_request_contact = false;
    result.contact_benefit = "";
    result.final_reply = stripContactRequest(result.final_reply)
      || "Dạ bên em sẽ trao đổi trực tiếp tại Messenger, không yêu cầu SĐT/Zalo ạ.";
    result.risk_flags = unique([...(result.risk_flags || []), "messenger_preference"]);
  }
  return result;
}

function cooldownError() {
  const error = new Error("GEMINI_FREE_COOLDOWN_ACTIVE");
  error.code = "GEMINI_FREE_COOLDOWN_ACTIVE";
  error.retry_at = new Date(geminiState.cooldownUntil).toISOString();
  return error;
}

export async function semanticBeforeGeminiCall() {
  const now = Date.now();
  if (geminiState.cooldownUntil > now) throw cooldownError();
  const waitMs = Math.max(0, geminiState.nextAllowedAt - now);
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  geminiState.nextAllowedAt = Date.now() + GEMINI_MIN_INTERVAL_MS;
}

export function semanticAfterGeminiCall(status) {
  const code = Number(status || 0);
  if (code === 429) {
    geminiState.consecutive429 += 1;
    const cooldown = Math.min(
      GEMINI_MAX_COOLDOWN_MS,
      60_000 * (2 ** Math.max(0, geminiState.consecutive429 - 1)),
    );
    geminiState.cooldownUntil = Date.now() + cooldown;
    return;
  }
  if (code >= 200 && code < 300) {
    geminiState.consecutive429 = 0;
    geminiState.cooldownUntil = 0;
  }
}

export function semanticGeminiState() {
  return { ...geminiState, minIntervalMs: GEMINI_MIN_INTERVAL_MS };
}
