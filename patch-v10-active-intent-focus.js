import fs from "node:fs";

const MARK = "AIGUKA_V10_ACTIVE_INTENT_FOCUS_V1";

function patchMediaObligation() {
  const file = "v10/core/media-obligation.js";
  let source = fs.readFileSync(file, "utf8");
  if (source.includes(MARK)) return;

  const start = source.indexOf("function customerMediaWindow(messages = []) {");
  const end = source.indexOf("\nfunction positiveMediaWindow", start);
  if (start < 0 || end < 0) throw new Error("ACTIVE_INTENT_MEDIA_WINDOW_ANCHOR_MISSING");

  const replacement = `function productFocusTags(message) {
  const text = normalizeVietnamese(message?.text || "");
  const tags = [];
  const add = (value) => { if (value && !tags.includes(value)) tags.push(value); };

  const toilet = /\\b(bon cau|bet|bet lien khoi|bet thong minh|bet trung|qua trung|toilet)\\b/.test(text);
  const shower = /\\b(sen tam|sen cay|voi sen|sen voi)\\b/.test(text);
  const bathSink = /\\b(lavabo|chau rua mat|bon rua mat|chau lavabo|tu lavabo|tu chau|guong lavabo)\\b/.test(text);
  const kitchenSink = /\\b(chau rua bat|chau rua chen|chau rua bep|voi rua bat|voi rua chen|voi rua bep|chau voi)\\b/.test(text);
  const kitchenAppliance = /\\b(bep tu|bep dien|hut mui|may hut|hut khoi)\\b/.test(text);
  const kitchenFurniture = /\\b(tu bep|bo bep|he tu bep|bep dai|tu bep dai|noi that bep theo met)\\b/.test(text)
    || /\\b(?:bo|tu)\\s*bep.{0,24}\\b(?:m|met)\\b/.test(text);
  const fan = /\\b(?:quat|quant)(?:\\s+tran)?(?:.{0,22}(?:5|6|8|10)\\s*canh)?\\b/.test(text);
  const tile = /\\b(gach|op lat|lat nen|da op lat)\\b/.test(text);

  if (toilet) add("toilet");
  if (shower) add("shower");
  if (bathSink) add("bath_sink");
  if (kitchenSink) add("kitchen_sink");
  if (kitchenAppliance) add("kitchen_appliance");
  if (kitchenFurniture) add("kitchen_furniture");
  if (fan) add("fan");
  if (tile) add("tile");

  const hasBathroomSpecific = toilet || shower || bathSink;
  const hasKitchenSpecific = kitchenSink || kitchenAppliance || kitchenFurniture;
  if (!hasBathroomSpecific && /\\b(phong tam|nha tam|nha ve sinh|nha vs|wc|thiet bi ve sinh|combo.{0,12}(tam|ve sinh))\\b/.test(text)) add("bathroom");
  if (!hasKitchenSpecific && /\\b(phong bep|nha bep|noi that.{0,12}bep|thiet bi.{0,12}bep|combo.{0,12}bep|com bo.{0,12}bep|bep an)\\b/.test(text)) add("kitchen");
  if (/\\b(noi that nha moi|hoan thien nha|trang bi nha moi|xem het|tat ca mau|toan bo san pham)\\b/.test(text)) add("whole_home");
  return tags;
}

function focusNarrowedCustomerWindow(active = []) {
  if (!Array.isArray(active) || active.length < 2) return active;

  let focusIndex = -1;
  let focusTags = [];
  for (let index = active.length - 1; index >= 0; index -= 1) {
    const tags = productFocusTags(active[index]);
    if (!tags.length) continue;
    focusIndex = index;
    focusTags = tags;
    break;
  }
  if (focusIndex <= 0 || focusTags.length !== 1 || focusTags[0] === "whole_home") return active;

  const target = focusTags[0];
  const newerTags = active.slice(focusIndex + 1).flatMap(productFocusTags);
  if (newerTags.some((tag) => tag !== target)) return active;

  const earlierTags = active.slice(0, focusIndex).flatMap(productFocusTags);
  if (!earlierTags.length) return active;
  const hasDifferentEarlierNeed = earlierTags.some((tag) => tag !== target);
  if (!hasDifferentEarlierNeed) return active;

  // A later, single explicit product focus narrows an older broad/multi-product request.
  // Generic continuations such as price, availability, location or phone stay attached
  // to that latest concrete product instead of reviving stale product groups.
  return active.slice(focusIndex);
}

function customerMediaWindow(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  let lastDeliveredMedia = -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (hasDeliveredMedia(list[index])) {
      lastDeliveredMedia = index;
      break;
    }
  }
  let active = list.slice(lastDeliveredMedia + 1).filter(activeCustomerMessage);
  let lastReplace = -1;
  for (let index = active.length - 1; index >= 0; index -= 1) {
    if (relationOf(active[index]) === "REPLACE") {
      lastReplace = index;
      break;
    }
  }
  if (lastReplace >= 0) active = active.slice(lastReplace);
  return focusNarrowedCustomerWindow(active);
}

// ${MARK}`;

  source = source.slice(0, start) + replacement + source.slice(end);
  fs.writeFileSync(file, source, "utf8");
}

