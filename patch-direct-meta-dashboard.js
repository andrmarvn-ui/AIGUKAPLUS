import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "server-fixed.js";
let source = fs.readFileSync(file, "utf8");
const importLine = 'import { installStableReportDashboard } from "./dashboard-v10-stable.js";';

if (!source.includes(importLine)) {
  const anchor = 'import { installReportRoutes } from "./report-handler.js";';
  if (!source.includes(anchor)) throw new Error("DIRECT_META_DASHBOARD_IMPORT_ANCHOR_NOT_FOUND");
  source = source.replace(anchor, `${anchor}\n${importLine}`);
}

if (!source.includes("installStableReportDashboard(app);")) {
  const anchor = "installReportRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});";
  if (!source.includes(anchor)) throw new Error("DIRECT_META_DASHBOARD_ROUTE_ANCHOR_NOT_FOUND");
  source = source.replace(anchor, `${anchor}\ninstallStableReportDashboard(app);`);
}

source = source.replace(
  'const url = `${SUPABASE_URL}/functions/v1/aiguka-v8-report-api?action=filters`;',
  'const url = `http://127.0.0.1:${PORT}/functions/v1/aiguka-v8-report-api?action=filters`;',
);
source = source.replaceAll("2.0.5-v10-report-tables-live-facts", "2.1.0-v10-direct-meta-dashboard");

fs.writeFileSync(file, source, "utf8");
const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
if (syntax.status !== 0) throw new Error(`DIRECT_META_DASHBOARD_SERVER_SYNTAX:${syntax.stderr || syntax.stdout}`);
console.log("[AIGUKA] Stable dashboard installed with direct Meta reporting and local health check");
