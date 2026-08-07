import fs from "node:fs";
import { spawnSync } from "node:child_process";

const marker = "AIGUKA_PAGE_SUPPORT_AICAKE_PRIMARY_UI_V2";

function replaceBetween(source, startToken, endToken, replacement, label) {
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken, start + startToken.length);
  if (start < 0 || end < 0) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  return source.slice(0, start) + replacement + source.slice(end);
}

// The page-mode save patch runs before this file and intentionally owns persistence.
// Here we only add SUPPORT to its whitelist and make the UI describe the effective
// AICake-primary/AIGUKA-media-support behavior accurately.
const serverFile = "bot-control-ui.js";
let server = fs.readFileSync(serverFile, "utf8");
const whitelistOld = 'if (!["OFF", "OBSERVE", "TEST", "PRODUCTION"].includes(mode)) throw new Error("CHE_DO_PAGE_KHONG_HOP_LE");';
const whitelistNew = 'if (!["OFF", "OBSERVE", "TEST", "SUPPORT", "PRODUCTION"].includes(mode)) throw new Error("CHE_DO_PAGE_KHONG_HOP_LE");';
if (server.includes(whitelistOld)) server = server.replace(whitelistOld, whitelistNew);
if (!server.includes(whitelistNew)) throw new Error("PAGE_SUPPORT_SERVER_WHITELIST_NOT_READY");

// The control panel is operational UI; never let an old cached client keep showing
// SUPPORT as the browser's first <select> option (OFF).
const clientRoute = '  app.get("/bot-control-client.js", (_req, res) => {\n    res.type("application/javascript").send(fs.readFileSync(new URL("./bot-control-client.js", import.meta.url), "utf8"));\n  });';
const clientRouteNoCache = '  app.get("/bot-control-client.js", (_req, res) => {\n    res.set("Cache-Control", "no-store, max-age=0");\n    res.type("application/javascript").send(fs.readFileSync(new URL("./bot-control-client.js", import.meta.url), "utf8"));\n  });';
if (server.includes(clientRoute)) server = server.replace(clientRoute, clientRouteNoCache);

const htmlRoute = '  app.get("/bot-control", (_req, res) => {\n    res.type("html").send(fs.readFileSync(new URL("./bot-control.html", import.meta.url), "utf8"));\n  });';
const htmlRouteNoCache = '  app.get("/bot-control", (_req, res) => {\n    res.set("Cache-Control", "no-store, max-age=0");\n    res.type("html").send(fs.readFileSync(new URL("./bot-control.html", import.meta.url), "utf8"));\n  });';
if (server.includes(htmlRoute)) server = server.replace(htmlRoute, htmlRouteNoCache);
fs.writeFileSync(serverFile, server, "utf8");

