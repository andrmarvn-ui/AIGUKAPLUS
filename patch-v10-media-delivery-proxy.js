import fs from "node:fs";
import { spawnSync } from "node:child_process";

const OUTBOUND = "v10-outbound-worker.js";
const FOLLOWUP = "v10-followup-worker.js";
const MARK = "AIGUKA_V10_MEDIA_DELIVERY_PROXY_V1";

function patchFile(file, apply) {
  if (!fs.existsSync(file)) throw new Error(`V10_MEDIA_PROXY_FILE_MISSING:${file}`);
  let source = fs.readFileSync(file, "utf8");
  if (source.includes(MARK)) return;
  source = apply(source);
  source += `\n// ${MARK}\n`;
  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`V10_MEDIA_PROXY_SYNTAX:${file}:${syntax.stderr || syntax.stdout}`);
}

const helper = String.raw`
function v10DriveFileId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    const queryId = String(url.searchParams.get("id") || "").trim();
    if (queryId) return queryId;
    const match = url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,200})/);
    return match?.[1] || "";
  } catch {
    const match = text.match(/(?:[?&]id=|\/file\/d\/)([A-Za-z0-9_-]{10,200})/);
    return match?.[1] || "";
  }
}

function v10MessengerImageUrl(value) {
  const sourceUrl = String(value || "").trim();
  const fileId = v10DriveFileId(sourceUrl);
  if (!fileId) return sourceUrl;
  const configured = String(process.env.AIGUKA_DRIVE_IMAGE_PROXY_BASE || "").trim().replace(/\/$/, "");
  const supabase = String(process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const endpoint = configured || (supabase ? supabase + "/functions/v1/aiguka-drive-image-proxy" : "");
  return endpoint ? endpoint + "?file_id=" + encodeURIComponent(fileId) : sourceUrl;
}
`;

patchFile(OUTBOUND, (source) => {
  const anchor = "async function sendCarousel(pageId, recipientId, assets, salutation = null) {";
  if (!source.includes(anchor)) throw new Error("V10_MEDIA_PROXY_OUTBOUND_CAROUSEL_ANCHOR_MISSING");
  source = source.replace(anchor, helper + "\n" + anchor);
  const imageAnchor = "image_url: asset.source_url,";
  if (!source.includes(imageAnchor)) throw new Error("V10_MEDIA_PROXY_OUTBOUND_IMAGE_URL_ANCHOR_MISSING");
  source = source.replace(imageAnchor, "image_url: v10MessengerImageUrl(asset.source_url),");
  source = source.replace(/const VERSION = "v10_outbound_[^"]+";/, 'const VERSION = "v10_outbound_aicake_primary_support_v10_media_proxy";');
  return source;
});

patchFile(FOLLOWUP, (source) => {
  const anchor = "async function sendImage(pageId, senderId, imageUrl) {";
  if (!source.includes(anchor)) throw new Error("V10_MEDIA_PROXY_FOLLOWUP_IMAGE_ANCHOR_MISSING");
  source = source.replace(anchor, helper + "\n" + anchor);
  const urlAnchor = "payload: { url: imageUrl, is_reusable: true }";
  if (!source.includes(urlAnchor)) throw new Error("V10_MEDIA_PROXY_FOLLOWUP_URL_ANCHOR_MISSING");
  source = source.replace(urlAnchor, "payload: { url: v10MessengerImageUrl(imageUrl), is_reusable: true }");
  source = source.replace(/const VERSION = "v10_followup_[^"]+";/, 'const VERSION = "v10_followup_v8_event_v4_media_proxy";');
  return source;
});

console.log("[AIGUKA V10] Messenger media proxy enabled: Drive images are served through the verified Supabase image endpoint for live carousels and follow-up images");
