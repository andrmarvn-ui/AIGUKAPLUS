import fs from "node:fs";
import { spawnSync } from "node:child_process";

const MARKER = "AIGUKA_V9_NO_DROP_V1";

function syntaxCheck(file) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`NO_DROP_SYNTAX_${file}:${result.stderr || result.stdout}`);
}

function requireAnchor(source, anchor, label) {
  if (!source.includes(anchor)) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
}

function replaceOnce(source, oldValue, newValue, label) {
  if (source.includes(newValue)) return source;
  requireAnchor(source, oldValue, label);
  return source.replace(oldValue, newValue);
}

function replaceBetween(source, startAnchor, endAnchor, replacement, label) {
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  if (start < 0 || end < 0) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  return source.slice(0, start) + replacement + source.slice(end);
}

function replaceBraceBlock(source, startAnchor, replacement, label) {
  if (source.includes(replacement)) return source;
  const start = source.indexOf(startAnchor);
  if (start < 0) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  const open = source.indexOf("{", start + startAnchor.length);
  if (open < 0) throw new Error(`${label}_OPEN_BRACE_NOT_FOUND`);
  let depth = 0;
  let end = -1;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`${label}_CLOSE_BRACE_NOT_FOUND`);
  return source.slice(0, start) + replacement + source.slice(end);
}

function replaceEnclosingIfByToken(source, innerToken, replacement, label) {
  if (source.includes(replacement)) return source;
  const inner = source.indexOf(innerToken);
  if (inner < 0) throw new Error(`${label}_TOKEN_NOT_FOUND`);

  let start = source.lastIndexOf("\n  if", inner);
  if (start >= 0) start += 1;
  else start = source.lastIndexOf("  if", inner);
  if (start < 0) throw new Error(`${label}_IF_NOT_FOUND`);

  const open = source.indexOf("{", start);
  if (open < 0 || open > inner) throw new Error(`${label}_OPEN_BRACE_NOT_FOUND`);

  let depth = 0;
  let end = -1;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`${label}_CLOSE_BRACE_NOT_FOUND`);
  return source.slice(0, start) + replacement + source.slice(end);
}

// A known phone/Zalo is a Contact Lock against asking again, not a conversation lock.
// Only the current message that actually contains a new contact is silently captured.
{
  const file = "v9-ai-shadow-worker.js";
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(MARKER)) {
    const fallbackStart = "  const contactCaptured = Boolean(turn?.contact?.contactCaptured || snapshot?.customer?.phone || snapshot?.customer?.zalo);";
    const fallbackEnd = "  const rawText = String(turn.combinedText || \"\").trim();";
    const fallbackReplacement = `  const contactKnown = Boolean(turn?.contact?.contactCaptured || snapshot?.customer?.phone || snapshot?.customer?.zalo);\n  const contactNewlyCaptured = Boolean(turn?.contact?.newlyCaptured || turn?.contact?.currentTurn?.contactCaptured);\n  if (contactNewlyCaptured) {\n    return {\n      action: "contact_captured",\n      final_reply: "",\n      should_request_contact: false,\n      contact_benefit: "",\n      products: turn?.salesSignals?.products || [],\n      intents: turn?.salesSignals?.intents || [],\n      needs_slides: false,\n      confidence: 1,\n      reason: "Rule fallback: contact newly captured in the current turn.",\n      risk_flags: ["provider_unavailable"],\n    };\n  }\n\n`;
    source = replaceBetween(source, fallbackStart, fallbackEnd, fallbackReplacement, "NO_DROP_AI_CONTACT_FALLBACK");

    const processContact = "  const contactCaptured = Boolean(snapshot?.turn?.contact?.contactCaptured || snapshot?.customer?.phone || snapshot?.customer?.zalo);";
    const processContactReplacement = `  const contactKnown = Boolean(snapshot?.turn?.contact?.contactCaptured || snapshot?.customer?.phone || snapshot?.customer?.zalo);\n  const contactNewlyCaptured = Boolean(snapshot?.turn?.contact?.newlyCaptured || snapshot?.turn?.contact?.currentTurn?.contactCaptured);`;
    source = replaceOnce(source, processContact, processContactReplacement, "NO_DROP_AI_PROCESS_CONTACT");

    const validateAnchor = "    const decision = validateDecision(rawDecision, { contactCaptured });";
    const validateReplacement = `    if (rawDecision?.action === "contact_captured" && !contactNewlyCaptured) {\n      rawDecision = fallbackDecision(snapshot, selectedKnowledge);\n    }\n    let decision = validateDecision(rawDecision, { contactCaptured: contactKnown });`;
    source = replaceOnce(source, validateAnchor, validateReplacement, "NO_DROP_AI_VALIDATE");

    const mediaStart = "    const detectedMediaProducts = Array.isArray(decision.products)";
    const mediaEnd = "    await coreRest(`v9_decisions?id=eq.${row.id}`, {";
    const mediaReplacement = `    const detectedMediaProducts = Array.isArray(decision.products)\n      ? decision.products.map((value) => String(value || "").trim()).filter(Boolean)\n      : [];\n    const requestedMediaProducts = detectedMediaProducts.length\n      ? detectedMediaProducts\n      : mappedSupportProducts;\n    let mediaCatalogKeys = [];\n    if (decision.needs_slides === true) {\n      try {\n        mediaCatalogKeys = resolveAuthoritativeCatalogKeys({\n          requestedKeys: requestedMediaProducts,\n          catalog: selectedKnowledge.catalog || [],\n        });\n      } catch (error) {\n        decision = {\n          ...decision,\n          action: "reply_text",\n          needs_slides: false,\n          final_reply: "Dạ em đã nhận nhu cầu của anh/chị ạ. Anh/chị cho em biết thêm mẫu, kích thước hoặc hạng mục cụ thể để em tư vấn đúng sản phẩm cho mình nhé.",\n          risk_flags: [...new Set([...(decision.risk_flags || []), "media_text_fallback"])].slice(0, 8),\n          reason: \`\${decision.reason || "Media catalog unresolved"} Text fallback: \${String(error?.code || error?.message || error).slice(0, 120)}\`,\n        };\n      }\n    }\n`;
    source = replaceBetween(source, mediaStart, mediaEnd, mediaReplacement, "NO_DROP_AI_MEDIA_FALLBACK");

    source = source.replace(/const VERSION = "[^"]+";/, 'const VERSION = "v9_ai_no_drop_v10";');
    source += `\n// ${MARKER}: known contacts continue receiving replies and media failures downgrade to text.\n`;
    fs.writeFileSync(file, source);
    syntaxCheck(file);
  }
}

