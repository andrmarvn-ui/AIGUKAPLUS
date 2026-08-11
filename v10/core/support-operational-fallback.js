import { normalizeVietnamese } from "./advisory-engine.js";
import { deriveMediaScope, mediaExpectedFromMessages } from "./media-obligation.js";

function customerMessages(inputSnapshot = {}) {
  return (inputSnapshot?.conversation?.messages || []).filter((message) => message?.role === "customer");
}

function latestActiveCustomerMessage(messages = []) {
  return [...messages].reverse().find((message) => {
    const semantic = String(message?.semantic_status || "active").toLowerCase();
    return !["superseded", "cancelled"].includes(semantic);
  }) || messages.at(-1) || null;
}

function activeMessagesAfterCancellation(messages = []) {
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const relation = String(messages[index]?.semantic_relation || "").toUpperCase();
    const status = String(messages[index]?.semantic_status || "active").toLowerCase();
    if (relation === "CANCEL" || ["cancelled", "superseded"].includes(status)) {
      boundary = index;
      break;
    }
  }
  return messages.slice(boundary + 1);
}

function unique(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function contactKnown(inputSnapshot = {}) {
  const state = inputSnapshot?.state || {};
  const customer = inputSnapshot?.customer || {};
  return Boolean(
    state.phone
    || state.zalo
    || customer.phone
    || customer.zalo
    || ["captured", "verified"].includes(String(state.contact_status || "").toLowerCase()),
  );
}

function productCandidates(inputSnapshot = {}) {
  return inputSnapshot?.conversation?.advisors?.product_candidates || [];
}

function productLabels(inputSnapshot = {}) {
  return unique(productCandidates(inputSnapshot).map((candidate) => candidate?.label || candidate?.key)).slice(0, 3);
}

function latestSemanticText(message = {}) {
  return normalizeVietnamese([
    message?.text,
    message?.postback?.effective_payload,
    message?.postback?.payload,
  ].filter(Boolean).join(" "));
}

function isTrivialAcknowledgement(value) {
  const text = normalizeVietnamese(value).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return true;
  return /^(?:ok|oke|okay|oki|uh|u|vang|da|cam on|thanks|thank you|hieu roi|biet roi|roi|the nhe|nhe|a|ah)$/.test(text);
}

function asksAddress(value) {
  const text = normalizeVietnamese(value);
  return /\b(dia chi|cua hang|showroom|shop o dau|o cho nao|cho nao|pho keo)\b/.test(text);
}

function contactOnly(value) {
  const text = String(value || "").trim();
  return /^(?:\+?84|0)[0-9 .-]{8,13}[a-z]?$/i.test(text) || /^zalo\s*[:\-]?\s*(?:\+?84|0)[0-9 .-]{8,13}$/i.test(text);
}

function visitOrAppointment(value) {
  const text = normalizeVietnamese(value);
  return /\b(sang mai|chieu mai|ngay mai|mai qua|mai den|hom nua|may hom nua|se qua|qua cua hang|ra cua hang|hen)\b/.test(text);
}

function mediaReply(labels = []) {
  const subject = labels.length ? labels.join(", ") : "sản phẩm anh/chị đang quan tâm";
  return `Dạ, em gửi anh/chị các mẫu ${subject} để tham khảo trước ạ.`;
}

function safeProductReply(labels = [], knownContact = false) {
  const subject = labels.length ? labels.join(", ") : "sản phẩm anh/chị đang quan tâm";
  if (knownContact) {
    return `Dạ em đã nhận yêu cầu về ${subject}. Em chuyển sale kiểm tra đúng mẫu, giá và thông số rồi liên hệ lại anh/chị sớm ạ.`;
  }
  return `Dạ em đã nhận yêu cầu về ${subject}. Anh/chị cho em xin SĐT/Zalo để sale kiểm tra đúng mẫu, giá và thông số rồi báo lại nhanh ạ.`;
}

export function buildSupportOperationalFallback(inputSnapshot = {}, availableSlideKeys = new Set()) {
  const messages = customerMessages(inputSnapshot);
  const activeMessages = activeMessagesAfterCancellation(messages);
  const latest = latestActiveCustomerMessage(activeMessages);
  const latestText = String(latest?.text || "").trim();
  const latestSemantic = latestSemanticText(latest);
  const labels = productLabels(inputSnapshot);
  const knownContact = contactKnown(inputSnapshot);
  const selectedCatalogKeys = deriveMediaScope(messages, availableSlideKeys, {
    productCandidates: productCandidates(inputSnapshot),
  });
  const shouldSendMedia = mediaExpectedFromMessages(messages, selectedCatalogKeys);

  if (shouldSendMedia && selectedCatalogKeys.length) {
    return {
      kind: "media",
      action: "reply_with_slides",
      final_reply: mediaReply(labels),
      needs_slides: true,
      selected_products: labels,
      selected_catalog_keys: selectedCatalogKeys,
      should_request_contact: !knownContact,
      reason: "overdue_support_media_obligation",
    };
  }

  const latestSubstantive = [...activeMessages].reverse().find((message) => !isTrivialAcknowledgement(latestSemanticText(message))) || null;
  if (isTrivialAcknowledgement(latestSemantic) && !latestSubstantive) {
    return {
      kind: "suppress",
      action: "suppress",
      final_reply: "",
      needs_slides: false,
      selected_products: [],
      selected_catalog_keys: [],
      should_request_contact: false,
      reason: "trivial_acknowledgement_without_media_obligation",
    };
  }

  // A short acknowledgement cannot erase an older unanswered need in the same
  // customer cluster. Outbound still verifies AICake/Page activity before sending,
  // so this only closes the silence gap when the primary bot truly did not reply.
  const effective = isTrivialAcknowledgement(latestSemantic) ? latestSubstantive : latest;
  const effectiveText = String(effective?.text || "").trim();
  const effectiveSemantic = latestSemanticText(effective);

  if (asksAddress(effectiveSemantic)) {
    return {
      kind: "text",
      action: "reply_text",
      final_reply: "Dạ showroom Ánh Dương ở 254 Phố Keo, Gia Lâm, Hà Nội ạ. Hotline: 0973693677.",
      needs_slides: false,
      selected_products: [],
      selected_catalog_keys: [],
      should_request_contact: false,
      reason: "verified_showroom_address_fallback",
    };
  }

  if (contactOnly(effectiveText) || (knownContact && /\b(sdt|so dien thoai|zalo)\b/.test(effectiveSemantic))) {
    return {
      kind: "text",
      action: "reply_text",
      final_reply: "Dạ em đã nhận SĐT/Zalo của anh/chị. Em chuyển sale liên hệ tư vấn sớm ạ.",
      needs_slides: false,
      selected_products: labels,
      selected_catalog_keys: [],
      should_request_contact: false,
      reason: "contact_capture_acknowledgement_fallback",
    };
  }

  if (visitOrAppointment(effectiveSemantic)) {
    return {
      kind: "text",
      action: "reply_text",
      final_reply: "Dạ vâng ạ, showroom Ánh Dương ở 254 Phố Keo, Gia Lâm, Hà Nội. Anh/chị qua xem trực tiếp, bên em sẽ hỗ trợ chọn mẫu ạ.",
      needs_slides: false,
      selected_products: labels,
      selected_catalog_keys: [],
      should_request_contact: false,
      reason: "showroom_visit_acknowledgement_fallback",
    };
  }

  if (labels.length) {
    return {
      kind: "text",
      action: "reply_text",
      final_reply: safeProductReply(labels, knownContact),
      needs_slides: false,
      selected_products: labels,
      selected_catalog_keys: [],
      should_request_contact: !knownContact,
      reason: "safe_product_handoff_fallback",
    };
  }

  return {
    kind: "text",
    action: "reply_text",
    final_reply: "Dạ em đã nhận tin nhắn của anh/chị. Anh/chị cần xem mẫu hoặc tư vấn sản phẩm nào để em hỗ trợ đúng nhu cầu ạ?",
    needs_slides: false,
    selected_products: [],
    selected_catalog_keys: [],
    should_request_contact: false,
    reason: "generic_no_drop_acknowledgement_fallback",
  };
}

export function supportFallbackCustomerAt(inputSnapshot = {}) {
  const times = customerMessages(inputSnapshot)
    .map((message) => Date.parse(message?.occurred_at || ""))
    .filter(Number.isFinite);
  const stateAt = Date.parse(inputSnapshot?.state?.last_customer_event_at || "");
  if (Number.isFinite(stateAt)) times.push(stateAt);
  return Math.max(0, ...times);
}

export const supportOperationalFallbackVersion = "v10_support_operational_fallback_v3_no_silent_ack_gap";
