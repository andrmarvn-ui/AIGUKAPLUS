import fs from "node:fs";

// The specific-price patch defines specificPriceSubject() and applies the first price guard.
// Load it here so this adaptive patch is deterministic before detached workers start.
await import("./patch-v10-specific-price-contact.js");

const AI_FILE = "v10-ai-worker-final.js";
const OUTBOUND_FILE = "v10-outbound-worker.js";
const AI_MARK = "AIGUKA_V10_GENERAL_PRODUCT_SALES_HANDOFF_V2_SMART_REPAIR";
const OUTBOUND_MARK = "AIGUKA_V10_CUSTOMER_TURN_SUPERSESSION_V1";

if (!fs.existsSync(AI_FILE)) throw new Error("V10_GENERAL_SALES_AI_WORKER_MISSING");
if (!fs.existsSync(OUTBOUND_FILE)) throw new Error("V10_GENERAL_SALES_OUTBOUND_WORKER_MISSING");

let ai = fs.readFileSync(AI_FILE, "utf8");

if (!ai.includes(AI_MARK)) {
  const helperAnchor = "function unsupportedStockClaim(value, modelInput) {";
  if (!ai.includes(helperAnchor)) throw new Error("V10_GENERAL_SALES_HELPER_ANCHOR_MISSING");

  const helpers = String.raw`function currentCustomerRawCluster(modelInput) {
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

function hardContactRefusalInTurn(modelInput) {
  const text = qualityNormalize(currentCustomerRawCluster(modelInput));
  return /\b(dung xin|dung hoi|khong cho so|khong dua so|khong can goi|khong lien he|khong sdt|khong so dien thoai|khong zalo)\b/.test(text);
}

function commercialProductNeedDetected(decision, modelInput) {
  const raw = currentCustomerRawCluster(modelInput);
  const text = qualityNormalize(raw);
  const intents = qualityNormalize((Array.isArray(decision && decision.intents) ? decision.intents : []).join(" "));
  const advisors = modelInput && modelInput.knowledge_advisors ? modelInput.knowledge_advisors : {};
  const advisorProducts = Array.isArray(advisors.product_candidates) ? advisors.product_candidates : [];
  const selected = Array.isArray(decision && decision.selected_catalog_keys) ? decision.selected_catalog_keys : [];
  const hasProductEvidence = advisorProducts.length > 0 || selected.length > 0 || /\b(bon cau|bet|sen tam|sen cay|lavabo|guong|tu chau|tu lavabo|bon tam|bep tu|hut mui|chau rua|voi rua|phu kien|quat|den|gach|ngoi|combo|phong tam|nha tam|phong bep|nha bep|san pham|mau)\b/.test(text);
  const commercialSignal = /\b(price|gia|bao gia|bao nhieu|samples|sample|xem mau|gui mau|gui anh|catalog|specs|thong so|kich thuoc|cong suat|stock|con hang|co hang|availability|delivery|giao hang|van chuyen|lap dat|bao hanh|xuat xu|thuong hieu|brand|purchase|mua|dat hang|lay hang|chot|uu dai|khuyen mai|giam gia)\b/.test(intents + " " + text);
  return (hasProductEvidence && commercialSignal) || /\b(muon mua|can mua|dat hang|chot don|mua hang)\b/.test(text);
}

function strongCommercialSignal(decision, modelInput) {
  const raw = currentCustomerRawCluster(modelInput);
  const text = qualityNormalize(raw);
  const intents = qualityNormalize((Array.isArray(decision && decision.intents) ? decision.intents : []).join(" "));
  return priceIntentDetected(decision, modelInput)
    || /\b(muon mua|can mua|dat hang|chot|lay hang|bao gia|uu dai|khuyen mai|con hang|giao hang|van chuyen|lap dat|bao hanh|xem mau|gui mau|gui anh|catalog)\b/.test(intents + " " + text)
    || Boolean(decision && (decision.needs_slides || decision.action === "reply_with_slides"));
}

function specificOrComplexProductRequest(modelInput) {
  const raw = currentCustomerRawCluster(modelInput);
  const text = qualityNormalize(raw);
  const codeLike = /\b[A-Za-z]{1,10}[-_.\/]?\d{2,7}[A-Za-z0-9._\/-]*\b/.test(raw);
  const specification = /\b(kich thuoc|cong suat|dong co|chat lieu|xuat xu|thuong hieu|bao hanh|lap dat|phien ban|model|ma san pham|mau sac|sai canh|dien ap)\b/.test(text);
  return codeLike || specification;
}

function containsCjkOrForeignGlyph(value) {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(String(value || ""));
}

function stripRepeatedBusinessIntroduction(value) {
  let text = String(value || "").trim();
  text = text
    .replace(/^\s*(?:chào|xin chào)[^.!?]{0,80}[.!?]\s*/i, "")
    .replace(/^\s*(?:dạ[, ]*)?(?:em|cháu)\s+là\s+(?:nhân viên|tư vấn viên|trợ lý|cố vấn|顾问)[^.!?]{0,160}[.!?]?\s*/i, "")
    .replace(/^\s*(?:em|cháu)\s+(?:đến|từ)\s+showroom[^.!?]{0,120}[.!?]?\s*/i, "")
    .trim();
  return text;
}

function specialistHandoffDetected(value) {
  const text = qualityNormalize(value);
  return /\b(chuyen|noi|gui|nhờ).{0,28}\b(sale|nhan vien kinh doanh|tu van vien|chuyen vien|chuyen vien san pham)\b|\b(sale|nhan vien kinh doanh|tu van vien|chuyen vien|chuyen vien san pham).{0,36}\b(kiem tra|bao gia|lien he|tu van|gui mau|xac nhan)\b/.test(text);
}

function unresolvedPromiseWithoutHandoff(value) {
  const text = qualityNormalize(value);
  return /\b(de em|em se|cho em).{0,40}\b(kiem tra|xem lai).{0,40}\b(bao lai|phan hoi lai|tra loi lai)\b/.test(text)
    && !specialistHandoffDetected(value)
    && !contactRequestDetected(value);
}

function sentenceParts(value) {
  return (String(value || "").match(/[^.!?\n]+[.!?]?/g) || []).map(function (part) { return part.trim(); }).filter(Boolean);
}

function removeContactRequestSentences(value) {
  return sentenceParts(value).filter(function (part) { return !contactRequestDetected(part); }).join(" ").trim();
}

function appendSentence(value, sentence) {
  const base = String(value || "").trim();
  const extra = String(sentence || "").trim();
  if (!base) return extra;
  if (!extra) return base;
  return base + (/[.!?]$/.test(base) ? " " : ". ") + extra;
}

function trimReplyWithoutDestroyingAnswer(value, maxSentences, maxChars) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars && sentenceParts(text).length <= maxSentences) return text;
  const kept = sentenceParts(text).slice(0, maxSentences).join(" ").trim();
  return (kept || text.slice(0, maxChars)).slice(0, maxChars).trim();
}

function replyHasUsefulAnswer(value) {
  const text = qualityNormalize(stripRepeatedBusinessIntroduction(value));
  if (text.length < 28) return false;
  if (/^(da|vang|ok|em ghi nhan|em hieu|de em kiem tra|cho em xin chut thoi gian)\b/.test(text) && text.length < 90) return false;
  return true;
}

function generalSalesSubject(modelInput) {
  const subject = typeof specificPriceSubject === "function" ? specificPriceSubject(modelInput) : "mẫu sản phẩm anh/chị đang quan tâm";
  return String(subject || "mẫu sản phẩm anh/chị đang quan tâm")
    .replace(/\s+/g, " ")
    .trim();
}

function difficultProductCase(decision, modelInput, reply) {
  return containsCjkOrForeignGlyph(reply)
    || languageLooksCorrupted(reply)
    || unsupportedPriceReply(reply, modelInput)
    || unsupportedStockClaim(reply, modelInput)
    || unsupportedTechnicalFacts(reply, modelInput)
    || unresolvedPromiseWithoutHandoff(reply)
    || (priceIntentDetected(decision, modelInput) && !replyContainsVerifiedPrice(reply, modelInput))
    || specificOrComplexProductRequest(modelInput);
}

function smartSpecialistFallback(decision, modelInput, refused) {
  const known = contactIsKnown(modelInput);
  const style = salutationStyle(modelInput);
  const subject = generalSalesSubject(modelInput);
  let text;
  if (refused) {
    text = "Dạ, phần " + subject + " còn phụ thuộc đúng mã/phiên bản nên em chưa muốn báo sai. Anh/chị gửi thêm ảnh hoặc mã đầy đủ, em hỗ trợ tiếp ngay tại đây ạ.";
  } else if (known) {
    text = "Dạ, phần " + subject + " còn phụ thuộc đúng mẫu/phiên bản nên em chưa muốn báo sai. Em chuyển chuyên viên sản phẩm kiểm tra và gửi mẫu chuẩn, báo giá cùng ưu đãi hiện tại theo thông tin liên hệ mình đã để lại ạ.";
  } else {
    text = "Dạ, phần " + subject + " còn phụ thuộc đúng mẫu/phiên bản nên em chưa muốn báo sai. Anh/chị cho em xin SĐT hoặc Zalo, em chuyển chuyên viên sản phẩm kiểm tra, gửi mẫu chuẩn, báo giá và ưu đãi hiện tại ạ.";
  }
  return applySalutation(text, style);
}

function smartContactSentence(modelInput) {
  const style = salutationStyle(modelInput);
  return applySalutation("Anh/chị cho em xin SĐT hoặc Zalo, em chuyển chuyên viên sản phẩm gửi mẫu chuẩn, báo giá và ưu đãi hiện tại ạ.", style);
}

function smartKnownContactSentence(modelInput) {
  const style = salutationStyle(modelInput);
  return applySalutation("Em chuyển chuyên viên sản phẩm kiểm tra đúng mẫu/phiên bản và phản hồi theo thông tin liên hệ mình đã để lại ạ.", style);
}

function smartSpecialistReasonSentence(modelInput) {
  const style = salutationStyle(modelInput);
  return applySalutation("Em chuyển chuyên viên sản phẩm kiểm tra đúng mẫu/phiên bản để tư vấn và báo giá chuẩn cho mình ạ.", style);
}

function enforceGeneralProductSalesHandoff(decision, modelInput) {
  if (!commercialProductNeedDetected(decision, modelInput)) return decision;

  const known = contactIsKnown(modelInput);
  const refused = hardContactRefusalInTurn(modelInput);
  const highIntent = strongCommercialSignal(decision, modelInput);
  let reply = stripRepeatedBusinessIntroduction(decision.final_reply || "");
  let repairMode = "preserved";

  const unsafe = containsCjkOrForeignGlyph(reply)
    || languageLooksCorrupted(reply)
    || unsupportedPriceReply(reply, modelInput)
    || unsupportedStockClaim(reply, modelInput)
    || unsupportedTechnicalFacts(reply, modelInput);
  const difficult = difficultProductCase(decision, modelInput, reply);
  const shouldAskContact = !known && !refused && (highIntent || difficult);

  if (unsafe) {
    reply = smartSpecialistFallback(decision, modelInput, refused);
    repairMode = "safe_specialist_fallback";
  } else {
    if (unresolvedPromiseWithoutHandoff(reply)) {
      reply = smartSpecialistFallback(decision, modelInput, refused);
      repairMode = "promise_repaired";
    } else if (known) {
      if (contactRequestDetected(reply)) {
        reply = removeContactRequestSentences(reply);
        repairMode = "removed_duplicate_contact_request";
      }
      if ((highIntent || difficult) && !specialistHandoffDetected(reply)) {
        reply = appendSentence(reply, smartKnownContactSentence(modelInput));
        repairMode = "appended_known_contact_handoff";
      }
    } else if (refused) {
      if (contactRequestDetected(reply)) {
        reply = removeContactRequestSentences(reply);
        repairMode = "honored_contact_refusal";
      }
      if (!replyHasUsefulAnswer(reply) && difficult) {
        reply = smartSpecialistFallback(decision, modelInput, true);
        repairMode = "messenger_clarification_fallback";
      }
    } else if (shouldAskContact) {
      if (!replyHasUsefulAnswer(reply)) {
        reply = smartSpecialistFallback(decision, modelInput, false);
        repairMode = "missing_answer_fallback";
      } else {
        if (!contactRequestDetected(reply)) {
          reply = appendSentence(reply, smartContactSentence(modelInput));
          repairMode = "appended_contact_cta";
        }
        if ((difficult || highIntent) && !specialistHandoffDetected(reply)) {
          reply = appendSentence(reply, smartSpecialistReasonSentence(modelInput));
          repairMode = repairMode === "preserved" ? "appended_specialist_reason" : repairMode + "+specialist_reason";
        }
      }
    }
  }

  reply = stripRepeatedBusinessIntroduction(reply).replace(/\s+/g, " ").trim();
  if (containsCjkOrForeignGlyph(reply) || !reply) {
    reply = smartSpecialistFallback(decision, modelInput, refused);
    repairMode = "final_safe_fallback";
  }
  reply = trimReplyWithoutDestroyingAnswer(reply, 4, 760);

  decision.final_reply = applySalutation(reply, salutationStyle(modelInput));
  decision.contact_state = known ? "known" : "missing";
  decision.should_request_contact = shouldAskContact;
  decision.contact_benefit = known
    ? "chuyên viên sản phẩm kiểm tra đúng mẫu/phiên bản và phản hồi theo liên hệ đã có"
    : refused
      ? "tiếp tục hỗ trợ tại Messenger, xin thêm ảnh hoặc mã đầy đủ khi cần"
      : shouldAskContact
        ? "chuyên viên sản phẩm gửi mẫu chuẩn, báo giá và ưu đãi hiện tại"
        : "trả lời trực tiếp phần dữ liệu đã chắc chắn";
  decision.sales_handoff_required = !refused && (highIntent || difficult);
  decision.specialist_handoff_recommended = !refused && commercialProductNeedDetected(decision, modelInput);
  decision.general_product_sales_guard = true;
  decision.smart_reply_repair = repairMode;
  decision.hard_output_blocking = false;
  return decision;
}

// ${AI_MARK}

`;
  ai = ai.replace(helperAnchor, helpers + helperAnchor);

  // Extend the language firewall to reject Chinese/Japanese/Korean glyphs globally.
  const languageTarget = '  if (/[�åäöüæøßłŁćĆśŚźŹżŻńŃ]/i.test(text)) return true;';
  if (!ai.includes(languageTarget)) throw new Error("V10_GENERAL_SALES_LANGUAGE_TARGET_MISSING");
  ai = ai.replace(languageTarget, '  if (/[\\u3400-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af]/u.test(text) || /[�åäöüæøßłŁćĆśŚźŹżŻńŃ]/i.test(text)) return true;');

  // Replace the earlier price-only promise with a transparent specialist escalation.
  const safePricePattern = /function safePriceReply\(decision, modelInput\) \{[\s\S]*?\n\}\n\n\/\/ AIGUKA_V10_DECISION_INTEGRITY_V8/;
  if (!safePricePattern.test(ai)) throw new Error("V10_GENERAL_SALES_PRICE_BLOCK_MISSING");
  ai = ai.replace(safePricePattern, String.raw`function safePriceReply(decision, modelInput) {
  const known = contactIsKnown(modelInput);
  const style = salutationStyle(modelInput);
  const subject = generalSalesSubject(modelInput);
  const text = known
    ? "Dạ, giá của " + subject + " còn phụ thuộc đúng mẫu/phiên bản và ưu đãi tại thời điểm kiểm tra. Em chuyển chuyên viên sản phẩm xác nhận và gửi báo giá chuẩn theo thông tin liên hệ mình đã để lại ạ."
    : "Dạ, giá của " + subject + " còn phụ thuộc đúng mẫu/phiên bản và ưu đãi tại thời điểm kiểm tra. Anh/chị cho em xin SĐT hoặc Zalo, em chuyển chuyên viên sản phẩm xác nhận, gửi mẫu chuẩn và báo giá hiện tại ạ.";
  return applySalutation(text, style);
}

// AIGUKA_V10_DECISION_INTEGRITY_V8`);

  const finalAnchor = "  ensureCurrentTurnCoverage(decision, modelInput);\n  if (DECISION_LEAK_PATTERN.test(String(decision.final_reply || \"\"))) throw new Error(\"V10_DECISION_FINAL_REPLY_LEAK_REJECTED\");";
  if (!ai.includes(finalAnchor)) throw new Error("V10_GENERAL_SALES_FINAL_ANCHOR_MISSING");
  ai = ai.replace(finalAnchor, "  ensureCurrentTurnCoverage(decision, modelInput);\n  enforceGeneralProductSalesHandoff(decision, modelInput);\n  if (DECISION_LEAK_PATTERN.test(String(decision.final_reply || \"\"))) throw new Error(\"V10_DECISION_FINAL_REPLY_LEAK_REJECTED\");");

  ai = ai.replace("v10_ai_quality_guard_v15", "v10_ai_quality_guard_v17_smart_sales_advisory");
  if (!ai.includes(AI_MARK) || !ai.includes("smart_reply_repair") || !ai.includes("hard_output_blocking = false")) {
    throw new Error("V10_GENERAL_SALES_AI_VALIDATION_FAILED");
  }
  fs.writeFileSync(AI_FILE, ai, "utf8");
}

