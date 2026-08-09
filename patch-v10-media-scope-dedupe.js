import fs from "node:fs";
import { spawnSync } from "node:child_process";

const FILE = "v10-outbound-worker.js";
const MARK = "AIGUKA_V10_MEDIA_SCOPE_DEDUPE_V1";

if (!fs.existsSync(FILE)) throw new Error("V10_MEDIA_SCOPE_DEDUPE_OUTBOUND_MISSING");
let source = fs.readFileSync(FILE, "utf8");

if (!source.includes(MARK)) {
  const importAnchor = 'import { normalizeVietnamese } from "./v10/core/advisory-engine.js";';
  if (!source.includes(importAnchor)) throw new Error("V10_MEDIA_SCOPE_DEDUPE_IMPORT_ANCHOR_MISSING");
  source = source.replace(
    importAnchor,
    importAnchor + '\nimport { MEDIA_DEDUPE_WINDOW_MS, mediaClaimDisposition, mediaScopeIdempotencyKey, mediaScopeMatchesAssetRefs } from "./v10/core/media-dedupe.js";',
  );

  const processAnchor = "async function processDecision(decision, config) {";
  if (!source.includes(processAnchor)) throw new Error("V10_MEDIA_SCOPE_DEDUPE_PROCESS_ANCHOR_MISSING");
  const helpers = String.raw`
function mediaDedupeBundles(media = {}) {
  if (Array.isArray(media.media_bundles) && media.media_bundles.length) return media.media_bundles;
  if (!Array.isArray(media.assets) || !media.assets.length) return [];
  return [{
    bundle_key: "media:mixed_compat",
    group_key: "mixed_compat",
    label: "Mẫu sản phẩm",
    catalog_keys: media.catalog_keys || [],
    assets: media.assets,
    asset_count: media.assets.length,
  }];
}

async function recentDeliveredMediaScope(decision, group, nowMs = Date.now()) {
  const since = new Date(nowMs - MEDIA_DEDUPE_WINDOW_MS).toISOString();
  const rows = await core(
    "v9_delivery_bundles?select=id,decision_id,idempotency_key,asset_refs,status,created_at,updated_at"
      + "&page_id=eq." + encodeURIComponent(decision.page_id)
      + "&sender_id=eq." + encodeURIComponent(decision.sender_id)
      + "&status=eq.sent"
      + "&updated_at=gte." + encodeURIComponent(since)
      + "&order=updated_at.desc&limit=40"
  );
  for (const row of rows || []) {
    if (!mediaScopeMatchesAssetRefs(group, row.asset_refs || [])) continue;
    const deliveredAttempts = await attempts(row.id);
    const carouselSent = (deliveredAttempts || []).some((attempt) =>
      attempt.status === "sent" && String(attempt.transport || "").includes("meta_messenger_carousel")
    );
    if (carouselSent) return row;
  }
  return null;
}

async function claimMediaScope(decision, group, nowMs = Date.now()) {
  const repeatRequested = sovereignOutboundRepeatRequested(decision);
  const idempotencyKey = mediaScopeIdempotencyKey({
    pageId: decision.page_id,
    senderId: decision.sender_id,
    group,
    decisionId: decision.id,
    repeatRequested,
  });
  const now = new Date(nowMs).toISOString();

  if (!repeatRequested) {
    const delivered = await recentDeliveredMediaScope(decision, group, nowMs);
    if (delivered) {
      const memorial = await core("v9_delivery_bundles?on_conflict=idempotency_key", {
        method: "POST",
        prefer: "resolution=ignore-duplicates,return=representation",
        body: {
          decision_id: delivered.decision_id || decision.id,
          page_id: decision.page_id,
          sender_id: decision.sender_id,
          text_body: null,
          asset_refs: group.assets || [],
          status: "sent",
          idempotency_key: idempotencyKey,
          updated_at: delivered.updated_at || delivered.created_at || now,
        },
      });
      return {
        allowed: false,
        reason: "DUPLICATE_MEDIA_SCOPE_24H",
        bundle: memorial?.[0] || delivered,
        duplicate_bundle_id: delivered.id,
        idempotency_key: idempotencyKey,
      };
    }
  }

  const inserted = await core("v9_delivery_bundles?on_conflict=idempotency_key", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=representation",
    body: {
      decision_id: decision.id,
      page_id: decision.page_id,
      sender_id: decision.sender_id,
      text_body: null,
      asset_refs: group.assets || [],
      status: "staged",
      idempotency_key: idempotencyKey,
      updated_at: now,
    },
  });
  if (inserted?.[0]) {
    return { allowed: true, reason: repeatRequested ? "EXPLICIT_REPEAT_REQUEST" : "NEW_MEDIA_SCOPE", bundle: inserted[0], idempotency_key: idempotencyKey };
  }

  const rows = await core(
    "v9_delivery_bundles?select=id,decision_id,status,idempotency_key,asset_refs,created_at,updated_at"
      + "&idempotency_key=eq." + encodeURIComponent(idempotencyKey)
      + "&limit=1"
  );
  const existing = rows?.[0] || null;
  const disposition = mediaClaimDisposition(existing, { decisionId: decision.id, nowMs });
  if (!disposition.allowed) {
    return { ...disposition, bundle: existing, idempotency_key: idempotencyKey, duplicate_bundle_id: existing?.id || null };
  }
  if (!disposition.takeover) {
    return { ...disposition, bundle: existing, idempotency_key: idempotencyKey };
  }

  const recovered = await core(
    "v9_delivery_bundles?id=eq." + encodeURIComponent(existing.id)
      + "&status=eq." + encodeURIComponent(existing.status)
      + "&updated_at=eq." + encodeURIComponent(existing.updated_at),
    {
      method: "PATCH",
      prefer: "return=representation",
      body: {
        decision_id: decision.id,
        asset_refs: group.assets || [],
        status: "staged",
        updated_at: now,
      },
    },
  );
  if (recovered?.[0]) {
    return { allowed: true, reason: disposition.reason, bundle: recovered[0], idempotency_key: idempotencyKey };
  }
  return { allowed: false, reason: "MEDIA_SCOPE_CLAIM_RACE_LOST", bundle: existing, idempotency_key: idempotencyKey };
}

async function prepareMediaDedupe(decision, media) {
  const groups = mediaDedupeBundles(media);
  const claims = [];
  for (const group of groups) claims.push({ group, ...(await claimMediaScope(decision, group)) });
  return {
    groups,
    claims,
    by_bundle_key: new Map(claims.map((claim) => [String(claim.group.bundle_key || claim.group.group_key || ""), claim])),
    allowed_count: claims.filter((claim) => claim.allowed).length,
    suppressed_count: claims.filter((claim) => !claim.allowed).length,
  };
}

// ${MARK}

`;
  source = source.replace(processAnchor, helpers + processAnchor);

  const bundleAnchor = "  const bundle = await bundleFor(claimed, deliveryText, media.assets);";
  if (!source.includes(bundleAnchor)) throw new Error("V10_MEDIA_SCOPE_DEDUPE_BUNDLE_ANCHOR_MISSING");
  source = source.replace(bundleAnchor, `  let mediaDedupe;
  try {
    mediaDedupe = await prepareMediaDedupe(claimed, media);
  } catch (error) {
    await patchDecision(claimed, "live_delivery_failed", {
      should_send: true,
      transport_locked: false,
      live_delivery_error: "MEDIA_DEDUPE_CLAIM_FAILED:" + String(error?.message || error).slice(0, 700),
      media_dedupe_fail_closed: true,
    }).catch(() => {});
    return { sent: 0, suppressed: 0, failed: 1 };
  }

  if (gate.supportMode && gate.supportSlideEligible && mediaDedupe.groups.length && mediaDedupe.allowed_count === 0) {
    await patchDecision(claimed, "live_suppressed", {
      should_send: false,
      transport_locked: true,
      live_suppression_reason: "DUPLICATE_MEDIA_SCOPE_24H",
      media_dedupe_window_hours: 24,
      media_dedupe_claims: mediaDedupe.claims.map((item) => ({
        bundle_key: item.group.bundle_key,
        catalog_keys: item.group.catalog_keys || [],
        reason: item.reason,
        duplicate_bundle_id: item.duplicate_bundle_id || item.bundle?.id || null,
      })),
      support_mode: true,
      support_primary_bot: "AICAKE",
    });
    return { sent: 0, suppressed: 1, failed: 0 };
  }

${bundleAnchor}`);

  const loopStart = source.indexOf("    for (const group of mediaBundles) {");
  const loopEnd = source.indexOf("\n\n    const partial = Boolean(mediaWarning);", loopStart);
  if (loopStart < 0 || loopEnd < 0) throw new Error("V10_MEDIA_SCOPE_DEDUPE_GROUP_LOOP_MISSING");
  const loop = String.raw`    for (const group of mediaBundles) {
      const claimKey = String(group.bundle_key || group.group_key || "");
      const mediaClaim = mediaDedupe.by_bundle_key.get(claimKey);
      if (!mediaClaim?.allowed || !mediaClaim.bundle?.id) continue;

      const mediaExisting = await attempts(mediaClaim.bundle.id);
      let mediaAttemptNo = Math.max(0, ...(mediaExisting || []).map((item) => Number(item.attempt_no || 0))) + 1;
      let mediaGroupFailed = false;
      const batches = [];
      for (let index = 0; index < group.assets.length; index += 10) batches.push(group.assets.slice(index, index + 10));
      const safeGroup = String(group.group_key || "product").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "product";
      for (let index = 0; index < batches.length; index += 1) {
        const transport = "meta_messenger_carousel_" + safeGroup + "_" + String(index + 1);
        const alreadySent = (mediaExisting || []).some((item) => item.transport === transport && item.status === "sent");
        if (alreadySent) continue;
        try {
          const result = await sendCarousel(claimed.page_id, claimed.sender_id, batches[index], gate.supportSalutation, group.label);
          if (result) await recordAttempt(mediaClaim.bundle.id, mediaAttemptNo++, transport, "sent", result);
        } catch (error) {
          mediaGroupFailed = true;
          mediaWarning = String(error?.message || error).slice(0, 500);
          await recordAttempt(mediaClaim.bundle.id, mediaAttemptNo++, transport, "failed", {}, error);
        }
      }
      await core("v9_delivery_bundles?id=eq." + encodeURIComponent(mediaClaim.bundle.id), {
        method: "PATCH",
        prefer: "return=minimal",
        body: { status: mediaGroupFailed ? "failed" : "sent", updated_at: new Date().toISOString() },
      });
    }`;
  source = source.slice(0, loopStart) + loop + source.slice(loopEnd);

  const metadataAnchor = '      media_bundle_policy: "one_product_group_per_bundle",\n      media_bundles_resolved:';
  if (!source.includes(metadataAnchor)) throw new Error("V10_MEDIA_SCOPE_DEDUPE_METADATA_ANCHOR_MISSING");
  source = source.replace(
    metadataAnchor,
    '      media_bundle_policy: "one_product_group_per_bundle",\n      media_dedupe_window_hours: 24,\n      media_dedupe_suppressed_count: mediaDedupe.suppressed_count,\n      media_dedupe_claims: mediaDedupe.claims.map((item) => ({ bundle_key: item.group.bundle_key, catalog_keys: item.group.catalog_keys || [], allowed: item.allowed, reason: item.reason, claim_bundle_id: item.bundle?.id || null })),\n      media_bundles_resolved:',
  );

  source = source.replace(/const VERSION = "v10_outbound_[^"]+";/, 'const VERSION = "v10_outbound_media_scope_dedupe_v13";');
  fs.writeFileSync(FILE, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", FILE], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`V10_MEDIA_SCOPE_DEDUPE_SYNTAX:${syntax.stderr || syntax.stdout}`);
  if (!source.includes("DUPLICATE_MEDIA_SCOPE_24H") || !source.includes("mediaDedupe.by_bundle_key")) {
    throw new Error("V10_MEDIA_SCOPE_DEDUPE_INSTALL_FAILED");
  }
}

console.log("[AIGUKA V10] media scope dedupe enabled: one customer/catalog scope can acquire one 24h transport claim; explicit resend requests bypass the lock");
