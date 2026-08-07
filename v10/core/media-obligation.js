import { normalizeVietnamese } from "./advisory-engine.js";

function hasDeliveredMedia(message) {
  if (!message || message.role === "customer") return false;
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (attachments.some((attachment) => {
    const type = String(attachment?.type || attachment?.attachment_type || "").toLowerCase();
    return type === "image" || type === "template" || type === "carousel" || Boolean(attachment?.source_url || attachment?.image_url);
  })) return true;
  const eventType = String(message.event_type || "").toLowerCase();
  return /slide|carousel|media|image/.test(eventType) && attachments.length > 0;
}

// Media obligations survive ordinary text replies. They are cleared only after there
// is evidence that page/bot/human media was actually delivered. This avoids the old
// "latest turn wins" failure where a phone number or location message erased an earlier
// request for samples before any images had been sent.
function customerMediaWindow(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  let lastDeliveredMedia = -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (hasDeliveredMedia(list[index])) {
      lastDeliveredMedia = index;
      break;
    }
  }
  return list.slice(lastDeliveredMedia + 1).filter((message) => message && message.role === "customer");
}

function slideKeySet(slideKeys) {
  if (slideKeys instanceof Set) return slideKeys;
  return new Set((Array.isArray(slideKeys) ? slideKeys : []).map(String));
}

export function customerClusterText(messages = []) {
  return normalizeVietnamese(customerMediaWindow(messages).map((message) => message.text || "").join(" "));
}

export function explicitMediaRequestFromMessages(messages = []) {
  const cluster = customerMediaWindow(messages);
  const raw = cluster.map((message) => String(message.text || "")).join(" ").toLowerCase();
  const text = normalizeVietnamese(raw);

  if (/(?:gửi|gui|chụp|chup|cho\s+xem|xem|xin\s+xem|tham\s+khảo|tham\s+khao).{0,32}(?:mẫu|mau|ảnh|ảh|hình|hinh|catalog)/iu.test(raw)) return true;
  if (/(?:ảnh|ảh|hình|hinh|mẫu|mau).{0,20}(?:qua\s+đây|qua\s+day|trên\s+messenger|tren\s+messenger|cho\s+xem)/iu.test(raw)) return true;
  if (/\b(?:gui|chup|cho xem|xem|xin xem|tham khao).{0,28}\b(?:mau|ah|hinh|catalog)\b/.test(text)) return true;
  if (/\bgui\s+anh\s+(?:qua day|tren messenger|o day)\b/.test(text)) return true;
  if (/\b(?:xem them|mau khac|gui them mau|gui lai anh|gui lai hinh)\b/.test(text)) return true;
  return false;
}

