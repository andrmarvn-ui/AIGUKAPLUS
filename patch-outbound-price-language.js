import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "outbound-worker.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_PRICE_SALES_LANGUAGE_FIREWALL_V1";

if (source.includes(marker)) {
  console.log("[AIGUKA] Price sales-language firewall already installed");
} else {
  const buildAnchor = "function buildMetaMessage(item) {";
  if (!source.includes(buildAnchor)) throw new Error("PRICE_FIREWALL_BUILD_ANCHOR_NOT_FOUND");

  const helper = `// ${marker}
function normalizePriceGuard(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function safePriceSalesReply(originalText) {
  const normalized = normalizePriceGuard(originalText);
  const priceContext = /(^| )(gia|bao gia|bao nhieu|xin gia|tam gia|muc gia)( |$)/.test(normalized);
  const internalDisclosure = /((gia|bao gia).*(xac minh|du lieu|he thong|nguon gia|chua co|khong co)|(xac minh|du lieu|he thong|nguon gia|chua co|khong co).*(gia|bao gia))/.test(normalized);
  if (!priceContext || !internalDisclosure) return { changed: false, text: originalText };

  const feminine = /(^| )(chi)( |$)/.test(normalized) && !/(^| )(anh)( |$)/.test(normalized);
  const masculine = /(^| )(anh)( |$)/.test(normalized);
  const text = feminine
    ? "Dạ chị cho em xin SĐT hoặc Zalo, em gửi báo giá đúng mẫu chị đang quan tâm kèm ưu đãi hiện tại ngay ạ."
    : masculine
      ? "Dạ anh cho em xin SĐT hoặc Zalo, em gửi báo giá đúng mẫu anh đang quan tâm kèm ưu đãi hiện tại ngay ạ."
      : "Dạ, mình để lại SĐT hoặc Zalo, em gửi báo giá đúng mẫu mình đang quan tâm kèm ưu đãi hiện tại ngay ạ.";
  return { changed: true, text };
}

function sanitizePricePayload(item) {
  const payload = item?.payload && typeof item.payload === "object"
    ? JSON.parse(JSON.stringify(item.payload))
    : {};
  let changed = false;
  let originalText = null;
  let safeText = null;

  if (item.message_type === "text") {
    originalText = String(payload.text || "").trim();
    const result = safePriceSalesReply(originalText);
    if (result.changed) {
      payload.text = result.text;
      changed = true;
      safeText = result.text;
    }
  }

  if (payload.message && typeof payload.message === "object" && typeof payload.message.text === "string") {
    originalText = String(payload.message.text || "").trim();
    const result = safePriceSalesReply(originalText);
    if (result.changed) {
      payload.message.text = result.text;
      changed = true;
      safeText = result.text;
    }
  }

  return {
    changed,
    item: { ...item, payload },
    originalText,
    safeText,
  };
}

${buildAnchor}`;
  source = source.replace(buildAnchor, helper);

  const sendAnchor = `const result = await sendMeta({ ...item, payload: confirmation.payload || item.payload, message_type: confirmation.message_type || item.message_type });`;
  const replacement = `const confirmedItem = {
      ...item,
      payload: confirmation.payload || item.payload,
      message_type: confirmation.message_type || item.message_type,
    };
    const priceFirewall = sanitizePricePayload(confirmedItem);
    if (priceFirewall.changed) {
      console.warn(\`[AIGUKA outbound] Rewrote internal price-data wording for \${item.id}\`);
      await rest(\`v8_outbound_queue?id=eq.\${encodeURIComponent(item.id)}\`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: {
          payload: priceFirewall.item.payload,
          metadata: {
            ...(item.metadata || {}),
            price_sales_language_firewall: true,
            price_sales_language_firewall_version: "v1",
            price_sales_language_rewritten_at: new Date().toISOString(),
          },
        },
      }).catch((error) => console.error("[AIGUKA outbound price firewall audit]", error.message));
    }
    const result = await sendMeta(priceFirewall.item);`;
  if (!source.includes(sendAnchor)) throw new Error("PRICE_FIREWALL_SEND_ANCHOR_NOT_FOUND");
  source = source.replace(sendAnchor, replacement);

  source = source.replace('const WORKER_VERSION = "production_v1";', 'const WORKER_VERSION = "production_v2_price_sales_language_firewall";');
  source = source.replace(
    "page_verification: true,",
    "page_verification: true,\n        price_sales_language_firewall: true,\n        internal_price_data_disclosure_blocked: true,",
  );

  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`PRICE_FIREWALL_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Final Meta transport now blocks internal price-data wording");
}
