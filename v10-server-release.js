import crypto from "node:crypto";
import fs from "node:fs";

const VERSION = "v10_server_final_v1";
const serverFile = new URL("./server-v10-final.js", import.meta.url);
const checksumFile = new URL("./server-v10-final.sha256", import.meta.url);

function source(path) {
  if (!fs.existsSync(path)) throw new Error(`V10_SERVER_FILE_MISSING:${path}`);
  return fs.readFileSync(path);
}

const bytes = source(serverFile);
const expected = source(checksumFile).toString("utf8").trim();
const actual = crypto.createHash("sha256").update(bytes).digest("hex");
if (!/^[a-f0-9]{64}$/.test(expected) || expected !== actual) {
  throw new Error(`V10_SERVER_CHECKSUM_MISMATCH:${expected}:${actual}`);
}

const text = bytes.toString("utf8");
for (const token of [
  'installReportRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY})',
  'installV10AdminDashboard(app)',
  'installBotControlUi(app',
  'installAiProviderManager(app)',
  'installAiContextCenterV3(app)',
  'installDriveSlideManagerV4(app',
  'installMappingCenter(app',
  'app.listen(PORT, "0.0.0.0"',
]) {
  if (!text.includes(token)) throw new Error(`V10_SERVER_ROUTE_CONTRACT_MISSING:${token}`);
}
for (const forbidden of [
  'installStableReportDashboard(app)',
  'v8_report_summary_v21',
]) {
  if (text.includes(forbidden)) throw new Error(`V10_SERVER_RETIRED_TOKEN_PRESENT:${forbidden}`);
}

globalThis.__AIGUKA_V10_SERVER_RELEASE__ = VERSION;
console.log(`[AIGUKA V10] ${VERSION} verified: checksummed server, no runtime server source patching`);
await import("./server-v10-final.js");
