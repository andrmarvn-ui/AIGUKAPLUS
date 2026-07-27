import fs from "node:fs";

const file = "v7-dashboard-stable.js";
if (!fs.existsSync(file)) {
  fs.writeFileSync(
    file,
    `export function installStableV7Dashboard(app) {
  const render = (_req, res) => {
    res.status(200).type("html").send(\`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AIGUKA đang phục hồi</title><style>body{font-family:Arial,sans-serif;background:#f8fafc;color:#172b4d;margin:0;display:grid;place-items:center;min-height:100vh}.box{max-width:620px;margin:24px;padding:28px;border-radius:18px;background:#fff;box-shadow:0 18px 50px rgba(15,23,42,.12)}h1{font-size:24px;margin:0 0 14px}p{line-height:1.55}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#f79009;margin-right:8px}</style></head><body><main class="box"><h1><span class="dot"></span>AIGUKA đang phục hồi kết nối dữ liệu</h1><p>Luồng thời gian thực đang được ưu tiên. Dashboard đầy đủ sẽ trở lại khi Supabase hết nghẽn.</p></main></body></html>\`);
  };
  app.get("/v7-dashboard", render);
  app.get("/dashboard-v7", render);
}
`,
    "utf8",
  );
  console.warn("[AIGUKA startup] Created temporary degraded dashboard module");
}
