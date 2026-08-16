import { detectIntentCandidates, detectProductCandidates, normalizeVietnamese } from "../../v10/core/advisory-engine.js";

const ACTIONABLE_INTENTS = new Set([
  "address",
  "visit",
  "price",
  "samples",
  "specs",
  "delivery",
  "purchase",
  "brand",
  "wholesale",
]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function customerPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  const normalized = digits.startsWith("84") ? `0${digits.slice(2)}` : digits;
  return /^0\d{9}$/.test(normalized) ? normalized : null;
}

function commentValue(input = {}) {
  const payload = object(input.payload);
  return object(
    payload?.change?.value
      || payload?.raw_payload?.change?.value
      || input?.change?.value
      || input?.raw_payload?.change?.value,
  );
}

export function commentPrivateReplyEligibility(input = {}) {
  const value = commentValue(input);
  const messageText = String(input.message_text ?? input.text ?? value.message ?? "").trim();
  const normalized = normalizeVietnamese(messageText);
  const pageId = String(input.page_id || "").trim();
  const senderId = String(input.sender_id || value?.from?.id || "").trim();
  const commentId = String(input.comment_id || value.comment_id || "").trim();

  if (!commentId) return { eligible: false, reason: "COMMENT_ID_MISSING", messageText, commentId: null };
  if (!senderId || (pageId && senderId === pageId)) {
    return { eligible: false, reason: "PAGE_OR_MISSING_SENDER", messageText, commentId };
  }
  if (!normalized || !/[a-z0-9]/.test(normalized)) {
    return { eligible: false, reason: "EMPTY_OR_SYMBOL_ONLY", messageText, commentId };
  }

  const phone = customerPhone(messageText);
  if (phone) {
    return {
      eligible: true,
      reason: "CONTACT_IN_COMMENT_REQUIRES_PRIVATE_ACK",
      messageText,
      commentId,
      phone,
      intents: ["contact_captured"],
      products: [],
    };
  }
  if (/\b(stop|unsubscribe|dung nhan tin|khong nhan tin|huy dang ky)\b/.test(normalized)) {
    return { eligible: false, reason: "OPT_OUT", messageText, commentId };
  }
  if (/\b(lua dao|lừa đảo|bao cong an|bao công an|khieu nai|khiếu nại|phan anh|phản ánh)\b/i.test(messageText)) {
    return { eligible: false, reason: "COMPLAINT_REQUIRES_HUMAN", messageText, commentId };
  }

  const intents = detectIntentCandidates(messageText).map((item) => item.key);
  const products = detectProductCandidates(messageText)
    .filter((item) => item.type === "product")
    .map((item) => item.key);
  const codeLike = /\b[A-Za-z]{1,10}[-_.\/]?\d{2,8}[A-Za-z0-9._\/-]*\b/.test(messageText);
  const inboxRequest = /\b(ib(?:ok|oke|oki)?|inbox|check ib|nhắn riêng|nhan rieng|nhắn tin|nhan tin)\b/.test(normalized);
  const branchRequest = /\b(chi nhanh|chinhanh|co chi nhanh|có chi nhánh)\b/i.test(normalized);
  const commercialPhrase = /\b(cho minh|cho toi|cho anh|cho chi|xin|quan tam|tu van|muon mua|can mua|bao nhieu|o dau|cua hang|showroom|chi nhanh|mau nay|loai nay|san pham nay|xem[ ./-]*(?:mau|anh|hinh)|sao[ ./-]*(?:re|mac)|(?:re|mac)[ ./-]*vay)\b/.test(normalized);
  const actionable = intents.some((intent) => ACTIONABLE_INTENTS.has(intent))
    || products.length > 0
    || codeLike
    || inboxRequest
    || branchRequest
    || commercialPhrase;

  return {
    eligible: actionable,
    reason: actionable ? "ACTIONABLE_CUSTOMER_COMMENT" : "NON_COMMERCIAL_COMMENT",
    messageText,
    commentId,
    intents,
    products,
  };
}

export function commentPrivateReplyContextFromMessages(messages = []) {
  const customerMessages = (Array.isArray(messages) ? messages : []).filter((message) => message?.role === "customer");
  const latest = customerMessages.at(-1) || null;
  if (!latest || String(latest.event_type || "").toLowerCase() !== "customer_comment") return null;

  const value = commentValue(latest);
  const commentId = String(latest.comment_id || value.comment_id || "").trim();
  if (!commentId) return null;
  const eligibility = commentPrivateReplyEligibility({
    ...latest,
    message_text: latest.text,
    comment_id: commentId,
    sender_id: value?.from?.id,
  });
  if (!eligibility.eligible) return null;

  return {
    channel: "facebook_comment_private_reply",
    deliveryMode: "comment_private_reply",
    commentId,
    postId: String(value.post_id || value?.post?.id || "").trim() || null,
    parentId: String(value.parent_id || "").trim() || null,
    customerId: String(value?.from?.id || "").trim() || null,
    sourceEventId: String(latest.id || "").trim() || null,
    phoneInComment: Boolean(eligibility.phone),
    publicReplyForbidden: true,
  };
}

export const commentPrivateReplyVersion = "v10_comment_private_reply_v3_branch_compact_inbox";
