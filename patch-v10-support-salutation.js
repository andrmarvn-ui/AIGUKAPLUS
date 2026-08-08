import fs from "node:fs";

const FILE = "v10-outbound-worker.js";
const MARK = "AIGUKA_V10_SUPPORT_SALUTATION_V1";

if (!fs.existsSync(FILE)) throw new Error("V10_SUPPORT_SALUTATION_OUTBOUND_MISSING");
let source = fs.readFileSync(FILE, "utf8");

if (!source.includes(MARK)) {
  const oldCaptionStart = "function supportSlideCaption(gate, decision) {";
  const oldCaptionEnd = "\n\nfunction supportCompactImageReply(gate) {";
  const start = source.indexOf(oldCaptionStart);
  const end = source.indexOf(oldCaptionEnd, start);
  if (start < 0 || end < 0) throw new Error("V10_SUPPORT_SALUTATION_CAPTION_RANGE_MISSING");

  const helpers = String.raw`
function supportSalutationFromAI(decision) {
  let text = normalizeVietnamese(String(decision?.output?.final_reply || ""));
  text = text.replace(/\banh\s*\/\s*chi\b/g, " ").replace(/\banh\s+chi\b/g, " ");
  const hasAnh = /(^|\s|[,.!?;:])anh(?=\s|[,.!?;:]|$)/.test(text);
  const hasChi = /(^|\s|[,.!?;:])chi(?=\s|[,.!?;:]|$)/.test(text);
  if (hasAnh === hasChi) return null;
  return { value: hasAnh ? "anh" : "chị", source: "ai_reply" };
}

function supportSalutationFromCustomer(customer) {
  const preferred = normalizeVietnamese(String(customer?.preferred_salutation || "")).trim();
  if (preferred === "anh") return { value: "anh", source: "preferred_salutation" };
  if (preferred === "chi") return { value: "chị", source: "preferred_salutation" };
  const gender = normalizeVietnamese(String(customer?.gender || "")).trim();
  if (["male", "nam", "man"].includes(gender)) return { value: "anh", source: "meta_gender" };
  if (["female", "nu", "woman"].includes(gender)) return { value: "chị", source: "meta_gender" };
  return null;
}

async function supportCustomerIdentity(pageId, senderId) {
  const rows = await core(
    "v9_customers?select=display_name,gender,preferred_salutation&page_id=eq." + encodeURIComponent(pageId)
      + "&customer_id=eq." + encodeURIComponent(senderId)
      + "&limit=1",
    { timeout: 8000 },
  ).catch(() => []);
  return rows?.[0] || {};
}

function supportResolveSalutation(customer, decision) {
  return supportSalutationFromCustomer(customer)
    || supportSalutationFromAI(decision)
    || { value: null, source: "neutral_omission" };
}

function supportCarouselSubtitle(salutation) {
  if (salutation === "anh") return "Một vài mẫu bán chạy để anh tham khảo trước";
  if (salutation === "chị") return "Một vài mẫu bán chạy để chị tham khảo trước";
  return "Một vài mẫu bán chạy để tham khảo trước";
}

function supportSlideCaption(gate, decision) {
  const recentContactRequest = supportReplyRequestsContact(gate?.livePageReply)
    || String(decision?.output?.contact_state || "").toLowerCase() === "missing_recently_requested";
  const salutation = gate?.supportSalutation || null;
  const lead = salutation ? "Em gửi " + salutation + " một số mẫu bán chạy để " + salutation + " tham khảo trước" : "Em gửi một số mẫu bán chạy để tham khảo trước";
  if (gate?.contactKnown || recentContactRequest) return lead + " ạ.";
  if (salutation) return lead + "; nếu cần đúng mẫu và báo giá chính xác, " + salutation + " cho em xin SĐT/Zalo nhé.";
  return lead + "; nếu cần đúng mẫu và báo giá chính xác, cho em xin SĐT/Zalo nhé.";
}

// ${MARK}
`;

  source = source.slice(0, start) + helpers + source.slice(end + 2);

  const stateAnchor = "  const state = await stateRow(decision.page_id, decision.sender_id);\n  const takeoverUntil = Date.parse(state.human_takeover_until || \"\");";
  if (!source.includes(stateAnchor)) throw new Error("V10_SUPPORT_SALUTATION_STATE_ANCHOR_MISSING");
  source = source.replace(stateAnchor, `  const state = await stateRow(decision.page_id, decision.sender_id);\n  const supportCustomer = supportMode ? await supportCustomerIdentity(decision.page_id, decision.sender_id) : {};\n  const supportSalutationInfo = supportMode ? supportResolveSalutation(supportCustomer, decision) : { value: null, source: null };\n  const takeoverUntil = Date.parse(state.human_takeover_until || "");`);

  source = source.replace(
    'text = stripRepeatedContactRequest(text) || "Dạ em đã nhận nội dung của anh/chị và tiếp tục tư vấn tại Messenger ạ.";',
    'text = stripRepeatedContactRequest(text) || "Dạ em đã nhận nội dung và tiếp tục hỗ trợ tại Messenger ạ.";',
  );

  const returnAnchor = "    livePageReply,\n  };";
  if (!source.includes(returnAnchor)) throw new Error("V10_SUPPORT_SALUTATION_RETURN_ANCHOR_MISSING");
  source = source.replace(returnAnchor, `    livePageReply,\n    supportSalutation: supportSalutationInfo.value,\n    supportSalutationSource: supportSalutationInfo.source,\n    supportCustomerName: supportCustomer?.display_name || null,\n  };`);

  const carouselSignature = "async function sendCarousel(pageId, recipientId, assets) {";
  if (!source.includes(carouselSignature)) throw new Error("V10_SUPPORT_SALUTATION_CAROUSEL_SIGNATURE_MISSING");
  source = source.replace(carouselSignature, "async function sendCarousel(pageId, recipientId, assets, salutation = null) {");
  source = source.replace(
    'subtitle: "Một vài mẫu bán chạy để anh/chị tham khảo trước",',
    'subtitle: supportCarouselSubtitle(salutation),',
  );

  const carouselCall = "const result = await sendCarousel(claimed.page_id, claimed.sender_id, batches[index]);";
  if (!source.includes(carouselCall)) throw new Error("V10_SUPPORT_SALUTATION_CAROUSEL_CALL_MISSING");
  source = source.replace(carouselCall, "const result = await sendCarousel(claimed.page_id, claimed.sender_id, batches[index], gate.supportSalutation);");

  const metadataAnchor = 'support_live_reply_source: gate.livePageReply?.source_system || null,';
  if (!source.includes(metadataAnchor)) throw new Error("V10_SUPPORT_SALUTATION_METADATA_ANCHOR_MISSING");
  source = source.replace(metadataAnchor, `${metadataAnchor}\n      support_salutation: gate.supportSalutation || null,\n      support_salutation_source: gate.supportSalutationSource || null,\n      support_customer_name: gate.supportCustomerName || null,`);

  source = source.replace(/const VERSION = "v10_outbound_[^"]+";/, 'const VERSION = "v10_outbound_aicake_primary_support_v8_salutation";');
  if (!source.includes(MARK) || !source.includes("supportCarouselSubtitle") || !source.includes("support_salutation_source")) {
    throw new Error("V10_SUPPORT_SALUTATION_INSTALL_FAILED");
  }
  fs.writeFileSync(FILE, source, "utf8");
}

console.log("[AIGUKA V10] support salutation enabled: use known/AI salutation when reliable; otherwise omit pronoun instead of generic anh/chị");
