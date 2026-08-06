import { __private__ as reportDashboard } from "./dashboard-v10-stable.js";
import { enhanceSmartLeadUi } from "./dashboard-smart-lead-ui.js";

const ADMIN_LINKS = Object.freeze([
  {
    href: "/admin-v8",
    label: "Tổng quan quản trị",
    description: "Trang quản trị tổng hợp và các chức năng hệ thống cũ.",
  },
  {
    href: "/bot-control",
    label: "Điều khiển BOT & lịch",
    description: "Bật, tắt, hỗ trợ, lịch làm việc và quyền gửi tin/slide.",
  },
  {
    href: "/learning-reviewed",
    label: "Quản trị AI & Prompt",
    description: "Hội thoại, chỉnh câu trả lời, prompt và nhánh học có kiểm duyệt.",
  },
  {
    href: "/ai-contexts",
    label: "Ngữ cảnh AI",
    description: "Quản lý ngữ cảnh, kiến thức và nội dung cố vấn cho AI.",
  },
  {
    href: "/ai-providers",
    label: "AI Providers",
    description: "API key, mô hình, trạng thái kết nối và thứ tự nhà cung cấp AI.",
  },
  {
    href: "/drive-slides",
    label: "Mapping & Test Slide",
    description: "Mapping quảng cáo, catalog, Google Drive và kiểm tra slide.",
  },
]);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]));
}

function adminStripHtml() {
  return `<nav class="aiguka-admin-strip" aria-label="Chức năng quản trị">
  <span class="aiguka-admin-strip__label">QUẢN TRỊ</span>
  ${ADMIN_LINKS.map((item) => `<a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`).join("\n  ")}
</nav>`;
}

function adminShellStyles() {
  return `<style id="aiguka-v10-admin-navigation-style">
.aiguka-admin-strip{display:flex;align-items:center;gap:8px;padding:8px 18px;background:#172033;border-bottom:1px solid #344054;overflow-x:auto;white-space:nowrap;position:sticky;top:58px;z-index:19;scrollbar-width:thin}
.aiguka-admin-strip__label{font:800 11px Inter,Arial,sans-serif;letter-spacing:.08em;color:#98a2b3;margin-right:2px}
.aiguka-admin-strip a{display:inline-flex;align-items:center;min-height:32px;padding:6px 10px;border:1px solid #475467;border-radius:7px;background:#24324a;color:#fff;text-decoration:none;font:700 12px Inter,Arial,sans-serif}
.aiguka-admin-strip a:hover,.aiguka-admin-strip a:focus{background:#155eef;border-color:#84adff;outline:none}
@media(max-width:760px){.aiguka-admin-strip{padding:7px 8px;top:58px}.aiguka-admin-strip a{font-size:11px;padding:6px 8px}}
</style>`;
}

export function enhanceV10DashboardHtml(html) {
  const source = String(html || "");
  if (source.includes("aiguka-v10-admin-navigation-style")) return enhanceSmartLeadUi(source);
  if (!source.includes("</head>") || !source.includes("</header>")) {
    throw new Error("V10_DASHBOARD_ADMIN_NAVIGATION_ANCHOR_MISSING");
  }
  const withAdmin = source
    .replace("</head>", `${adminShellStyles()}</head>`)
    .replace("</header>", `</header>\n${adminStripHtml()}`);
  return enhanceSmartLeadUi(withAdmin);
}

function adminHubHtml() {
  const cards = ADMIN_LINKS.map((item) => `<a class="card" href="${escapeHtml(item.href)}">
    <strong>${escapeHtml(item.label)}</strong>
    <span>${escapeHtml(item.description)}</span>
  </a>`).join("\n");
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIGUKA · Trung tâm quản trị</title>
<style>
:root{font-family:Inter,Arial,sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0}.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 20px;background:#fff;border-bottom:1px solid #d8e0ec}.top h1{font-size:20px;margin:0}.back{padding:9px 12px;border:1px solid #cbd5e1;border-radius:8px;color:#24324a;text-decoration:none;font-weight:750}.wrap{max-width:1150px;margin:0 auto;padding:22px}.intro{margin:0 0 16px;color:#475467}.grid{display:grid;grid-template-columns:repeat(3,minmax(220px,1fr));gap:14px}.card{display:flex;min-height:130px;flex-direction:column;gap:9px;padding:18px;border:1px solid #d7dfeb;border-radius:12px;background:#fff;text-decoration:none;color:#172033;box-shadow:0 1px 2px #0f172a0a}.card:hover{border-color:#155eef;box-shadow:0 8px 22px #155eef18}.card strong{font-size:17px}.card span{font-size:13px;line-height:1.5;color:#667085}@media(max-width:850px){.grid{grid-template-columns:repeat(2,minmax(200px,1fr))}}@media(max-width:560px){.grid{grid-template-columns:1fr}.wrap{padding:12px}}
</style></head><body><header class="top"><h1>AIGUKA · Trung tâm quản trị</h1><a class="back" href="/dashboard">← Báo cáo V10</a></header><main class="wrap"><p class="intro">Các chức năng quản trị được giữ độc lập với dashboard báo cáo, không bị dashboard mới thay thế.</p><section class="grid">${cards}</section></main></body></html>`;
}

function sendHtml(res, html) {
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.status(200).send(html);
}

export function installV10AdminDashboard(app) {
  const dashboardHtml = enhanceV10DashboardHtml(reportDashboard.dashboardHtml());
  const sendDashboard = (_req, res) => sendHtml(res, dashboardHtml);
  app.get("/", sendDashboard);
  app.get("/dashboard", sendDashboard);
  app.get("/admin", (_req, res) => sendHtml(res, adminHubHtml()));
}

export const __private__ = { ADMIN_LINKS, adminHubHtml, adminStripHtml };
