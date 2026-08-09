import crypto from "node:crypto";

export const mediaDedupeVersion = "v10_media_scope_dedupe_v1";
export const MEDIA_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MEDIA_CLAIM_STALE_MS = 5 * 60 * 1000;

function clean(value) {
  return String(value || "").trim();
}

function uniqueSorted(values) {
  return [...new Set(values.map(clean).filter(Boolean))].sort();
}

export function mediaScopeCatalogKeys(group = {}) {
  const declared = Array.isArray(group.catalog_keys) ? group.catalog_keys : [];
  const fromAssets = (Array.isArray(group.assets) ? group.assets : [])
    .flatMap((asset) => [asset?.catalog_key, asset?.source_catalog_key]);
  return uniqueSorted(declared.length ? declared : fromAssets);
}

function mediaAssetKeys(assets = []) {
  return uniqueSorted(assets.map((asset) => asset?.asset_id || asset?.source_url));
}

export function mediaScopeFingerprint(group = {}) {
  const catalogKeys = mediaScopeCatalogKeys(group);
  const identity = catalogKeys.length
    ? `catalog:${catalogKeys.join("|")}`
    : `assets:${mediaAssetKeys(group.assets).join("|")}`;
  return crypto.createHash("sha256").update(identity).digest("hex");
}

export function mediaScopeIdempotencyKey({
  pageId,
  senderId,
  group,
  decisionId,
  repeatRequested = false,
} = {}) {
  const scope = mediaScopeFingerprint(group);
  const prefix = repeatRequested ? "v10-media-repeat-v1" : "v10-media-scope-v1";
  const repeat = repeatRequested ? `:${clean(decisionId)}` : "";
  return `${prefix}:${clean(pageId)}:${clean(senderId)}:${scope}${repeat}`;
}

export function mediaScopeMatchesAssetRefs(group = {}, assetRefs = []) {
  const requestedCatalogs = mediaScopeCatalogKeys(group);
  const deliveredCatalogs = new Set(mediaScopeCatalogKeys({ assets: assetRefs }));
  if (requestedCatalogs.length) {
    return requestedCatalogs.every((key) => deliveredCatalogs.has(key));
  }

  const requestedAssets = mediaAssetKeys(group.assets);
  const deliveredAssets = new Set(mediaAssetKeys(assetRefs));
  return requestedAssets.length > 0 && requestedAssets.every((key) => deliveredAssets.has(key));
}

export function mediaClaimDisposition(existing, {
  decisionId,
  nowMs = Date.now(),
  windowMs = MEDIA_DEDUPE_WINDOW_MS,
  staleMs = MEDIA_CLAIM_STALE_MS,
} = {}) {
  if (!existing) return { allowed: true, takeover: false, reason: "NEW_MEDIA_SCOPE" };
  if (clean(existing.decision_id) === clean(decisionId)) {
    return { allowed: true, takeover: false, reason: "SAME_DECISION_RETRY" };
  }

  const status = clean(existing.status).toLowerCase();
  const updatedAt = Date.parse(existing.updated_at || existing.created_at || "");
  const ageMs = Number.isFinite(updatedAt) ? Math.max(0, nowMs - updatedAt) : Number.POSITIVE_INFINITY;

  if (status === "sent" && ageMs < windowMs) {
    return { allowed: false, takeover: false, reason: "DUPLICATE_MEDIA_SCOPE_24H", age_ms: ageMs };
  }
  if (["staged", "authorized", "sending"].includes(status) && ageMs < staleMs) {
    return { allowed: false, takeover: false, reason: "MEDIA_SCOPE_CLAIM_IN_PROGRESS", age_ms: ageMs };
  }
  return { allowed: true, takeover: true, reason: "MEDIA_SCOPE_CLAIM_RECOVERED", age_ms: ageMs };
}
