import fs from "node:fs";

const AI_FILE = "v10-ai-worker-final.js";
const MARK = "AIGUKA_V10_CONVERSATION_CONTINUITY_V1";

if (!fs.existsSync(AI_FILE)) throw new Error("V10_CONVERSATION_CONTINUITY_AI_WORKER_MISSING");
let source = fs.readFileSync(AI_FILE, "utf8");

if (!source.includes(MARK)) {
  const processAnchor = "async function processOne(row, availableProviders, knowledgeSnapshot) {";
  if (!source.includes(processAnchor)) throw new Error("V10_CONVERSATION_CONTINUITY_PROCESS_ANCHOR_MISSING");

  const helpers = String.raw`
function continuityTime(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function continuityContactRequestDetected(value) {
  const text = qualityNormalize(value);
  return /\b(xin|cho|gui|de lai|nhan|qua).{0,40}\b(sdt|so dien thoai|zalo|so lien he)\b|\b(sdt|so dien thoai|zalo|so lien he).{0,30}\b(nhe|a|de|qua|cho em|gui em)\b/.test(text);
}

function continuitySentenceParts(value) {
  return (String(value || "").match(/[^.!?\n]+[.!?]?/g) || [])
    .map(function (part) { return part.trim(); })
    .filter(Boolean);
}

function continuityRemoveContactRequests(value) {
  return continuitySentenceParts(value)
    .filter(function (part) { return !continuityContactRequestDetected(part); })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function continuityCurrentCustomerCluster(modelInput) {
  const messages = modelInput && modelInput.conversation && Array.isArray(modelInput.conversation.messages)
    ? modelInput.conversation.messages
    : [];
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index] && messages[index].role !== "customer") {
      boundary = index;
      break;
    }
  }
  return messages.slice(boundary + 1)
    .filter(function (message) { return message && message.role === "customer"; })
    .map(function (message) { return String(message.text || ""); })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function continuityContactCooldown(modelInput) {
  const messages = modelInput && modelInput.conversation && Array.isArray(modelInput.conversation.messages)
    ? [...modelInput.conversation.messages]
    : [];
  messages.sort(function (a, b) { return continuityTime(a?.occurred_at) - continuityTime(b?.occurred_at); });
  let lastRequestIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role === "customer") continue;
    if (continuityContactRequestDetected(message.text || "")) lastRequestIndex = index;
  }
  if (lastRequestIndex < 0) return { active: false, customerMessagesSince: 999, lastRequestAt: null };
  const after = messages.slice(lastRequestIndex + 1);
  const customerMessagesSince = after.filter(function (message) { return message && message.role === "customer"; }).length;
  const requestAt = messages[lastRequestIndex]?.occurred_at || null;
  return { active: customerMessagesSince < 2, customerMessagesSince, lastRequestAt: requestAt };
}

function continuityPriorPageReply(modelInput) {
  const messages = modelInput && modelInput.conversation && Array.isArray(modelInput.conversation.messages)
    ? modelInput.conversation.messages
    : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role !== "customer" && String(message.text || "").trim()) return message;
  }
  return null;
}

function continuityPruneIrrelevantSalesTangents(value, modelInput) {
  const currentRaw = continuityCurrentCustomerCluster(modelInput);
  const current = qualityNormalize(currentRaw);
  if (!current) return String(value || "").trim();

  const explicitlyAskedPromo = /\b(khuyen mai|uu dai|giam gia|qua tang|ho tro chi phi|chi phi di lai|dat coc)\b/.test(current);
  const productQuestion = /\b(gia|bao gia|mau|san pham|phong bep|nha bep|phong tam|nha tam|bon cau|sen|lavabo|bep tu|hut mui|chau|voi rua|quat|den|gach|ngoi|mua|dat hang)\b/.test(current);
  const locationContext = /\b(dia chi|showroom|o gan|gan|khu vuc|nga tu|ha noi|hn|van chuyen|giao hang|o dau)\b/.test(current);
  const locationStatement = locationContext && !/\b(dia chi|showroom|o dau|cho xin dia chi)\b/.test(current);
  if (!locationContext || productQuestion || explicitlyAskedPromo) return String(value || "").trim();

  const previous = continuityPriorPageReply(modelInput);
  const previousText = qualityNormalize(previous?.text || "");
  const previousAlreadyGaveAddress = /\b(pho keo|gia lam|showroom|hotline)\b/.test(previousText);

  return continuitySentenceParts(value)
    .filter(function (part) {
      const text = qualityNormalize(part);
      if (/\b(dat coc|chi phi di lai|ho tro di lai|khuyen mai|uu dai|giam gia|qua tang)\b/.test(text)) return false;
      if (locationStatement && previousAlreadyGaveAddress && /\b(showroom|pho keo|gia lam|hotline|dia chi)\b/.test(text)) return false;
      return true;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function continuityFallbackReply(modelInput) {
  const style = salutationStyle(modelInput);
  const current = qualityNormalize(continuityCurrentCustomerCluster(modelInput));
  let text = "Dạ, em đã ghi nhận thông tin mình vừa gửi và tiếp tục hỗ trợ đúng nội dung này ạ.";
  if (/\bnga tu so\b/.test(current)) {
    text = "Dạ, em ghi nhận chị ở gần Ngã Tư Sở, Hà Nội ạ. Em sẽ tư vấn theo đúng khu vực này cho chị.";
  } else if (/\b(o gan|khu vuc|ha noi|hn|nga tu)\b/.test(current)) {
    text = "Dạ, em ghi nhận khu vực của anh/chị rồi ạ. Em sẽ tư vấn và kiểm tra vận chuyển theo đúng khu vực này.";
  } else if (/\b(dia chi|showroom|o dau)\b/.test(current) && typeof verifiedAddressSentence === "function") {
    text = verifiedAddressSentence(modelInput) || text;
  }
  return applySalutation(text, style);
}

function enforceConversationContinuity(decision, modelInput) {
  const known = contactIsKnown(modelInput);
  const cooldown = continuityContactCooldown(modelInput);
  let reply = continuityPruneIrrelevantSalesTangents(decision.final_reply || "", modelInput);

  if (known) {
    decision.contact_state = "known";
    decision.should_request_contact = false;
    reply = continuityRemoveContactRequests(reply);
  } else if (cooldown.active) {
    decision.contact_state = "missing_recently_requested";
    decision.should_request_contact = false;
    decision.contact_benefit = "đã vừa xin SĐT/Zalo; chờ ít nhất 2 tin nhắn mới của khách trước khi nhắc lại";
    decision.contact_cooldown_guard = true;
    decision.customer_messages_since_contact_request = cooldown.customerMessagesSince;
    decision.last_contact_request_at = cooldown.lastRequestAt;
    reply = continuityRemoveContactRequests(reply);
  }

  if (!reply) reply = continuityFallbackReply(modelInput);
  reply = applySalutation(reply, salutationStyle(modelInput));

  const parts = continuitySentenceParts(reply);
  if (parts.length > 3) reply = parts.slice(0, 3).join(" ");
  decision.final_reply = String(reply || "").replace(/\s+/g, " ").trim().slice(0, 650);
  decision.conversation_continuity_guard = true;
  return decision;
}

function continuityMessageKey(message) {
  const id = String(message?.id || "").trim();
  if (id) return "id:" + id;
  const text = qualityNormalize(message?.text || "").slice(0, 180);
  const time = continuityTime(message?.occurred_at);
  return "text:" + text + ":" + Math.floor(time / 5000);
}

async function enrichConversationWithDeliveredReplies(claimed, baseConversation) {
  const conversation = baseConversation && typeof baseConversation === "object" ? structuredClone(baseConversation) : {};
  const original = Array.isArray(conversation.messages) ? conversation.messages : [];
  const pageId = String(claimed?.page_id || claimed?.input_snapshot?.page_id || "").trim();
  const senderId = String(claimed?.sender_id || claimed?.input_snapshot?.sender_id || "").trim();
  if (!pageId || !senderId) return conversation;

  const rows = await core(
    `v9_decisions?select=id,status,output,created_at,updated_at&page_id=eq.${encodeURIComponent(pageId)}&sender_id=eq.${encodeURIComponent(senderId)}&id=neq.${encodeURIComponent(claimed.id)}&order=created_at.desc&limit=30`,
  ).catch(function () { return []; });

  const existingKeys = new Set(original.map(continuityMessageKey));
  const additions = [];
  const originalTimes = original.map(function (message) { return continuityTime(message?.occurred_at); }).filter(Boolean);
  const earliestOriginal = originalTimes.length ? Math.min(...originalTimes) : 0;
  const lowerBound = earliestOriginal ? earliestOriginal - 6 * 60 * 60_000 : 0;

  for (const row of rows || []) {
    const output = row && row.output && typeof row.output === "object" ? row.output : {};
    const text = String(output.final_reply || "").trim();
    const deliveredAt = output.delivered_at || output.sent_at || null;
    const deliveredTime = continuityTime(deliveredAt);
    if (!text || !deliveredTime || (lowerBound && deliveredTime < lowerBound)) continue;
    const message = {
      id: `decision:${row.id}`,
      role: "bot",
      event_type: "bot_message",
      text,
      attachments: [],
      referral: null,
      occurred_at: deliveredAt,
      source: "v9_delivered_decision",
    };
    const key = continuityMessageKey(message);
    if (existingKeys.has(key)) continue;
    const duplicateByTextAndTime = original.concat(additions).some(function (item) {
      return item && item.role !== "customer"
        && qualityNormalize(item.text || "") === qualityNormalize(text)
        && Math.abs(continuityTime(item.occurred_at) - deliveredTime) <= 5000;
    });
    if (duplicateByTextAndTime) continue;
    additions.push(message);
    existingKeys.add(key);
  }

  const merged = original.concat(additions)
    .map(function (message, order) { return { ...message, __order: order }; })
    .sort(function (a, b) { return continuityTime(a.occurred_at) - continuityTime(b.occurred_at) || a.__order - b.__order; })
    .map(function ({ __order, ...message }) { return message; })
    .slice(-60);

  conversation.messages = merged;
  conversation.continuity = {
    source: "v9_delivered_decisions",
    delivered_bot_replies_added: additions.length,
    contact_cooldown_enforced: true,
    min_customer_messages_before_contact_retry: 2,
  };
  return conversation;
}

// ${MARK}

`;

  source = source.replace(processAnchor, helpers + processAnchor);

  const conversationAnchor = `  const conversation = claimed.input_snapshot?.conversation || {};
  const knowledgeAdvisors = buildKnowledgeAdvisors(knowledgeSnapshot, conversation, { maxDocuments: 8, maxCatalog: 12, maxAssetsPerCatalog: 6 });`;
  if (!source.includes(conversationAnchor)) throw new Error("V10_CONVERSATION_CONTINUITY_CONTEXT_ANCHOR_MISSING");
  source = source.replace(conversationAnchor, `  const baseConversation = claimed.input_snapshot?.conversation || {};
  const conversation = await enrichConversationWithDeliveredReplies(claimed, baseConversation);
  const knowledgeAdvisors = buildKnowledgeAdvisors(knowledgeSnapshot, conversation, { maxDocuments: 8, maxCatalog: 12, maxAssetsPerCatalog: 6 });`);

  const finalAnchor = `  ensureCurrentTurnCoverage(decision, modelInput);
  enforceGeneralProductSalesHandoff(decision, modelInput);
  if (DECISION_LEAK_PATTERN.test(String(decision.final_reply || ""))) throw new Error("V10_DECISION_FINAL_REPLY_LEAK_REJECTED");`;
  if (!source.includes(finalAnchor)) throw new Error("V10_CONVERSATION_CONTINUITY_FINAL_ANCHOR_MISSING");
  source = source.replace(finalAnchor, `  ensureCurrentTurnCoverage(decision, modelInput);
  enforceGeneralProductSalesHandoff(decision, modelInput);
  enforceConversationContinuity(decision, modelInput);
  if (DECISION_LEAK_PATTERN.test(String(decision.final_reply || ""))) throw new Error("V10_DECISION_FINAL_REPLY_LEAK_REJECTED");`);

  if (!source.includes(MARK) || !source.includes("enrichConversationWithDeliveredReplies") || !source.includes("missing_recently_requested")) {
    throw new Error("V10_CONVERSATION_CONTINUITY_VALIDATION_FAILED");
  }
  fs.writeFileSync(AI_FILE, source, "utf8");
}

console.log("[AIGUKA V10] conversation continuity enabled: delivered bot replies are rehydrated, repeated contact asks are blocked for two customer messages, salutation and current-turn focus are preserved");
