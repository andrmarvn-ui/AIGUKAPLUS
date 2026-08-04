import fs from "node:fs";

const file = "ai-provider-manager.js";
if (!fs.existsSync(file)) throw new Error("AI_PROVIDER_MANAGER_NOT_FOUND");
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_AI_PROVIDER_SERVER_RENDER_V1";

if (!source.includes(marker)) {
  const replacement = String.raw`
  app.post("/ai-providers-action/test/:key", async (req, res) => {
    try {
      const row = await findOne(req.params.key);
      if (!row?.api_key_ciphertext) throw new Error("Chưa nhập API key");
      await verifyAndPersist(row);
      res.redirect(303, "/ai-providers?tested=" + encodeURIComponent(req.params.key));
    } catch (error) {
      res.redirect(303, "/ai-providers?error=" + encodeURIComponent(safeError(error)));
    }
  });

  app.get("/ai-providers", async (req, res) => {
    let rows = [];
    let pageError = trim(req.query?.error);
    try {
      const data = await rest("v8_ai_providers?select=*&order=provider_name.asc");
      rows = (data || []).map(publicRow).sort((a, b) => a.runtime_order - b.runtime_order || a.provider_name.localeCompare(b.provider_name));
    } catch (error) {
      pageError = safeError(error);
    }

    const cards = rows.map((x) => {
      const smoke = x.smoke_test || {};
      const badgeClass = x.production_ready ? "ok" : x.connection_status === "error" ? "bad" : "warn";
      const badgeText = x.production_ready ? "Production Ready" : x.connection_status === "error" ? "Error" : "Chưa kiểm thử thật";
      return '<section class="card"><div class="head"><div><h2>' + esc(x.provider_name) + '</h2><div class="muted">' + esc(x.provider_key) + '</div></div><span class="badge ' + badgeClass + '">' + badgeText + '</span></div>' +
        '<div class="facts"><div class="fact"><b>Priority</b><br>' + esc(x.runtime_order) + '</div><div class="fact"><b>Mode</b><br>' + esc(x.mode) + '</div><div class="fact"><b>Model</b><br>' + esc(x.model_name || '-') + '</div><div class="fact"><b>Endpoint</b><br>' + esc(x.endpoint_style || '-') + '</div><div class="fact"><b>Tool call</b><br>' + (smoke.tool_call ? '✓ OK' : '✗ Chưa đạt') + '</div><div class="fact"><b>Latency</b><br>' + esc(smoke.latency_ms ? Math.round(smoke.latency_ms) + ' ms' : '-') + '</div></div>' +
        '<div class="muted meta">Key: ' + esc(x.has_api_key ? x.api_key_hint : 'Chưa nhập') + ' · Lần test: ' + esc(smoke.tested_at ? new Date(smoke.tested_at).toLocaleString('vi-VN') : 'Chưa có') + '</div>' +
        (x.last_error ? '<div class="error">' + esc(x.last_error) + '</div>' : '') +
        '<div class="actions"><form method="post" action="/ai-providers-action/test/' + encodeURIComponent(x.provider_key) + '"><button class="btn primary" type="submit">Test thật</button></form><a class="btn" href="/api/ai-providers">Xem JSON</a></div></section>';
    }).join("") || '<section class="card"><b>Không tải được provider.</b><div class="muted">Backend trả 0 bản ghi.</div></section>';

    const notice = pageError ? '<div class="notice errorbox">' + esc(pageError) + '</div>' : trim(req.query?.tested) ? '<div class="notice successbox">Đã test provider ' + esc(req.query.tested) + '.</div>' : '';
    res.type("html").send('<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trung tâm nhà cung cấp AI</title><style>body{margin:0;background:#f4f7fb;color:#101828;font:14px Arial}.wrap{max-width:1320px;margin:auto;padding:24px}.top,.head,.actions{display:flex;align-items:center;gap:10px}.top,.head{justify-content:space-between}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.card{background:#fff;border:1px solid #d0d5dd;border-radius:12px;padding:16px}.card h2{margin:0}.btn{display:inline-block;border:1px solid #b8c5d6;border-radius:7px;padding:9px 13px;background:#fff;color:#101828;text-decoration:none;cursor:pointer}.primary{background:#155eef;color:#fff;border-color:#155eef}.badge{padding:5px 9px;border-radius:999px}.ok{background:#d1fadf;color:#05603a}.bad{background:#fee4e2;color:#b42318}.warn{background:#fef0c7;color:#b54708}.facts{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.fact{border:1px solid #e4e7ec;border-radius:8px;padding:9px;background:#f9fafb}.muted{color:#667085}.meta,.actions{margin-top:12px}.error{color:#b42318;margin-top:10px}.notice{padding:12px;border-radius:8px;margin:12px 0}.errorbox{background:#fef3f2;border:1px solid #fecdca;color:#b42318}.successbox{background:#ecfdf3;border:1px solid #abefc6;color:#05603a}.intro{background:#eaf4ff;border:1px solid #84caff;padding:12px;border-radius:8px;margin:14px 0}@media(max-width:850px){.grid,.facts{grid-template-columns:1fr}}</style></head><body><main class="wrap"><div class="top"><div><h1>Trung tâm nhà cung cấp AI</h1><div class="muted">Render trực tiếp từ backend · ' + rows.length + ' provider</div></div><div><a class="btn" href="/dashboard">Dashboard</a><a class="btn primary" href="/api/ai-providers">API trạng thái</a></div></div><div class="intro"><b>Production Ready</b> chỉ xuất hiện sau khi gọi model thật và nhận đúng function/tool call.</div>' + notice + '<div class="grid">' + cards + '</div></main><!-- ${marker} --></body></html>');
  });
}
`;

  const routePattern = /\n  app\.get\("\/ai-providers",[\s\S]*?\n\}\n$/;
  if (!routePattern.test(source)) throw new Error("AI_PROVIDER_PAGE_ROUTE_NOT_FOUND");
  source = source.replace(routePattern, replacement);
  fs.writeFileSync(file, source, "utf8");
}

console.log("[AIGUKA] AI provider page server-render hotfix installed");