function patchDecisionContract() {
  const file = "v10/core/decision-contract.js";
  let source = fs.readFileSync(file, "utf8");
  if (source.includes(MARK)) return;

  const oldLine = '    "Đọc toàn bộ conversation theo thời gian và đặc biệt đọc unresolved_needs. Tin mới nhất không được xóa nhu cầu cũ chưa hoàn thành.",';
  if (!source.includes(oldLine)) throw new Error("ACTIVE_INTENT_DECISION_INSTRUCTION_ANCHOR_MISSING");
  const replacement = `${oldLine}\n    "Tin mới không tự động xóa ý cũ, nhưng khi khách thu hẹp hoặc chuyển rõ sang một sản phẩm cụ thể thì coi các nhóm cũ không tương thích là đã bị thay thế cho lượt media hiện tại. Ví dụ đang nói nhà tắm/nhà bếp rồi chuyển liên tục sang bệt/bồn cầu thì chỉ xử lý bệt/bồn cầu, không kéo bếp theo.",\n    "Tên sản phẩm, số cánh, màu, loại và biến thể khách nói rõ luôn ưu tiên hơn referral/quảng cáo và fallback catalog. Nếu không có đúng catalog thì không được tự thay bằng sản phẩm gần giống; trả lời không kèm slide hoặc hỏi ngắn để làm rõ.",`;
  source = source.replace(oldLine, replacement);
  source += `\n// ${MARK}\n`;
  fs.writeFileSync(file, source, "utf8");
}