export function deriveMediaScope(messages = [], slideKeys = new Set()) {
  const available = slideKeySet(slideKeys);
  const text = customerClusterText(messages);
  const output = [];

  function add(value) {
    if (value && available.has(value) && !output.includes(value)) output.push(value);
  }

  function addPreferred(primary, fallbacks = []) {
    if (available.has(primary)) {
      add(primary);
      return;
    }
    for (const fallback of fallbacks) add(fallback);
  }

  const broadHome = /\b(noi that nha moi|hoan thien nha|trang bi nha moi|xem het|tat ca mau|toan bo san pham)\b/.test(text);
  const bathroom = /\b(phong tam|nha tam|nha ve sinh|nha vs|ve sinh|wc|thiet bi ve sinh|combo.{0,12}(tam|ve sinh)|tron bo.{0,12}(tam|ve sinh|nha vs))\b/.test(text);
  const broadKitchen = /\b(phong bep|nha bep|noi that.{0,12}bep|thiet bi.{0,12}bep|combo.{0,12}bep|com bo.{0,12}bep|tron bo.{0,20}bep|lam moi.{0,12}bep|bep an)\b/.test(text);
  const asksKitchenAndBath = bathroom && broadKitchen;

  const toilet = /\b(bon cau|bet|bet lien khoi|bet thong minh|bet trung|qua trung|toilet)\b/.test(text);
  const explicitBathroomSink = /\b(lavabo|chau rua mat|bon rua mat|chau lavabo)\b/.test(text);
  const explicitKitchenSink = /\b(chau rua bat|chau rua chen|chau rua bep|bon rua bat|bon rua bep|voi rua bat|voi rua chen|voi rua bep|chau voi)\b/.test(text);
  const genericSink = /\b(chau rua|chau|bon rua|voi rua)\b/.test(text);
  const bathroomSink = explicitBathroomSink || (bathroom && genericSink && !explicitKitchenSink);
  const kitchenSink = explicitKitchenSink || (!bathroom && broadKitchen && genericSink);

  const stove = /\b(bep tu|bep dien|hut mui|may hut|hut khoi)\b/.test(text);
  const mirror = /\b(guong tu|tu guong|tu lavabo|tu chau|guong lavabo|guong phong tam)\b/.test(text);
  const tile = /\b(gach|gach lat|gach lat nen|lat nen|gach op|gach op lat|da op lat|op lat)\b/.test(text);

  // Common Messenger typo: "quant tran" is usually a mistyped "quat tran". Once a
  // fan word is present in the unresolved customer window, later shorthand such as
  // "8 canh, vang" still belongs to the same fan request.
  const fanContext = /\b(?:quat|quant)(?:\s+tran)?\b/.test(text);
  const fan8 = /\b(?:quat|quant).{0,18}8(?:\s*canh)?\b/.test(text) || (fanContext && /\b8\s*canh\b/.test(text));
  const fan10 = /\b(?:quat|quant).{0,18}10(?:\s*canh)?\b/.test(text) || (fanContext && /\b10\s*canh\b/.test(text));
  const fan56 = /\b(?:quat|quant).{0,18}(?:5|6)(?:\s*canh)?\b/.test(text) || (fanContext && /\b(?:5|6)\s*canh\b/.test(text));
  const fan = fanContext || fan8 || fan10 || fan56;
  const gold = /\b(vang|gold|ma vang)\b/.test(text);
  const black = /\b(den|black)\b/.test(text);
  const brown = /\b(nau|brown)\b/.test(text);
  const wood = /\b(van go|mau go|wood)\b/.test(text);

  if (broadHome || asksKitchenAndBath) {
    addPreferred("combo_phong_tam", ["combo_phong_tam_ban_chay", "combo_phong_tam_dep_moi"]);
    addPreferred("bep_tu_hut_mui", ["bep_tu", "may_hut_mui"]);
    add("chau_voi_rua_bat");
  } else {
    if (stove) addPreferred("bep_tu_hut_mui", ["bep_tu", "may_hut_mui"]);
    if (kitchenSink) add("chau_voi_rua_bat");
    if (broadKitchen && !stove && !kitchenSink) {
      addPreferred("bep_tu_hut_mui", ["bep_tu", "may_hut_mui"]);
      add("chau_voi_rua_bat");
    }

    if (toilet) addPreferred("bon_cau", ["bon_cau_lien_khoi", "bon_cau_thong_minh"]);
    if (bathroomSink) add("lavabo");
    if (mirror) addPreferred("guong_tu", ["tu_chau_guong"]);
    if (bathroom && !toilet && !bathroomSink && !mirror) {
      addPreferred("combo_phong_tam", ["combo_phong_tam_ban_chay", "combo_phong_tam_dep_moi"]);
    }
  }

  if (tile) addPreferred("gach_ngoi", ["gach_80x80", "gach_an_do", "gach_tay_ban_nha", "gach_stone"]);

  if (fan8) {
    if (gold) addPreferred("quat_8_canh_gold", ["quat_tran"]);
    else if (black) addPreferred("quat_8_canh_black", ["quat_tran"]);
    else if (brown) addPreferred("quat_8_canh_brown", ["quat_tran"]);
    else if (wood) addPreferred("quat_8_canh_wood", ["quat_tran"]);
    else {
      add("quat_8_canh_gold");
      add("quat_8_canh_black");
      add("quat_8_canh_brown");
      add("quat_8_canh_wood");
      if (!output.length) add("quat_tran");
    }
  } else if (fan10) {
    if (gold) addPreferred("quat_10_canh_gold", ["quat_10_canh", "quat_tran"]);
    else if (black) addPreferred("quat_10_canh_black", ["quat_10_canh", "quat_tran"]);
    else if (brown) addPreferred("quat_10_canh_brown", ["quat_10_canh", "quat_tran"]);
    else if (wood) addPreferred("quat_10_canh_wood", ["quat_10_canh", "quat_tran"]);
    else addPreferred("quat_10_canh", ["quat_10_canh_gold", "quat_10_canh_wood", "quat_10_canh_black", "quat_10_canh_brown", "quat_tran"]);
  } else if (fan56) {
    addPreferred("quat_5_6_canh", ["quat_tran"]);
  } else if (fan) {
    addPreferred("quat_tran", ["quat_10_canh_gold", "quat_8_canh_gold"]);
  }

  return output;
}

export function mediaExpectedFromMessages(messages = [], scope = []) {
  if (!Array.isArray(scope) || !scope.length) return false;
  if (explicitMediaRequestFromMessages(messages)) return true;
  if (scope.length >= 2) return true;

  const cluster = customerMediaWindow(messages);
  const text = customerClusterText(messages);
  const productPostback = cluster.some((message) => {
    if (!/postback/i.test(String(message.event_type || ""))) return false;
    return /\b(tu van|xem|mau|nha tam|nha bep|phong tam|phong bep|gach|quat|quant|bon cau|lavabo|combo)\b/.test(normalizeVietnamese(message.text || ""));
  });
  if (productPostback) return true;

  return /\b(tu van|combo|com bo|tron bo|lam moi|xay nha|hoan thien nha|tham khao|xem mau)\b/.test(text);
}

export const mediaObligationVersion = "v10_media_obligation_v3_unresolved_until_media";
