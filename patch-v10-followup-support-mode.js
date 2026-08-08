import fs from "node:fs";

const FILE = "v10-followup-worker.js";
const MARK = "AIGUKA_V10_FOLLOWUP_SUPPORT_MODE_V1";

if (!fs.existsSync(FILE)) throw new Error(`FOLLOWUP_SUPPORT_PATCH_FILE_MISSING:${FILE}`);
let source = fs.readFileSync(FILE, "utf8");

if (!source.includes(MARK)) {
  const oldRuntime = `function isRuntimeActive(runtime = {}) {\n  return String(runtime.mode || "").toUpperCase() === "ACTIVE"\n    && String(runtime.ingest_mode || "").toUpperCase() === "DIRECT_CORE"\n    && String(runtime.external_bot_mode || "").toUpperCase() === "AICAKE_DISABLED"\n    && String(runtime.external_bot_policy || "").toUpperCase() === "AIGUKA_PRIMARY";\n}`;
  const newRuntime = `function isRuntimeActive(runtime = {}) {\n  const mode = String(runtime.mode || "").toUpperCase();\n  const ingest = String(runtime.ingest_mode || "").toUpperCase();\n  const externalMode = String(runtime.external_bot_mode || "").toUpperCase();\n  const externalPolicy = String(runtime.external_bot_policy || "").toUpperCase();\n  const aigukaPrimary = externalMode === "AICAKE_DISABLED" && externalPolicy === "AIGUKA_PRIMARY";\n  const aigukaSupport = externalMode === "AICAKE_ACTIVE" && externalPolicy === "AICAKE_PRIMARY_SUPPORT";\n  return mode === "ACTIVE" && ingest === "DIRECT_CORE" && (aigukaPrimary || aigukaSupport);\n}\n\nfunction pageAllowsFollowup(page = {}) {\n  if (!page?.is_active) return false;\n  const operating = String(page.operating_mode || "").toUpperCase();\n  const coexistence = String(page.coexistence_mode || "").toUpperCase();\n  const supportEnabled = page?.settings?.support_enabled !== false;\n  if (operating === "ACTIVE" && coexistence === "AICAKE_DISABLED") return true;\n  if (operating === "SUPPORT" && coexistence === "AICAKE_ACTIVE" && supportEnabled) return true;\n  return false;\n}`;
  if (!source.includes(oldRuntime)) throw new Error("FOLLOWUP_SUPPORT_RUNTIME_ANCHOR_MISSING");
  source = source.replace(oldRuntime, newRuntime);

  const oldTags = `function hasContactTag(labels) {\n  return labels.some((label) => /(^|\\b)(sdt|so dien thoai|dien thoai|zalo)(\\b|$)/i.test(normalized(label)));\n}`;
  const newTags = `function hasContactTag(labels) {\n  return labels.some((label) => /(^|\\b)(sdt|so dien thoai|dien thoai|zalo|da quet)(\\b|$)/i.test(normalized(label)));\n}`;
  if (!source.includes(oldTags)) throw new Error("FOLLOWUP_SUPPORT_CONTACT_TAG_ANCHOR_MISSING");
  source = source.replace(oldTags, newTags);

  const oldPageGuard = `  const page = await pageRow(claimed.page_id);\n  if (!page?.is_active || String(page.operating_mode || "").toUpperCase() !== "ACTIVE") return suppress(claimed, log, "PAGE_NOT_ACTIVE");\n  if (String(page.coexistence_mode || "").toUpperCase() !== "AICAKE_DISABLED") return suppress(claimed, log, "PAGE_EXTERNAL_BOT_ACTIVE");`;
  const newPageGuard = `  const page = await pageRow(claimed.page_id);\n  if (!pageAllowsFollowup(page)) return suppress(claimed, log, "PAGE_FOLLOWUP_MODE_DISABLED");`;
  if (!source.includes(oldPageGuard)) throw new Error("FOLLOWUP_SUPPORT_PAGE_GUARD_ANCHOR_MISSING");
  source = source.replace(oldPageGuard, newPageGuard);

  source += `\n// ${MARK}\n`;
  fs.writeFileSync(FILE, source, "utf8");
}

console.log("[AIGUKA V10] follow-up support-mode patch active: Event follow-up remains independent from AICAKE live replies; Pancake 'Đã quét' suppresses follow-up");
