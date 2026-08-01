import fs from "node:fs";
import { spawnSync } from "node:child_process";

const MARKER = "AIGUKA_V9_SUPPORT_SLIDE_20_30_V1";
const DEFAULT_CAPTION = "Dạ em gửi anh/chị trước một vài mẫu bán chạy để mình tham khảo ạ. Bên em còn nhiều mẫu khác theo từng kiểu dáng và mức giá. Anh/chị để lại SĐT hoặc Zalo, bên em tư vấn cụ thể hơn và gửi thêm đúng mẫu theo nhu cầu của mình nhé.";

function syntaxCheck(file) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`SUPPORT_LARGE_SLIDE_SYNTAX_${file}:${result.stderr || result.stdout}`);
}

function replaceBetween(source, startAnchor, endAnchor, replacement, label) {
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  if (start < 0 || end < 0) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  return source.slice(0, start) + replacement + source.slice(end);
}

// Media authority may select up to 30 exact, AI-authorized assets. It still fails closed
// when the requested catalog has no real images and never crosses into another catalog.
{
  const file = "v9/core/media-authority.js";
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(MARKER)) {
    if (!source.includes("const MAX_MEDIA_ASSETS = 10;")) {
      throw new Error("SUPPORT_LARGE_SLIDE_MEDIA_LIMIT_ANCHOR_NOT_FOUND");
    }
    source = source.replace(
      "const MAX_MEDIA_ASSETS = 10;",
      `const MAX_MEDIA_ASSETS = 30; // ${MARKER}`,
    );
    fs.writeFileSync(file, source);
  }
}

// Standardize the SUPPORT caption. The customer must understand that these are only
// a few best-selling samples and that more models are available after leaving contact.
{
  const file = "v9-ai-shadow-worker.js";
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(MARKER)) {
    const oldGeneric = "Em gửi anh/chị vài mẫu tham khảo ạ. Anh/chị cho em xin SĐT hoặc Zalo để bên em tư vấn kỹ hơn và gửi đúng mẫu theo nhu cầu của mình nhé.";
    if (!source.includes(oldGeneric)) throw new Error("SUPPORT_LARGE_SLIDE_CAPTION_ANCHOR_NOT_FOUND");
    source = source.split(oldGeneric).join(DEFAULT_CAPTION);

    const oldImageMatched = "Dạ em đã xem ảnh, mẫu này thuộc nhóm ${labels.join(\", \")}; anh/chị cho em xin SĐT hoặc Zalo để bên em tư vấn chính xác và gửi thêm mẫu phù hợp nhé.";
    const newImageMatched = "Dạ em đã xem ảnh anh/chị gửi và gửi trước một vài mẫu bán chạy thuộc nhóm ${labels.join(\", \")} để mình tham khảo ạ. Bên em còn nhiều mẫu khác. Anh/chị để lại SĐT hoặc Zalo, bên em tư vấn cụ thể hơn và gửi thêm đúng mẫu theo nhu cầu nhé.";
    if (source.includes(oldImageMatched)) source = source.replace(oldImageMatched, newImageMatched);

    const oldImageUnresolved = "Dạ em đã xem ảnh mẫu anh/chị gửi; anh/chị cho em xin SĐT hoặc Zalo để bên em xác định đúng sản phẩm, tư vấn chính xác và gửi mẫu phù hợp nhé.";
    const newImageUnresolved = "Dạ em đã xem ảnh anh/chị gửi. Anh/chị để lại SĐT hoặc Zalo để bên em xác định đúng sản phẩm, tư vấn cụ thể và gửi thêm các mẫu phù hợp nhé.";
    if (source.includes(oldImageUnresolved)) source = source.replace(oldImageUnresolved, newImageUnresolved);

    source = source.replace(/const VERSION = "[^"]+";/, 'const VERSION = "v9_ai_support_large_slide_v7";');
    source += `\n// ${MARKER}: SUPPORT caption and 20-30 image policy installed.\n`;
    fs.writeFileSync(file, source);
  }
}

// Messenger generic templates carry at most ten elements per message. Send the selected
// 20-30 assets as two or three sequential carousels, then send the single SUPPORT caption.
{
  const file = "v9-live-outbound-worker.js";
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(MARKER)) {
    if (!source.includes("maxAssets: 10,")) throw new Error("SUPPORT_LARGE_SLIDE_RESOLVER_LIMIT_ANCHOR_NOT_FOUND");
    source = source.replace("maxAssets: 10,", "maxAssets: 30,");

    const sendCarousel = `async function sendCarousel(pageId, senderId, assets) {\n  const token = await pageToken(pageId);\n  if (!token) throw new Error(\`PAGE_ACCESS_TOKEN_NOT_FOUND:\${pageId}\`);\n\n  const selected = (Array.isArray(assets) ? assets : []).slice(0, 30);\n  if (!selected.length) return null;\n\n  const results = [];\n  for (let offset = 0; offset < selected.length; offset += 10) {\n    const elements = selected.slice(offset, offset + 10).map((asset, index) => ({\n      title: \`\${asset.title || "Mẫu sản phẩm"} \${offset + index + 1}\`.slice(0, 80),\n      image_url: asset.source_url,\n    }));\n    const result = await graph(\`\${pageId}/messages\`, token, {\n      method: "POST",\n      body: {\n        recipient: { id: String(senderId) },\n        messaging_type: "RESPONSE",\n        message: { attachment: { type: "template", payload: { template_type: "generic", elements } } },\n      },\n    });\n    results.push(result);\n  }\n\n  return {\n    message_id: results.at(-1)?.message_id || null,\n    message_ids: results.map((item) => item?.message_id).filter(Boolean),\n    batch_count: results.length,\n    asset_count: selected.length,\n    results,\n    policy: "support_20_30_images",\n  }; // ${MARKER}\n}\n\n`;
    source = replaceBetween(
      source,
      "async function sendCarousel(pageId, senderId, assets) {",
      "async function patchDecision(decision, status, details = {}) {",
      sendCarousel,
      "SUPPORT_LARGE_SLIDE_CAROUSEL",
    );

    source = source.replace(/const VERSION = "[^"]+";/, 'const VERSION = "v9_live_outbound_support_large_slide_v4";');
    source = source.replace(
      '      media_authority: "decision_products_only",',
      '      media_authority: "decision_products_only",\n      support_slide_assets: "20-30",\n      support_slide_batches: "2-3 carousels when enough assets",',
    );
    fs.writeFileSync(file, source);
  }
}

for (const file of ["v9/core/media-authority.js", "v9-ai-shadow-worker.js", "v9-live-outbound-worker.js"]) {
  syntaxCheck(file);
}

console.log(`[AIGUKA V9] ${MARKER} installed: SUPPORT sends up to 30 exact images in 10-image carousel batches with best-seller contact caption`);