// Final delivery trusts evidence tied to the latest customer turn. A stale Page timestamp
// from an earlier message must never suppress a newer customer question. Media failure also
// downgrades to a truthful text reply instead of silently dropping the conversation.
{
  const file = "v9-live-outbound-worker.js";
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(MARKER)) {
    const contactGate = "  if (state.phone || state.zalo || [\"captured\", \"verified\"].includes(String(state.contact_status || \"\").toLowerCase())) return { allowed: false, reason: \"CONTACT_ALREADY_CAPTURED\" };";
    source = replaceOnce(
      source,
      contactGate,
      "  // Contact Lock only removes repeated contact requests; it must not silence later customer questions.",
      "NO_DROP_OUTBOUND_CONTACT_GATE",
    );

    const newPageGate = `  const turn = decision?.input_snapshot?.turn || {};\n  const evidence = turn.responseEvidence || turn.response_evidence || {};\n  if (evidence.verifiedHuman || evidence.bot || evidence.automation || evidence.ambiguousPage) {\n    return { allowed: false, reason: "PAGE_ALREADY_REPLIED" };\n  }\n  const latestCustomerAt = Math.max(0, ...(Array.isArray(turn.customerMessages) ? turn.customerMessages : [])\n    .map((item) => Date.parse(item?.occurredAt || item?.occurred_at || ""))\n    .filter(Number.isFinite));\n  const lastPageAt = Date.parse(state.last_page_event_at || "");\n  if (latestCustomerAt > 0 && Number.isFinite(lastPageAt) && lastPageAt >= latestCustomerAt) {\n    return { allowed: false, reason: "PAGE_ALREADY_REPLIED" };\n  }`;
    source = replaceEnclosingIfByToken(
      source,
      'reason: "PAGE_ALREADY_REPLIED"',
      newPageGate,
      "NO_DROP_OUTBOUND_PAGE_GATE",
    );

    const helperAnchor = "async function processDecision(decision, config) {";
    const helper = `function truthfulTextFallback(decision, originalText) {\n  const output = decision?.output || {};\n  const intents = Array.isArray(output.intents) ? output.intents : [];\n  if (intents.includes("price")) {\n    return output.should_request_contact === false\n      ? "Dạ mẫu này có nhiều phiên bản và mức giá khác nhau ạ. Anh/chị cho em biết thêm mã hoặc đặc điểm mẫu, bên em kiểm tra và báo đúng giá cho mình nhé."\n      : "Dạ mẫu này có nhiều phiên bản và mức giá khác nhau ạ. Anh/chị cho em xin SĐT hoặc Zalo, bên em kiểm tra đúng mẫu và gửi báo giá chi tiết cho mình nhé.";\n  }\n  const safe = String(originalText || "").trim();\n  const normalizedSafe = safe.toLocaleLowerCase("vi");\n  const claimsMediaSent = normalizedSafe.includes("đã gửi")\n    || normalizedSafe.includes("gửi rồi")\n    || normalizedSafe.includes("em gửi")\n    || normalizedSafe.includes("gửi anh/chị");\n  if (safe && !claimsMediaSent) return safe;\n  return output.should_request_contact === false\n    ? "Dạ em đã nhận nhu cầu của anh/chị ạ. Anh/chị nói thêm mẫu, kích thước hoặc hạng mục cụ thể để em tư vấn đúng sản phẩm cho mình nhé."\n    : "Dạ em đã nhận nhu cầu của anh/chị ạ. Anh/chị cho em xin SĐT hoặc Zalo và nói thêm mẫu, kích thước hoặc hạng mục cụ thể để bên em tư vấn đúng sản phẩm cho mình nhé.";\n}\n\n`;
    source = replaceOnce(source, helperAnchor, `${helper}${helperAnchor}`, "NO_DROP_OUTBOUND_TEXT_HELPER");

    const mediaStart = "  const needsSlides = Boolean(claimed?.output?.needs_slides || claimed.action === \"reply_with_slides\");";
    const mediaEnd = "  const bundle = await bundleFor(claimed, gate.text, assets);";
    const mediaReplacement = `  const needsSlides = Boolean(claimed?.output?.needs_slides || claimed.action === "reply_with_slides");\n  let mediaSelection = { assets: [], catalog_keys: [], requested_keys: [] };\n  let mediaFallbackReason = null;\n  if (needsSlides) {\n    try {\n      mediaSelection = await resolveAssets(claimed);\n      if (!mediaSelection.assets?.length) mediaFallbackReason = "MEDIA_ASSET_NOT_FOUND";\n    } catch (error) {\n      mediaFallbackReason = String(error?.code || error?.message || error).slice(0, 300);\n    }\n  }\n  const assets = mediaFallbackReason ? [] : (mediaSelection.assets || []);\n  let deliveryText = gate.text;\n  if (mediaFallbackReason) {\n    deliveryText = truthfulTextFallback(claimed, gate.text);\n    claimed.action = "reply_text";\n    claimed.output = {\n      ...(claimed.output || {}),\n      action: "reply_text",\n      needs_slides: false,\n      final_reply: deliveryText,\n      media_text_fallback: true,\n      media_fallback_reason: mediaFallbackReason,\n      risk_flags: [...new Set([...(claimed.output?.risk_flags || []), "media_text_fallback"])].slice(0, 8),\n    };\n  } else {\n    claimed.output = {\n      ...(claimed.output || {}),\n      media_catalog_keys_resolved: mediaSelection.catalog_keys,\n      media_requested_keys: mediaSelection.requested_keys,\n      media_asset_catalog_keys: [...new Set(assets.map((asset) => asset.catalog_key))],\n      media_authority_version: "v1",\n    };\n  }\n`;
    source = replaceBetween(source, mediaStart, mediaEnd, mediaReplacement, "NO_DROP_OUTBOUND_MEDIA_FALLBACK");
    source = replaceOnce(
      source,
      mediaEnd,
      "  const bundle = await bundleFor(claimed, deliveryText, assets);",
      "NO_DROP_OUTBOUND_BUNDLE_TEXT",
    );

    source = source.replace(/const VERSION = "[^"]+";/, 'const VERSION = "v9_live_outbound_no_drop_v5";');
    source += `\n// ${MARKER}: fresh-turn Page gate and truthful text fallback installed.\n`;
    fs.writeFileSync(file, source);
    syntaxCheck(file);
  }
}

{
  const file = "v9-direct-core-worker.js";
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(MARKER)) {
    source = source.replace(/const VERSION = "[^"]+";/, 'const VERSION = "v9_direct_no_drop_v3";');
    source += `\n// ${MARKER}: sticky contact lock removed by conversation intelligence.\n`;
    fs.writeFileSync(file, source);
    syntaxCheck(file);
  }
}

console.log(`[AIGUKA V9] ${MARKER} installed: no stale Page suppression, no sticky contact silence, media fail-open to text`);
