const PREVIOUS_FETCH = globalThis.fetch.bind(globalThis);
const PATCH_KEY = "__AIGUKA_META_SALES_LANGUAGE_FETCH_V2__";

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function resolveAddressFromText(value) {
  const normalized = normalize(value);
  const hasAnh = /(^| )anh( |$)/.test(normalized) && !/(^| )anh chi( |$)/.test(normalized);
  const hasChi = /(^| )chi( |$)/.test(normalized) && !/(^| )anh chi( |$)/.test(normalized);
  if (hasAnh && !hasChi) return { lower: "anh", upper: "Anh" };
  if (hasChi && !hasAnh) return { lower: "chị", upper: "Chị" };
  return { lower: "anh/chị", upper: "Anh/chị" };
}

function enforceSalesSalutation(value) {
  const original = String(value || "").trim();
  if (!original) return { changed: false, text: original };
  const address = resolveAddressFromText(original);
  let text = original;

  text = text.replace(/\bBạn\b/g, address.upper);
  text = text.replace(/\bbạn\b/g, address.lower);
  text = text.replace(/\bMình\b/g, address.upper);
  text = text.replace(/\bmình\b/g, address.lower);

  return { changed: text !== original, text };
}

function rewritePriceText(value) {
  const original = String(value || "").trim();
  const normalized = normalize(original);
  const priceContext = /(^| )(gia|bao gia|bao nhieu|xin gia|tam gia|muc gia)( |$)/.test(normalized);
  const internalDisclosure = /((gia|bao gia).*(xac minh|du lieu|he thong|nguon gia|chua co|khong co)|(xac minh|du lieu|he thong|nguon gia|chua co|khong co).*(gia|bao gia))/.test(normalized);
  if (!priceContext || !internalDisclosure) return { changed: false, text: original };

  const address = resolveAddressFromText(original);
  return {
    changed: true,
    text: `Dạ ${address.lower} cho em xin SĐT hoặc Zalo, em gửi báo giá đúng mẫu ${address.lower} đang quan tâm kèm ưu đãi hiện tại ngay ạ.`,
  };
}

function sanitizeCustomerFacingText(value) {
  const price = rewritePriceText(value);
  const salutation = enforceSalesSalutation(price.text);
  return {
    changed: price.changed || salutation.changed,
    text: salutation.text,
    priceRewritten: price.changed,
    salutationRewritten: salutation.changed,
  };
}

if (globalThis[PATCH_KEY]) {
  console.log("[AIGUKA Meta sales language firewall] Already installed");
} else {
  globalThis[PATCH_KEY] = true;
  globalThis.fetch = async function aigukaMetaSalesLanguageFetch(input, init) {
    let url;
    try {
      url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    } catch {
      return PREVIOUS_FETCH(input, init);
    }

    const method = String(init?.method || (typeof input === "object" && input?.method) || "GET").toUpperCase();
    const isMetaSend = url.hostname === "graph.facebook.com"
      && /\/messages\/?$/.test(url.pathname)
      && method === "POST";
    if (!isMetaSend || typeof init?.body !== "string") return PREVIOUS_FETCH(input, init);

    try {
      const payload = JSON.parse(init.body);
      if (typeof payload?.message?.text !== "string") return PREVIOUS_FETCH(input, init);
      const result = sanitizeCustomerFacingText(payload.message.text);
      if (!result.changed) return PREVIOUS_FETCH(input, init);

      payload.message.text = result.text;
      console.warn("[AIGUKA Meta sales language firewall] Rewrote customer-facing wording before Graph API send", {
        price_rewritten: result.priceRewritten,
        salutation_rewritten: result.salutationRewritten,
      });
      return PREVIOUS_FETCH(input, { ...init, body: JSON.stringify(payload) });
    } catch (error) {
      console.error("[AIGUKA Meta sales language firewall] Could not inspect payload:", error.message);
      return PREVIOUS_FETCH(input, init);
    }
  };
  console.log("[AIGUKA Meta sales language firewall] Installed: em -> anh/chi fallback; ban/minh forbidden");
}