let outbound = fs.readFileSync(OUTBOUND_FILE, "utf8");
if (!outbound.includes(OUTBOUND_MARK)) {
  const target = `  const customerAt = latestCustomerAt(decision);\n  const pageAt = Date.parse(state.last_page_event_at || \"\");`;
  if (!outbound.includes(target)) throw new Error("V10_CUSTOMER_TURN_SUPERSESSION_TARGET_MISSING");
  const replacement = `  const customerAt = latestCustomerAt(decision);\n  const liveCustomerAt = Date.parse(state.last_customer_event_at || \"\");\n  if (customerAt > 0 && Number.isFinite(liveCustomerAt) && liveCustomerAt > customerAt + 250) {\n    return { allowed: false, reason: \"CUSTOMER_TURN_SUPERSEDED\" };\n  }\n  const pageAt = Date.parse(state.last_page_event_at || \"\");\n\n  // ${OUTBOUND_MARK}`;
  outbound = outbound.replace(target, replacement);
  outbound = outbound.replace("v10_outbound_safety_only_v1", "v10_outbound_turn_supersession_v2");
  if (!outbound.includes(OUTBOUND_MARK) || !outbound.includes("CUSTOMER_TURN_SUPERSEDED")) throw new Error("V10_CUSTOMER_TURN_SUPERSESSION_VALIDATION_FAILED");
  fs.writeFileSync(OUTBOUND_FILE, outbound, "utf8");
}

console.log("[AIGUKA V10] adaptive product assistance enabled: preserve useful answers, repair unsafe text, escalate difficult cases to product specialists, never hard-block a recoverable reply");
