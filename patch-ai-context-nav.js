import fs from "node:fs";
import { spawnSync } from "node:child_process";

await import("./patch-cohere-provider-compat.js");

// AI provider management is owned by ai-provider-manager.js.
// Do not import the old server-render hotfix here: it replaces the CRUD page
// with a read-only status page and removes add/edit/delete/activation controls.
// Repair the inline admin script before server-fixed.js imports the manager.
// The missing statement terminator made the browser stop parsing at testKey(),
// so the page rendered but every interactive control was dead.
const providerManagerFile = "ai-provider-manager.js";
if (fs.existsSync(providerManagerFile)) {
  let providerManager = fs.readFileSync(providerManagerFile, "utf8");
  const brokenAdminScript = "alert('Provider đã vượt qua tool-call test và được cập nhật.')}async function testKey";
  const fixedAdminScript = "alert('Provider đã vượt qua tool-call test và được cập nhật.')};async function testKey";
  if (providerManager.includes(brokenAdminScript)) {
    providerManager = providerManager.replace(brokenAdminScript, fixedAdminScript);
    fs.writeFileSync(providerManagerFile, providerManager, "utf8");
    console.log("[AIGUKA] AI provider admin JavaScript syntax repaired");
  }
}

const learningFile = "learning-admin-v2.html";
let learning = fs.readFileSync(learningFile, "utf8");
if (!learning.includes("AIGUKA_AI_CONTEXT_TAB_V1")) {
  learning = learning.replace(
    ".tabs button.active{background:#2563eb;color:#fff;border-color:#2563eb}",
    ".tabs button.active{background:#2563eb;color:#fff;border-color:#2563eb}.tabs .context-tab-link{padding:10px 14px;border:1px solid #cbd5e1;border-radius:9px;background:#fff;color:#172033;text-decoration:none;display:inline-flex;align-items:center;font-weight:700}.tabs .context-tab-link:hover{border-color:#2563eb;color:#155eef}/* AIGUKA_AI_CONTEXT_TAB_V1 */",
  );
  learning = learning.replace(
    '<div class="tabs"><button id="tab-conv" class="active" onclick="showView(\'conversations\')">Hội thoại & sửa câu trả lời</button><button id="tab-prompt" onclick="showView(\'prompts\')">Prompt, nhánh học & mẫu trả lời</button></div>',
    '<div class="tabs"><button id="tab-conv" class="active" onclick="showView(\'conversations\')">Hội thoại & sửa câu trả lời</button><a class="context-tab-link" href="/ai-contexts">Ngữ cảnh AI</a><button id="tab-prompt" onclick="showView(\'prompts\')">Prompt, nhánh học & mẫu trả lời</button></div>',
  );
  fs.writeFileSync(learningFile, learning, "utf8");
}

const dashboardFile = "v7-dashboard-stable.js";
if (fs.existsSync(dashboardFile)) {
  let dashboard = fs.readFileSync(dashboardFile, "utf8");
  const learningNav = "${nav('/v8-learning','AI Học & Quản lý Prompt','learning')}";
  const contextNav = "${nav('/ai-contexts','🧠 Ngữ cảnh AI','ai-contexts')}";
  if (dashboard.includes(learningNav) && !dashboard.includes(contextNav)) {
    dashboard = dashboard.replace(learningNav, learningNav + contextNav);
    fs.writeFileSync(dashboardFile, dashboard, "utf8");
  }
}

// AIGUKA_FOLLOWUP_ADMIN_V8_EVENT_V1
// Install the dedicated Follow-up admin routes through the existing Bot Control
// feature module before server-v10-final imports it. This keeps one Express app,
// one Core connection and one official administration surface.
const botControlUiFile = "bot-control-ui.js";
if (fs.existsSync(botControlUiFile)) {
  let botControlUi = fs.readFileSync(botControlUiFile, "utf8");
  if (!botControlUi.includes("AIGUKA_FOLLOWUP_ADMIN_V8_EVENT_V1")) {
    const importAnchor = 'import fs from "node:fs";';
    const functionAnchor = "export function installBotControlUi(app, options) {";
    if (!botControlUi.includes(importAnchor) || !botControlUi.includes(functionAnchor)) {
      throw new Error("FOLLOWUP_ADMIN_BOT_CONTROL_ANCHOR_MISSING");
    }
    botControlUi = botControlUi
      .replace(importAnchor, `${importAnchor}\nimport { installFollowupAdminV8 } from "./followup-admin-v8.js";`)
      .replace(functionAnchor, `${functionAnchor}\n  installFollowupAdminV8(app); // AIGUKA_FOLLOWUP_ADMIN_V8_EVENT_V1`);
    fs.writeFileSync(botControlUiFile, botControlUi, "utf8");
    const syntax = spawnSync(process.execPath, ["--check", botControlUiFile], { encoding: "utf8" });
    if (syntax.status !== 0) throw new Error(`FOLLOWUP_ADMIN_BOT_CONTROL_SYNTAX:${syntax.stderr || syntax.stdout}`);
  }
}

const v10AdminShellFile = "dashboard-v10-admin-shell.js";
if (fs.existsSync(v10AdminShellFile)) {
  let adminShell = fs.readFileSync(v10AdminShellFile, "utf8");
  adminShell = adminShell
    .replace('href: "/bot-control#follow-up",', 'href: "/follow-up-admin",')
    .replace('description: "Bật và theo dõi chăm sóc lại khách đã được trả lời nhưng im lặng ban ngày hoặc buổi tối.",', 'description: "Mặc định V8 hoặc Event; lịch 3 giờ, tối đa 2 lượt/20 giờ, hỗ trợ ảnh và tag Pancake.",');
  fs.writeFileSync(v10AdminShellFile, adminShell, "utf8");
}

console.log("[AIGUKA] AI Context and V8/Event Follow-up administration installed");
