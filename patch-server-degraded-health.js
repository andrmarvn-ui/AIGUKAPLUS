import fs from "node:fs";
import { spawnSync } from "node:child_process";
await import("./ensure-degraded-dashboard-stub.js");

const file = "server-fixed.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_DEGRADED_HEALTH_V1";

if (source.includes(marker)) {
  console.log("[AIGUKA] Degraded health fallback already installed");
} else {
  source = source.replace(
    'signal: AbortSignal.timeout(30_000),',
    'signal: AbortSignal.timeout(2_500),',
  );

  const helperAnchor = "async function serveSupabasePage(slug, res) {";
  const helper = `function degradedPage(slug, reason) {
  const safeReason = String(reason || "Supabase đang quá tải").replace(/[<>&\"]/g, "");
  return '<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AIGUKA đang phục hồi</title><style>body{font-family:Arial,sans-serif;background:#f8fafc;color:#172b4d;margin:0;display:grid;place-items:center;min-height:100vh}.box{max-width:620px;margin:24px;padding:28px;border-radius:18px;background:#fff;box-shadow:0 18px 50px rgba(15,23,42,.12)}h1{font-size:24px;margin:0 0 14px}p{line-height:1.55}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#f79009;margin-right:8px}.small{font-size:13px;color:#667085}</style></head><body><main class="box"><h1><span class="dot"></span>AIGUKA đang tự phục hồi kết nối dữ liệu</h1><p>Máy chủ quản trị vẫn hoạt động. Các tác vụ nền đã được giảm tải để ưu tiên nhận và trả lời tin nhắn khách.</p><p class="small">Trang: '+slug+'<br>Lý do: '+safeReason+'<br>Hệ thống sẽ tự kết nối lại; tải lại trang sau ít phút.</p></main></body></html>';
}

${helperAnchor}`;
  if (!source.includes(helperAnchor)) {
    throw new Error("DEGRADED_HEALTH_SERVE_ANCHOR_NOT_FOUND");
  }
  source = source.replace(helperAnchor, helper);

  const upstreamFailure = `if (!page.ok) {
    res.status(page.status).type("text/plain").send(\`Không tải được giao diện \${slug}: HTTP \${page.status}\\n\${page.original}\`);
    return;
  }`;
  const upstreamFallback = `if (!page.ok) {
    res.status(200).type("html").send(degradedPage(slug, \`Supabase HTTP \${page.status}\`));
    return;
  }`;
  if (!source.includes(upstreamFailure)) {
    throw new Error("DEGRADED_HEALTH_UPSTREAM_ANCHOR_NOT_FOUND");
  }
  source = source.replace(upstreamFailure, upstreamFallback);

  const routeFailure = `console.error(\`[AIGUKA page \${slug}]\`, error);
      res.status(502).type("text/plain").send(\`Không tải được giao diện AIGUKA: \${error instanceof Error ? error.message : String(error)}\`);`;
  const routeFallback = `const message=error instanceof Error ? error.message : String(error);
      console.error(\`[AIGUKA page \${slug}]\`, message);
      res.status(200).type("html").send(degradedPage(slug,message));`;
  if (!source.includes(routeFailure)) {
    throw new Error("DEGRADED_HEALTH_ROUTE_ANCHOR_NOT_FOUND");
  }
  source = source.replace(routeFailure, routeFallback);

  source = source.replace(
    'version: "1.0.3-test-no-browser-key",',
    'version: "1.0.4-realtime-degraded-health",',
  );
  source = `${source}\n// ${marker}\n`;
  fs.writeFileSync(file, source, "utf8");

  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) {
    throw new Error(`DEGRADED_HEALTH_SYNTAX:${syntax.stderr || syntax.stdout}`);
  }
  console.log("[AIGUKA] Railway root health is independent from Supabase availability");
}
