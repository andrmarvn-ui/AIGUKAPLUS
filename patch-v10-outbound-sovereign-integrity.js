import fs from "node:fs";

const FILE = "v10-outbound-worker.js";
const MARK = "AIGUKA_V10_OUTBOUND_SOVEREIGN_INTEGRITY_V1";

if (!fs.existsSync(FILE)) throw new Error("V10_OUTBOUND_SOVEREIGN_FILE_MISSING");
let source = fs.readFileSync(FILE, "utf8");

if (!source.includes(MARK)) {
  const finalGateAnchor = "async function finalGate(decision, config) {";
  if (!source.includes(finalGateAnchor)) throw new Error("V10_OUTBOUND_SOVEREIGN_FINAL_GATE_MISSING");

  const helpers = String.raw`
function sovereignOutboundCustomerCluster(decision) {
  const messages = decision?.input_snapshot?.conversation?.messages || [];
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index] && messages[index].role !== "customer") {
      boundary = index;
      break;
    }
  }
  return normalizeVietnamese(messages.slice(boundary + 1)
    .filter((message) => message?.role === "customer")
    .map((message) => message.text || "")
    .join(" "));
}

function sovereignOutboundRepeatRequested(decision) {
  return /\b(gui lai|nhac lai|noi lai|lap lai|gui them|xem lai)\b/.test(sovereignOutboundCustomerCluster(decision));
}

async function sovereignRecentDuplicate(decision, text) {
  if (sovereignOutboundRepeatRequested(decision)) return null;
  const normalized = normalizeVietnamese(text || "");
  if (!normalized) return null;
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const rows = await core(
    "v9_decisions?select=id,status,output,created_at&page_id=eq." + encodeURIComponent(decision.page_id)
      + "&sender_id=eq." + encodeURIComponent(decision.sender_id)
      + "&id=neq." + encodeURIComponent(decision.id)
      + "&status=in.(live_delivered,live_delivered_partial)"
      + "&created_at=gte." + encodeURIComponent(since)
      + "&order=created_at.desc&limit=20"
  ).catch(() => []);
  return (rows || []).find((row) => normalizeVietnamese(row?.output?.final_reply || "") === normalized) || null;
}

// ${MARK}

`;
  source = source.replace(finalGateAnchor, helpers + finalGateAnchor);

  const allowAnchor = "  return { allowed: true, page, state, text, contactKnown };";
  if (!source.includes(allowAnchor)) throw new Error("V10_OUTBOUND_SOVEREIGN_ALLOW_ANCHOR_MISSING");
  source = source.replace(allowAnchor, `  const duplicate = await sovereignRecentDuplicate(decision, text);\n  if (duplicate) return { allowed: false, reason: "EXACT_DUPLICATE_RECENT_REPLY", duplicate_decision_id: duplicate.id };\n  return { allowed: true, page, state, text, contactKnown };`);

  const mediaReturn = `  return {
    assets: roundRobinAssets(scopeGroups),
    catalog_keys: scopeGroups.map((group) => group.catalog_key),
  };`;
  if (source.includes(mediaReturn)) {
    source = source.replace(mediaReturn, `  const resolvedKeys = scopeGroups.map((group) => group.catalog_key);\n  return {\n    assets: roundRobinAssets(scopeGroups),\n    catalog_keys: resolvedKeys,\n    missing_catalog_keys: scopes.filter((scopeKey) => !resolvedKeys.includes(scopeKey)),\n    requested_catalog_keys: scopes,\n  };`);
  }

  const warningAnchor = `    media = await resolveAssets(claimed);
    if ((claimed.output?.needs_slides || claimed.action === "reply_with_slides") && !media.assets.length) mediaWarning = "NO_PUBLISHED_ASSET_MATCH";`;
  if (!source.includes(warningAnchor)) throw new Error("V10_OUTBOUND_SOVEREIGN_MEDIA_WARNING_ANCHOR_MISSING");
  source = source.replace(warningAnchor, `    media = await resolveAssets(claimed);\n    if ((claimed.output?.needs_slides || claimed.action === "reply_with_slides") && !media.assets.length) mediaWarning = "NO_PUBLISHED_ASSET_MATCH";\n    if (Array.isArray(media.missing_catalog_keys) && media.missing_catalog_keys.length) {\n      mediaWarning = "MEDIA_SCOPE_INCOMPLETE:" + media.missing_catalog_keys.join(",");\n    }`);

  const patchOutputAnchor = `      media_catalog_keys_resolved: media.catalog_keys,
      media_asset_count: media.assets.length,`;
  if (!source.includes(patchOutputAnchor)) throw new Error("V10_OUTBOUND_SOVEREIGN_OUTPUT_ANCHOR_MISSING");
  source = source.replace(patchOutputAnchor, `      media_catalog_keys_resolved: media.catalog_keys,\n      media_catalog_keys_requested: media.requested_catalog_keys || claimed.output?.selected_catalog_keys || [],\n      media_catalog_keys_missing: media.missing_catalog_keys || [],\n      media_scope_complete: !(media.missing_catalog_keys || []).length,\n      media_asset_count: media.assets.length,`);

  source = source.replace(/const VERSION = "v10_outbound_[^"]+";/, 'const VERSION = "v10_outbound_sovereign_integrity_v5";');
  if (!source.includes(MARK) || !source.includes("EXACT_DUPLICATE_RECENT_REPLY") || !source.includes("media_scope_complete")) {
    throw new Error("V10_OUTBOUND_SOVEREIGN_INSTALL_FAILED");
  }
  fs.writeFileSync(FILE, source, "utf8");
}

console.log("[AIGUKA V10] outbound sovereign integrity enabled: exact cross-decision duplicates blocked and requested media scopes audited without changing AI business intent");
