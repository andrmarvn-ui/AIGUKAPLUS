const PREVIOUS_FETCH = globalThis.fetch.bind(globalThis);
const PATCH_KEY = "__AIGUKA_META_PRICE_LANGUAGE_FETCH_V1__";

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function rewritePriceText(value) {
  const original = String(value || "").trim();
  const normalized = normalize(original);
  const priceContext = /(^| )(gia|bao gia|bao nhieu|xin gia|tam gia|muc gia)( |$)/.test(normalized);
  const internalDisclosure = /((gia|bao gia).*(xac minh|du lieu|he thong|nguon gia|chua co|khong co)|(xac minh|du lieu|he thong|nguon gia|chua co|khong co).*(gia|bao gia))/.test(normalized);
  if (!priceContext || !internalDisclosure) return { changed: false, text: original };

  const hasAnh = /(^| )anh( |$)/.test(normalized);
  const hasChi = /(^| )chi( |$)/.test(normalized) && !hasAnh;
  if (hasAnh) {
    return {
      changed: true,
      text: "Dạ anh cho em xin SĐT hoặc Zalo, em gửi báo giá đúng mẫu anh đang quan tâm kèm ưu đãi hiện tại ngay ạ.",
    };
  }
  if (hasChi) {
    return {
      changed: true,
      text: "Dạ chị cho em xin SĐT hoặc Zalo, em gửi báo giá đúng mẫu chị đang quan tâm kèm ưu đãi hiện tại ngay ạ.",
    };
  }
  return {
    changed: true,
    text: "Dạ, mình để lại SĐT hoặc Zalo, em gửi báo giá đúng mẫu mình đang quan tâm kèm ưu đãi hiện tại ngay ạ.",
  };
}

if (globalThis[PATCH_KEY]) {
  console.log("[AIGUKA Meta price firewall] Already installed");
} else {
  globalThis[PATCH_KEY] = true;
  globalThis.fetch = async function aigukaMetaPriceLanguageFetch(input, init) {
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
      const result = rewritePriceText(payload.message.text);
      if (!result.changed) return PREVIOUS_FETCH(input, init);

      payload.message.text = result.text;
      console.warn("[AIGUKA Meta price firewall] Rewrote internal price-data wording before Graph API send");
      return PREVIOUS_FETCH(input, { ...init, body: JSON.stringify(payload) });
    } catch (error) {
      console.error("[AIGUKA Meta price firewall] Could not inspect payload:", error.message);
      return PREVIOUS_FETCH(input, init);
    }
  };
  console.log("[AIGUKA Meta price firewall] Installed at Graph API transport boundary");
}
