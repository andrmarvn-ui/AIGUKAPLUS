import fs from "node:fs";

await import("./patch-ai-provider-page-server-render.js");

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

console.log("[AIGUKA] AI Context navigation installed");