const clientFile = "bot-control-client.js";
let client = fs.readFileSync(clientFile, "utf8");
if (!client.includes(marker)) {
  const labelsOld = '  TEST: "Chạy thử nghiệm",\n  PRODUCTION: "Hoạt động chính thức",';
  const labelsNew = '  TEST: "Chạy thử nghiệm",\n  SUPPORT: "Hỗ trợ AICake — chỉ slide/ảnh",\n  PRODUCTION: "Hoạt động chính thức",';
  if (client.includes(labelsOld)) client = client.replace(labelsOld, labelsNew);
  if (!client.includes('SUPPORT: "Hỗ trợ AICake — chỉ slide/ảnh"')) throw new Error("PAGE_SUPPORT_CLIENT_LABEL_NOT_READY");

  const optionsOld = `'>Chạy thử nghiệm</option><option value="PRODUCTION" '`;
  const optionsNew = `'>Chạy thử nghiệm</option><option value="SUPPORT" ' + (current === "SUPPORT" ? "selected" : "") + '>Hỗ trợ AICake — chỉ slide/ảnh</option><option value="PRODUCTION" '`;
  if (client.includes(optionsOld)) client = client.replace(optionsOld, optionsNew);
  if (!client.includes('<option value="SUPPORT" ')) throw new Error("PAGE_SUPPORT_CLIENT_OPTION_NOT_READY");

  const guideStart = "function automaticGuideText(features) {";
  const guideEnd = "\n\nfunction customGuideText()";
  const guideReplacement = `function automaticGuideText(features) {
  const names = featureNames(features);
  const supportParts = ["AICake trả lời chính"];
  if (features.slide_enabled) supportParts.push("AIGUKA gửi slide/hình ảnh khi khách có nhu cầu");
  if (features.care_enabled) supportParts.push("Follow-up chạy theo cấu hình riêng");
  return {
    on: names.length
      ? "BOT được dùng: " + names.join(", ") + "."
      : "Chưa có chức năng nào được Admin bật; BOT không gửi nội dung.",
    support: supportParts.join("; ") + ". AIGUKA không tư vấn chữ thường ở chế độ SUPPORT.",
    off: "Không gửi chữ, slide, hình ảnh hoặc tin chăm sóc trong khung giờ này.",
  };
}`;
  client = replaceBetween(client, guideStart, guideEnd, guideReplacement, "PAGE_SUPPORT_GUIDE");

  const renderPagesStart = "function renderPages() {";
  const renderPagesEnd = "\n\nfunction renderPolicy()";
  const renderPagesReplacement = `function effectivePageMode(page) {
  return String(page?.policy?.runtime_mode || page?.bot_mode || "OBSERVE").toUpperCase();
}

function effectivePagePermissions(page) {
  const mode = effectivePageMode(page);
  const config = state?.settings?.support_config || {};
  const runtime = state?.runtime?.value || {};
  if (mode === "SUPPORT") {
    return {
      text: false,
      slide: Boolean(config.slide_enabled ?? runtime.aiguka_can_send_image ?? page?.policy?.can_send_image ?? false),
    };
  }
  return {
    text: Boolean(page?.policy?.can_send_text),
    slide: Boolean(page?.policy?.can_send_image),
  };
}

function renderPages() {
  byId("pages").innerHTML = (state.pages || []).map((page) => {
    const current = String(page.bot_mode || "OBSERVE").toUpperCase();
    const actual = effectivePageMode(page);
    const permissions = effectivePagePermissions(page);
    const supportRole = actual === "SUPPORT"
      ? " · Vai trò: AICake trả lời chính, AIGUKA hỗ trợ slide/ảnh"
      : "";
    return '<div class="page"><div class="page-head"><div><b>' + escapeHtml(page.page_name) + '</b><br><small>' + escapeHtml(page.page_id) + '</small><br><span>Thực tế: <b>' + escapeHtml(pageModeLabel(actual)) + '</b></span></div>'
      + '<div><select id="mode-' + escapeHtml(page.page_id) + '"><option value="OFF" ' + (current === "OFF" ? "selected" : "") + '>Tắt hoàn toàn</option><option value="OBSERVE" ' + (current === "OBSERVE" ? "selected" : "") + '>Chỉ quan sát</option><option value="TEST" ' + (current === "TEST" ? "selected" : "") + '>Chạy thử nghiệm</option><option value="SUPPORT" ' + (current === "SUPPORT" ? "selected" : "") + '>Hỗ trợ AICake — chỉ slide/ảnh</option><option value="PRODUCTION" ' + (["PRODUCTION", "LIVE"].includes(current) ? "selected" : "") + '>Hoạt động chính thức</option></select> <button type="button" data-save-page="' + escapeHtml(page.page_id) + '">Lưu chế độ</button></div></div>'
      + '<div class="safe" style="margin-top:8px">Tư vấn chữ thường: ' + (permissions.text ? "BẬT" : "TẮT") + ' · Slide/hình ảnh: ' + (permissions.slide ? "BẬT" : "TẮT") + supportRole + ' · Kết nối nhận tin: ' + escapeHtml(page.webhook_status || "chưa rõ") + '</div></div>';
  }).join("") || "<div>Chưa có Trang.</div>";
}`;
  client = replaceBetween(client, renderPagesStart, renderPagesEnd, renderPagesReplacement, "PAGE_SUPPORT_RENDER_PAGES");

  const renderPolicyStart = "function renderPolicy() {";
  const renderPolicyEnd = "\n\nasync function loadState()";
  const renderPolicyReplacement = `function renderPolicy() {
  const rows = (state.pages || []).map((page) => {
    const actual = effectivePageMode(page);
    const permissions = effectivePagePermissions(page);
    const role = actual === "SUPPORT" ? " — AICake chính, AIGUKA hỗ trợ media" : "";
    return escapeHtml(page.page_name) + ": " + escapeHtml(pageModeLabel(actual))
      + role
      + " — tư vấn chữ thường " + (permissions.text ? "BẬT" : "TẮT")
      + ", slide/ảnh " + (permissions.slide ? "BẬT" : "TẮT");
  });
  byId("policy").innerHTML = rows.join("<br>") || "Chưa có dữ liệu.";
}`;
  client = replaceBetween(client, renderPolicyStart, renderPolicyEnd, renderPolicyReplacement, "PAGE_SUPPORT_RENDER_POLICY");

  const featureSummaryAnchor = '  byId("feature-care").checked = Boolean(config.care_enabled ?? runtime.care_enabled ?? false);\n  updateFeatureGuide();';
  const featureSummaryReplacement = '  byId("feature-care").checked = Boolean(config.care_enabled ?? runtime.care_enabled ?? false);\n  const summary = document.querySelector(".feature-summary");\n  const supportPages = (state.pages || []).filter((page) => effectivePageMode(page) === "SUPPORT").length;\n  if (summary) summary.textContent = supportPages\n    ? "Đây là quyền chức năng chung. " + supportPages + " Page đang SUPPORT nên AIGUKA không tư vấn chữ thường; slide/ảnh vẫn hoạt động theo quyền bên dưới."\n    : "Đây là quyền chức năng chung; chế độ từng Trang quyết định quyền thực tế.";\n  updateFeatureGuide();';
  if (!client.includes(featureSummaryAnchor)) throw new Error("PAGE_SUPPORT_FEATURE_SUMMARY_ANCHOR_NOT_FOUND");
  client = client.replace(featureSummaryAnchor, featureSummaryReplacement);

  const oldSupportStatus = 'setStatus(mode === "SUPPORT" ? "Đã lưu Hỗ trợ Sale: gửi slide khi khách xin mẫu; trả lời chữ sau thời gian chờ nếu Sale chưa phản hồi." : "Đã cập nhật chế độ Trang");';
  const newSupportStatus = 'setStatus(mode === "SUPPORT" ? "Đã lưu Hỗ trợ AICake: AICake trả lời chính; AIGUKA chỉ hỗ trợ slide/ảnh." : "Đã cập nhật chế độ Trang");';
  if (client.includes(oldSupportStatus)) client = client.replace(oldSupportStatus, newSupportStatus);

  const patchedStatusOld = '      : (mode === "SUPPORT" ? "Đã lưu Hỗ trợ Sale: slide theo yêu cầu, chữ tiếp quản sau thời gian chờ." : "Đã lưu và cập nhật chế độ Trang"));';
  const patchedStatusNew = '      : (mode === "SUPPORT" ? "Đã lưu Hỗ trợ AICake: AICake trả lời chính; AIGUKA chỉ hỗ trợ slide/ảnh." : "Đã lưu và cập nhật chế độ Trang"));';
  if (client.includes(patchedStatusOld)) client = client.replace(patchedStatusOld, patchedStatusNew);

  client = client.replace("loadState();", `// ${marker}\nloadState();`);
  fs.writeFileSync(clientFile, client, "utf8");
}

const htmlFile = "bot-control.html";
let html = fs.readFileSync(htmlFile, "utf8");
html = html.replace(
  '<div class="feature-summary">Bật/tắt độc lập, không phụ thuộc lịch Sale.</div>',
  '<div class="feature-summary">Đây là quyền tối đa; chế độ từng Trang quyết định quyền thực tế.</div>',
);
html = html.replace(
  '<b>Trả lời tư vấn</b><br><small>BOT được gửi nội dung chữ</small>',
  '<b>Trả lời tư vấn</b><br><small>Chỉ có hiệu lực khi chế độ Trang cho phép; SUPPORT không gửi tư vấn chữ thường</small>',
);
html = html.replace('/bot-control-client.js"', '/bot-control-client.js?v=20260808-support-ui-v2"');
fs.writeFileSync(htmlFile, html, "utf8");

for (const file of [serverFile, clientFile]) {
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`PAGE_SUPPORT_SYNTAX_${file}:${syntax.stderr || syntax.stdout}`);
}

console.log("[AIGUKA] SUPPORT control UI aligned: AICake is primary, AIGUKA media support is explicit, stale cached OFF display is prevented");
