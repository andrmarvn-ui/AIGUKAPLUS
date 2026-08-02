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
    ? " Anh/chị có thể để lại SĐT/Zalo để bên em gửi báo giá và tư vấn đúng mã; nếu chưa tiện, bên em vẫn trao đổi trực tiếp tại Messenger ạ."
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
    contact_benefit: should_request_contact ? "Gửi báo giá và tư vấn đúng mã sản phẩm." : "",
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
  return ` Các nhóm còn lại (${productListLabel(pending, selectedKnowledge)}) sẽ được tách riêng để không lẫn mẫu.`;
}

export function semanticDeterministicDecision(snapshot = {}, selectedKnowledge = {}) {
  const externalPolicy = String(snapshot.external_bot_policy || snapshot.external_bot_mode || "").toUpperCase();
  if (externalPolicy.includes("AICAKE_PRIMARY") || externalPolicy.includes("SUPPORT")) return null;
  const turn = snapshot.turn || {};
  const signals = turn.salesSignals || {};
  const intents = Array.isArray(signals.intents) ? signals.intents : [];
  const products = Array.isArray(signals.allowedProducts) && signals.allowedProducts.length
    ? signals.allowedProducts
    : Array.isArray(signals.products) ? signals.products : [];
  const primary = signals.primaryProduct || products[0] || null;
  const currentText = String(turn.combinedText || "");
  const normalized = normalizeVietnamese(currentText);
  const refused = signals.contactRefused === true || signals.preferredChannel === "messenger";
  const shouldRequest = Boolean(turn.shouldRequestContact && !contactKnown(snapshot) && !refused);
  const label = productLabel(primary, selectedKnowledge);

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

  if (primary === "phong_bep") {
    return safeDecision({
      final_reply: `Dạ anh/chị đang cần tư vấn thiết bị phòng bếp. Mình đang ưu tiên bếp từ/máy hút mùi hay chậu vòi rửa bát để em gửi đúng nhóm trước ạ.${contactTail(shouldRequest)}`,
      products: [],
      intents,
      should_request_contact: shouldRequest,
      reason: "Semantic policy: broad kitchen request must be clarified before media.",
    });
  }

  if (primary && (intents.includes("samples") || /\btu van\b/.test(normalized) || signals.multiProduct)) {
    const finalReply = `Dạ em ghi nhận đúng nhu cầu ${label}. Em gửi một số mẫu đúng nhóm để anh/chị xem trước.${pendingText(signals, selectedKnowledge)}${contactTail(shouldRequest)}`;
    return safeDecision({
      action: "reply_with_slides",
      final_reply: finalReply,
      products: [primary],
      intents,
      needs_slides: true,
      should_request_contact: shouldRequest,
      reason: "Semantic policy: hard product lock with sample/advice intent.",
    });
  }

  if (primary && intents.includes("price")) {
    const refusalPrefix = refused
      ? "Dạ bên em trao đổi giá trực tiếp tại Messenger, không bắt buộc SĐT/Zalo. "
      : "Dạ ";
    return safeDecision({
      final_reply: `${refusalPrefix}Anh/chị đang hỏi giá ${label}. Giá phải theo đúng mã, màu và cấu hình; hệ thống không có giá xác thực của đúng mã thì bên em không báo bừa.${contactTail(shouldRequest)}`,
      products: [primary],
      intents,
      should_request_contact: shouldRequest,
      reason: "Semantic policy: known product price intent without verified price data.",
    });
  }

  if (primary && intents.includes("specs")) {
    return safeDecision({
      final_reply: `Dạ anh/chị đang hỏi thông số ${label}. Sải cánh, công suất và kích thước phải theo đúng mã sản phẩm; bên em sẽ đối chiếu ảnh/mã hiện có và trả lời trực tiếp tại Messenger, không lấy thông số của mẫu khác ạ.`,
      products: [primary],
      intents,
      should_request_contact: false,
      reason: "Semantic policy: specs require exact model evidence.",
    });
  }

  if (primary) {
    return safeDecision({
      action: "reply_with_slides",
      final_reply: `Dạ em ghi nhận đúng nhu cầu ${label}. Em gửi mẫu đúng nhóm để anh/chị tham khảo trước.${pendingText(signals, selectedKnowledge)}${contactTail(shouldRequest)}`,
      products: [primary],
      intents,
      needs_slides: true,
      should_request_contact: shouldRequest,
      reason: "Semantic policy: hard product lock bypasses provider.",
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
  const cleaned = text
    .replace(/[^.!?\n]*(?:SĐT|số điện thoại|Zalo)[^.!?\n]*[.!?]?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned;
}

export function enforceSemanticProductLock(rawDecision, snapshot = {}) {
  if (!rawDecision || typeof rawDecision !== "object") return rawDecision;
  const signals = snapshot?.turn?.salesSignals || {};
  const allowed = Array.isArray(signals.allowedProducts) ? unique(signals.allowedProducts) : [];
  const refused = signals.contactRefused === true || signals.preferredChannel === "messenger";
  const result = { ...rawDecision };

  if (allowed.length) {
    const proposed = Array.isArray(result.products) ? unique(result.products.map(String)) : [];
    const safe = proposed.filter((key) => allowed.includes(key));
    result.products = safe.length ? safe : [allowed[0]];
    if (result.needs_slides === true && result.products.length > 1) result.products = [result.products[0]];
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
