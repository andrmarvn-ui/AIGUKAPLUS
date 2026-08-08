export const carouselMediaVersion = "v10_storage_carousel_v1";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export function driveFileId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    const queryId = String(url.searchParams.get("id") || "").trim();
    if (/^[A-Za-z0-9_-]{10,200}$/.test(queryId)) return queryId;
    const pathMatch = url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,200})/);
    return pathMatch?.[1] || "";
  } catch {
    const match = text.match(/(?:[?&]id=|\/file\/d\/)([A-Za-z0-9_-]{10,200})/);
    return match?.[1] || "";
  }
}

function validHttpsUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function isDynamicOrDriveUrl(value) {
  const url = validHttpsUrl(value);
  if (!url) return true;
  const host = url.hostname.toLowerCase();
  if (host === "drive.google.com" || host === "drive.usercontent.google.com" || host.endsWith(".googleusercontent.com")) return true;
  if (url.pathname.includes("/functions/v1/aiguka-drive-image-proxy")) return true;
  if (url.pathname.includes("/api/slide-manager/image/")) return true;
  return false;
}

export function staticCarouselUrl(asset = {}, storageRow = null) {
  const row = storageRow || asset;
  const storageReady = String(row.storage_status || asset.storage_status || "").toLowerCase() === "ready";
  const candidates = [
    storageReady ? row.storage_url || asset.storage_url : "",
    row.delivery_url || asset.delivery_url,
    asset.source_url,
  ];
  for (const candidate of candidates) {
    const url = validHttpsUrl(candidate);
    if (url && !isDynamicOrDriveUrl(url.toString())) return url.toString();
  }
  return "";
}

function looksLikeImage(bytes, declaredType = "") {
  const type = String(declaredType || "").split(";")[0].trim().toLowerCase();
  if (!type.startsWith("image/")) return false;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return true;
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(String.fromCharCode(...bytes.slice(0, 6)))) return true;
  return type === "image/svg+xml" && bytes.length >= 32;
}

async function preflightImage(url, { fetchImpl, timeoutMs, maxBytes }) {
  const startedAt = Date.now();
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/*" },
  });
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  if (declaredLength > maxBytes) throw new Error("IMAGE_TOO_LARGE");
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.length < 32) throw new Error("IMAGE_TOO_SMALL");
  if (buffer.length > maxBytes) throw new Error("IMAGE_TOO_LARGE");
  const contentType = response.headers.get("content-type") || "";
  if (!looksLikeImage(buffer, contentType)) throw new Error(`NOT_IMAGE:${contentType || "unknown"}`);
  return { url, bytes: buffer.length, content_type: contentType, duration_ms: Date.now() - startedAt };
}

export async function prepareCarouselAssets(assets, options = {}) {
  const input = (Array.isArray(assets) ? assets : []).slice(0, 10);
  if (!input.length) throw new Error("CAROUSEL_ASSETS_EMPTY");
  const lookupStorageAssets = typeof options.lookupStorageAssets === "function" ? options.lookupStorageAssets : null;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Math.max(3000, Math.min(30000, Number(options.timeoutMs || 15000)));
  const maxBytes = Math.max(1024, Math.min(MAX_IMAGE_BYTES, Number(options.maxBytes || MAX_IMAGE_BYTES)));
  if (typeof fetchImpl !== "function") throw new Error("CAROUSEL_FETCH_MISSING");

  const fileIds = [...new Set(input.map((asset) => driveFileId(asset.source_url || asset.delivery_url || asset.file_url)).filter(Boolean))];
  const rows = lookupStorageAssets && fileIds.length ? await lookupStorageAssets(fileIds) : [];
  const storageByFileId = new Map((Array.isArray(rows) ? rows : []).map((row) => [String(row.drive_file_id || ""), row]));

  const candidates = input.map((asset, index) => {
    const fileId = driveFileId(asset.source_url || asset.delivery_url || asset.file_url);
    const imageUrl = staticCarouselUrl(asset, fileId ? storageByFileId.get(fileId) : null);
    return { asset, index, fileId, imageUrl };
  });
  const unresolved = candidates.filter((item) => !item.imageUrl);
  if (unresolved.length) {
    const positions = unresolved.map((item) => item.index + 1).join(",");
    throw new Error(`CAROUSEL_STATIC_URL_MISSING:${positions}`);
  }

  const checks = await Promise.allSettled(candidates.map((item) => preflightImage(item.imageUrl, { fetchImpl, timeoutMs, maxBytes })));
  const failures = checks.flatMap((result, index) => result.status === "rejected"
    ? [{ position: index + 1, error: String(result.reason?.message || result.reason).slice(0, 180) }]
    : []);
  if (failures.length) {
    const error = new Error(`CAROUSEL_PREFLIGHT_FAILED:${failures.map((item) => `${item.position}:${item.error}`).join("|")}`);
    error.failures = failures;
    throw error;
  }

  return candidates.map((item, index) => ({
    ...item.asset,
    source_url: item.imageUrl,
    carousel_preflight: checks[index].value,
  }));
}