function patchAiWorker() {
  const file = "v10-ai-worker-final.js";
  let source = fs.readFileSync(file, "utf8");
  if (source.includes(MARK)) return;

  const activeProductOld = `function activeProductText(modelInput) {\n  return qualityNormalize(customerMessagesFrom(modelInput).slice(-5).map(function (message) { return message.text || ""; }).join(" "));\n}`;
  const activeProductNew = `function activeProductText(modelInput) {\n  return currentCustomerClusterText(modelInput);\n}`;
  if (!source.includes(activeProductOld)) throw new Error("ACTIVE_INTENT_ACTIVE_PRODUCT_ANCHOR_MISSING");
  source = source.replace(activeProductOld, activeProductNew);

  const clusterStart = source.indexOf("function currentCustomerClusterText(modelInput) {");
  const clusterEnd = source.indexOf("\nfunction currentTurnSlideKeys", clusterStart);
  if (clusterStart < 0 || clusterEnd < 0) throw new Error("ACTIVE_INTENT_CURRENT_CLUSTER_ANCHOR_MISSING");
  const clusterReplacement = `function currentFocusTags(message) {
  const text = qualityNormalize(message && message.text || "");
  const tags = [];
  function add(value) { if (value && !tags.includes(value)) tags.push(value); }
  const toilet = /\\b(bon cau|bet|bet lien khoi|bet thong minh|bet trung|qua trung|toilet)\\b/.test(text);
  const shower = /\\b(sen tam|sen cay|voi sen|sen voi)\\b/.test(text);
  const bathSink = /\\b(lavabo|chau rua mat|bon rua mat|tu lavabo|tu chau|guong lavabo)\\b/.test(text);
  const kitchenSink = /\\b(chau rua bat|chau rua chen|chau rua bep|voi rua bat|voi rua chen|voi rua bep|chau voi)\\b/.test(text);
  const kitchenAppliance = /\\b(bep tu|bep dien|hut mui|may hut|hut khoi)\\b/.test(text);
  const kitchenFurniture = /\\b(tu bep|bo bep|he tu bep|bep dai|tu bep dai|noi that bep theo met)\\b/.test(text)
    || /\\b(?:bo|tu)\\s*bep.{0,24}\\b(?:m|met)\\b/.test(text);
  const fan = /\\b(?:quat|quant)(?:\\s+tran)?(?:.{0,22}(?:5|6|8|10)\\s*canh)?\\b/.test(text);
  const tile = /\\b(gach|op lat|lat nen|da op lat)\\b/.test(text);
  if (toilet) add("toilet");
  if (shower) add("shower");
  if (bathSink) add("bath_sink");
  if (kitchenSink) add("kitchen_sink");
  if (kitchenAppliance) add("kitchen_appliance");
  if (kitchenFurniture) add("kitchen_furniture");
  if (fan) add("fan");
  if (tile) add("tile");
  if (!(toilet || shower || bathSink) && /\\b(phong tam|nha tam|nha ve sinh|nha vs|wc|thiet bi ve sinh|combo.{0,12}(tam|ve sinh))\\b/.test(text)) add("bathroom");
  if (!(kitchenSink || kitchenAppliance || kitchenFurniture) && /\\b(phong bep|nha bep|noi that.{0,12}bep|thiet bi.{0,12}bep|combo.{0,12}bep|com bo.{0,12}bep|bep an)\\b/.test(text)) add("kitchen");
  if (/\\b(noi that nha moi|hoan thien nha|trang bi nha moi|xem het|tat ca mau|toan bo san pham)\\b/.test(text)) add("whole_home");
  return tags;
}

function focusCurrentCustomerMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return messages || [];
  let focusIndex = -1;
  let tags = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const found = currentFocusTags(messages[index]);
    if (!found.length) continue;
    focusIndex = index;
    tags = found;
    break;
  }
  if (focusIndex <= 0 || tags.length !== 1 || tags[0] === "whole_home") return messages;
  const target = tags[0];
  const newer = messages.slice(focusIndex + 1).flatMap(currentFocusTags);
  if (newer.some(function (tag) { return tag !== target; })) return messages;
  const earlier = messages.slice(0, focusIndex).flatMap(currentFocusTags);
  if (!earlier.some(function (tag) { return tag !== target; })) return messages;
  return messages.slice(focusIndex);
}

function currentCustomerClusterText(modelInput) {
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
  const current = messages.slice(boundary + 1).filter(function (message) {
    return message && message.role === "customer" && !["superseded", "cancelled"].includes(String(message.semantic_status || "active").toLowerCase());
  });
  return qualityNormalize(focusCurrentCustomerMessages(current).map(function (message) {
    return message.text || "";
  }).join(" "));
}

// ${MARK}`;
  source = source.slice(0, clusterStart) + clusterReplacement + source.slice(clusterEnd);

  const broadKitchenAnchor = '  const broadKitchen = /\\b(phong bep|nha bep|noi that.{0,12}bep|thiet bi.{0,12}bep|toan bo.{0,20}bep|bep an)\\b/.test(text);';
  if (!source.includes(broadKitchenAnchor)) throw new Error("ACTIVE_INTENT_KITCHEN_SCOPE_ANCHOR_MISSING");
  source = source.replace(
    broadKitchenAnchor,
    `${broadKitchenAnchor}\n  const kitchenFurniture = /\\b(tu bep|bo bep|he tu bep|bep dai|tu bep dai|noi that bep theo met)\\b/.test(text) || /\\b(?:bo|tu)\\s*bep.{0,24}\\b(?:m|met)\\b/.test(text);`,
  );

  const kitchenLogic = `  if (sink) add(key("chau_voi_rua_bat"));\n  else if (stove) add(key("bep_tu_hut_mui"), key("bep_tu"), key("may_hut_mui"));\n  else if (broadKitchen) add(key("bep_tu_hut_mui"), key("chau_voi_rua_bat"));`;
  if (!source.includes(kitchenLogic)) throw new Error("ACTIVE_INTENT_KITCHEN_LOGIC_ANCHOR_MISSING");
  source = source.replace(kitchenLogic, `  if (kitchenFurniture) {\n    // No tủ-bếp catalog is verified here; never substitute appliance/sink slides.\n  } else if (sink) add(key("chau_voi_rua_bat"));\n  else if (stove) add(key("bep_tu_hut_mui"), key("bep_tu"), key("may_hut_mui"));\n  else if (broadKitchen) add(key("bep_tu_hut_mui"), key("chau_voi_rua_bat"));`);

  const fanDecl = '  const fan = /\\b(quat tran|quat 10(?: canh)?|quat 8(?: canh)?|quat 5(?: canh)?|quat 6(?: canh)?)\\b/.test(text);';
  if (!source.includes(fanDecl)) throw new Error("ACTIVE_INTENT_FAN_DECL_ANCHOR_MISSING");
  source = source.replace(fanDecl, `  const fanContext = /\\b(?:quat|quant)(?:\\s+tran)?\\b/.test(text);\n  const fan8 = /\\b(?:quat|quant).{0,18}8(?:\\s*canh)?\\b/.test(text) || (fanContext && /\\b8\\s*canh\\b/.test(text));\n  const fan10 = /\\b(?:quat|quant).{0,18}10(?:\\s*canh)?\\b/.test(text) || (fanContext && /\\b10\\s*canh\\b/.test(text));\n  const fan56 = /\\b(?:quat|quant).{0,18}(?:5|6)(?:\\s*canh)?\\b/.test(text) || (fanContext && /\\b(?:5|6)\\s*canh\\b/.test(text));\n  const gold = /\\b(vang|gold|ma vang)\\b/.test(text);\n  const black = /\\b(den|black)\\b/.test(text);\n  const brown = /\\b(nau|brown)\\b/.test(text);\n  const wood = /\\b(van go|mau go|wood)\\b/.test(text);`);

  const fanLogic = `  if (fan) add(\n    key("quat_10_canh_gold"), key("quat_10_canh_wood"), key("quat_10_canh_black"),\n    key("quat_10_canh_brown"), key("quat_8_canh_gold"), key("quat_8_canh_wood"), key("quat_tran")\n  );`;
  if (!source.includes(fanLogic)) throw new Error("ACTIVE_INTENT_FAN_LOGIC_ANCHOR_MISSING");
  source = source.replace(fanLogic, `  if (fan8) {\n    if (gold) add(key("quat_8_canh_gold"));\n    else if (black) add(key("quat_8_canh_black"));\n    else if (brown) add(key("quat_8_canh_brown"));\n    else if (wood) add(key("quat_8_canh_wood"));\n    else add(key("quat_8_canh"));\n  } else if (fan10) {\n    if (gold) add(key("quat_10_canh_gold"));\n    else if (black) add(key("quat_10_canh_black"));\n    else if (brown) add(key("quat_10_canh_brown"));\n    else if (wood) add(key("quat_10_canh_wood"));\n    else add(key("quat_10_canh"));\n  } else if (fan56) {\n    add(key("quat_5_6_canh"));\n  } else if (fanContext) {\n    add(key("quat_tran"));\n  }`);

  source += `\n// ${MARK}\n`;
  fs.writeFileSync(file, source, "utf8");
}

patchMediaObligation();
patchDecisionContract();
patchAiWorker();
console.log("[AIGUKA V10] active-intent focus enabled: stale broad product needs are closed by later concrete focus; exact product variants never fall back to a different variant");
