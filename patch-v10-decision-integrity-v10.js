import fs from "node:fs";

const file = "v10-ai-worker-v2.js";
const MARK = "AIGUKA_V10_DECISION_INTEGRITY_V10";
if (!fs.existsSync(file)) throw new Error("V10_DECISION_INTEGRITY_V10_WORKER_MISSING");
let source = fs.readFileSync(file, "utf8");

if (!source.includes(MARK)) {
  if (!source.includes("AIGUKA_V10_DECISION_INTEGRITY_V9")) {
    throw new Error("V10_DECISION_INTEGRITY_V10_BASE_MISSING");
  }

  const corruptedTarget = '  if (/\\b(cosi|ldo|showoom|ben em|pho keo|gia lam noii|zddw)\\b/i.test(normalized)) return true;';
  const corruptedReplacement = '  if (/\\b(cosi|ldo|showoom|gia lam noii|zddw)\\b/i.test(normalized)) return true;';
  if (!source.includes(corruptedTarget)) throw new Error("V10_DECISION_INTEGRITY_V10_CORRUPTION_TARGET_MISSING");
  source = source.replace(corruptedTarget, corruptedReplacement);

  const staleReplyTarget = "    decision.final_reply = applySalutation(reply, style);";
  const staleReplyReplacement = "    decision.final_reply = applySalutation(decision.final_reply || reply, style);";
  if (!source.includes(staleReplyTarget)) throw new Error("V10_DECISION_INTEGRITY_V10_STALE_REPLY_TARGET_MISSING");
  source = source.replace(staleReplyTarget, staleReplyReplacement);

  const enforceTarget = "function enforceDecisionIntegrity(input, modelInput) {";
  if (!source.includes(enforceTarget)) throw new Error("V10_DECISION_INTEGRITY_V10_ENFORCE_TARGET_MISSING");

  const helpers = String.raw`function currentCustomerClusterText(modelInput) {
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
  return qualityNormalize(messages.slice(boundary + 1).filter(function (message) {
    return message && message.role === "customer";
  }).map(function (message) {
    return message.text || "";
  }).join(" "));
}

function currentTurnSlideKeys(modelInput, slideKeys) {
  const text = currentCustomerClusterText(modelInput);
  const output = [];
  function key(value) { return slideKeys.has(value) ? value : null; }
  function add() {
    for (const value of arguments) {
      if (value && !output.includes(value)) output.push(value);
    }
  }

  const broadHome = /\b(noi that nha moi|hoan thien nha|trang bi nha moi|xem het|tat ca mau|toan bo san pham)\b/.test(text);
  const asksKitchenAndBath = /\b(nha tam|phong tam|thiet bi ve sinh)\b/.test(text)
    && /\b(nha bep|phong bep|bep tu|hut mui|chau rua bat|voi rua bat)\b/.test(text);
  const sink = /\b(chau|voi rua|bon rua|rua bat|rua chen)\b/.test(text);
  const stove = /\b(bep tu|hut mui|may hut|hut khoi)\b/.test(text);
  const broadKitchen = /\b(phong bep|nha bep|noi that.{0,12}bep|thiet bi.{0,12}bep|toan bo.{0,20}bep|bep an)\b/.test(text);
  const toilet = /\b(bon cau|bet lien khoi|bet thong minh|bet trung|qua trung)\b/.test(text);
  const bathroom = /\b(phong tam|nha tam|nha ve sinh|thiet bi ve sinh|combo.{0,10}(tam|ve sinh))\b/.test(text);
  const mirror = /\b(guong tu|tu guong|tu lavabo|tu chau|guong lavabo)\b/.test(text);
  const fan = /\b(quat tran|quat 10(?: canh)?|quat 8(?: canh)?|quat 5(?: canh)?|quat 6(?: canh)?)\b/.test(text);

  if (broadHome || asksKitchenAndBath) {
    add(
      key("combo_phong_tam_ban_chay"), key("combo_phong_tam_dep_moi"), key("combo_phong_tam"),
      key("bep_tu_hut_mui"), key("chau_voi_rua_bat")
    );
    return output;
  }

  if (sink) add(key("chau_voi_rua_bat"));
  else if (stove) add(key("bep_tu_hut_mui"), key("bep_tu"), key("may_hut_mui"));
  else if (broadKitchen) add(key("bep_tu_hut_mui"), key("chau_voi_rua_bat"));

  if (mirror) add(key("guong_tu"), key("tu_chau_guong"));
  else if (toilet) add(key("bon_cau"), key("bon_cau_lien_khoi"), key("bon_cau_thong_minh"));
  else if (bathroom) add(key("combo_phong_tam_ban_chay"), key("combo_phong_tam_dep_moi"), key("combo_phong_tam"));

  if (fan) add(
    key("quat_10_canh_gold"), key("quat_10_canh_wood"), key("quat_10_canh_black"),
    key("quat_10_canh_brown"), key("quat_8_canh_gold"), key("quat_8_canh_wood"), key("quat_tran")
  );
  return output;
}

function continuationSlideRequest(modelInput) {
  const latest = latestExplicitText(modelInput);
  return /\b(xem them|mau khac|gui them|gui lai|loai nay|mau nay|mau vang|mau den|mau nau|xin gia|gia sao|bao nhieu|khong mo|khong xem duoc)\b/.test(latest);
}

function previousCustomerProductText(modelInput) {
  const messages = customerMessagesFrom(modelInput);
  if (messages.length < 2) return "";
  return qualityNormalize(messages.slice(Math.max(0, messages.length - 4), -1).map(function (message) {
    return message.text || "";
  }).join(" "));
}

function continuationSlideKeys(modelInput, slideKeys) {
  if (!continuationSlideRequest(modelInput)) return [];
  const previous = previousCustomerProductText(modelInput);
  const synthetic = {
    ...modelInput,
    conversation: {
      ...(modelInput && modelInput.conversation || {}),
      messages: [{ role: "customer", text: previous }],
    },
  };
  return currentTurnSlideKeys(synthetic, slideKeys);
}

function addressIntentInCurrentTurn(modelInput) {
  return /\b(dia chi|o dau|showroom|cua hang|kho o dau|cong ty o dau|dai ly o dau)\b/.test(currentCustomerClusterText(modelInput));
}

function mediaProblemInCurrentTurn(modelInput) {
  return /\b(khong mo|khong xem|khong vao|khong phong to|khong vach|loi anh|anh khong hien)\b/.test(currentCustomerClusterText(modelInput));
}

function currentTurnContainsPhone(modelInput) {
  const raw = customerMessagesFrom(modelInput).slice(-6).map(function (message) { return message.text || ""; }).join(" ");
  return /(?:^|\D)(?:\+?84|0)(?:[\s.()-]*\d){8,10}(?:\D|$)/.test(raw);
}

function verifiedAddressSentence(modelInput) {
  const knowledge = qualityNormalize(JSON.stringify(modelInput && modelInput.knowledge_advisors || {}));
  const current = currentCustomerClusterText(modelInput);
  const addresses = [];
  if (knowledge.includes("254 pho keo kim son gia lam ha noi")) addresses.push("254 Phố Keo, Kim Sơn, Gia Lâm, Hà Nội");
  if (knowledge.includes("pho dan tri qua thuan thanh bac ninh")) addresses.push("Phố Dàn, Trí Quả, Thuận Thành, Bắc Ninh");
  if (knowledge.includes("khu do thi dinh to luxury homes thuan thanh bac ninh")) addresses.push("Khu đô thị Đình Tổ Luxury Homes, Thuận Thành, Bắc Ninh");
  if (knowledge.includes("khu do thi khai son long bien ha noi")) addresses.push("Khu đô thị Khai Sơn, Long Biên, Hà Nội");
  if (!addresses.length) return "";

  let selected = addresses;
  if (/\b(bac ninh|thuan thanh|tri qua|pho dan|dinh to)\b/.test(current)) {
    selected = addresses.filter(function (address) { return /Bắc Ninh|Thuận Thành/i.test(address); });
  } else if (/\b(long bien|khai son)\b/.test(current)) {
    selected = addresses.filter(function (address) { return /Long Biên|Khai Sơn/i.test(address); });
  } else if (/\b(gia lam|kim son|pho keo|hung yen|thuong tin|ha noi)\b/.test(current)) {
    selected = addresses.filter(function (address) { return /Gia Lâm|Long Biên/i.test(address); });
  }
  if (!selected.length) selected = addresses;
  return "Showroom ÁNH DƯƠNG có " + selected.map(function (address) { return "cơ sở tại " + address; }).join("; ") + ".";
}

function replyAnswersAddress(value) {
  const text = qualityNormalize(value);
  return /\b(pho keo|pho dan|dinh to|khai son|gia lam|long bien|thuan thanh|bac ninh)\b/.test(text);
}

function replyAcknowledgesContact(value) {
  return /\b(da nhan|ghi nhan|luu so|nhan duoc so|chuyen sale|lien he)\b/.test(qualityNormalize(value));
}

function replyHandlesMediaProblem(value) {
  return /\b(gui lai|anh truc tiep|tren messenger|gui tung anh|mo anh|xem anh)\b/.test(qualityNormalize(value));
}

function enforceCurrentTurnMediaScope(decision, modelInput, slideKeys) {
  const requested = decision.needs_slides || decision.action === "reply_with_slides";
  if (!requested) return decision;

  const current = currentTurnSlideKeys(modelInput, slideKeys);
  const carried = current.length ? [] : continuationSlideKeys(modelInput, slideKeys);
  const resolved = current.length ? current : carried;

  if (resolved.length) {
    decision.selected_catalog_keys = resolved.slice(0, 6);
    decision.needs_slides = true;
    decision.action = "reply_with_slides";
    return decision;
  }

  decision.selected_catalog_keys = [];
  decision.selected_products = [];
  decision.needs_slides = false;
  decision.action = "ask_clarification";
  decision.confidence = Math.min(Number(decision.confidence || 0.6), 0.7);
  decision.final_reply = "Dạ, anh/chị đang muốn xem mẫu sản phẩm nào để em gửi đúng nhóm ạ?";
  decision.decision_reason = String(decision.decision_reason || "") + " | media_scope_blocked_without_current_customer_product_evidence";
  return decision;
}

function ensureCurrentTurnCoverage(decision, modelInput) {
  let text = String(decision.final_reply || "").trim();
  const prefixes = [];
  const known = contactIsKnown(modelInput);

  if (addressIntentInCurrentTurn(modelInput) && !replyAnswersAddress(text)) {
    const address = verifiedAddressSentence(modelInput);
    if (address) prefixes.push(address);
  }
  if (mediaProblemInCurrentTurn(modelInput) && !replyHandlesMediaProblem(text)) {
    prefixes.push("Em gửi lại ảnh trực tiếp trên Messenger để anh/chị mở và xem rõ hơn ạ.");
  }
  if (known && currentTurnContainsPhone(modelInput) && !replyAcknowledgesContact(text)) {
    prefixes.push("Dạ, em đã nhận số điện thoại của anh/chị rồi ạ.");
  }

  if (addressIntentInCurrentTurn(modelInput) && !currentTurnSlideKeys(modelInput, exactCatalogContext(modelInput).slide).length) {
    decision.needs_slides = false;
    if (decision.action === "reply_with_slides") decision.action = "reply_text";
    decision.selected_catalog_keys = [];
    decision.selected_products = [];
  }

  if (prefixes.length) text = prefixes.join(" ") + (text ? " " + text : "");
  decision.final_reply = applySalutation(text.slice(0, 640), salutationStyle(modelInput));
  return decision;
}

// ${MARK}

`;
  source = source.replace(enforceTarget, helpers + enforceTarget);

  const productMapTarget = `  decision.selected_products = decision.selected_catalog_keys.map(function (selectedKey) {\n    const item = allowed.get(selectedKey);\n    return String(item && item.display_name || selectedKey);\n  });`;
  const productMapReplacement = `  enforceCurrentTurnMediaScope(decision, modelInput, slide);\n  decision.selected_products = decision.selected_catalog_keys.map(function (selectedKey) {\n    const item = allowed.get(selectedKey);\n    return String(item && item.display_name || selectedKey);\n  });`;
  if (!source.includes(productMapTarget)) throw new Error("V10_DECISION_INTEGRITY_V10_SCOPE_TARGET_MISSING");
  source = source.replace(productMapTarget, productMapReplacement);

  const finalTarget = `  if (knownAtFinal) {\n    decision.contact_state = "known";\n    decision.should_request_contact = false;\n  }\n  if (DECISION_LEAK_PATTERN.test(String(decision.final_reply || ""))) throw new Error("V10_DECISION_FINAL_REPLY_LEAK_REJECTED");`;
  const finalReplacement = `  if (knownAtFinal) {\n    decision.contact_state = "known";\n    decision.should_request_contact = false;\n  }\n  ensureCurrentTurnCoverage(decision, modelInput);\n  if (DECISION_LEAK_PATTERN.test(String(decision.final_reply || ""))) throw new Error("V10_DECISION_FINAL_REPLY_LEAK_REJECTED");`;
  if (!source.includes(finalTarget)) throw new Error("V10_DECISION_INTEGRITY_V10_FINAL_TARGET_MISSING");
  source = source.replace(finalTarget, finalReplacement);

  source = source.replace("v10_ai_quality_guard_v12", "v10_ai_quality_guard_v13");
  source += `\n// ${MARK}\n`;
  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA V10] decision integrity v10 enabled: current-turn scope, verified addresses and multi-intent coverage");
}
