import crypto from "node:crypto";
import fs from "node:fs";

const VERSION = "v10_server_final_v3_report_contact_scan";
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
  'installLearningAdminV2(app',
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

const learning = source(new URL("./learning-admin-v2.js", import.meta.url)).toString("utf8");
for (const token of [
  'v10_learning_conversation_list',
  'v10_learning_conversation_detail',
  'async function dbRequest(',
  'Core V10 chưa sẵn sàng; đang dùng V8 dự phòng',
  'limit=2000',
]) {
  if (!learning.includes(token)) throw new Error(`V10_LEARNING_ADMIN_GUARD_MISSING:${token}`);
}
for (const forbidden of [
  'signal:AbortSignal.timeout(60000)',
  'p_scope:b.scope==="profile"?"profile":"conversation"',
]) {
  if (learning.includes(forbidden)) throw new Error(`V10_LEARNING_ADMIN_RETIRED_PATTERN:${forbidden}`);
}

const botControl = source(new URL("./bot-control-ui.js", import.meta.url)).toString("utf8");
if (!botControl.includes('async function dbRequest(')) {
  throw new Error('V10_BOT_CONTROL_DB_REQUEST_GUARD_MISSING');
}
for (const forbidden of [
  'async function request(base, token, path, request = {})',
  'const rest = (path, request = {}) => request(',
  'const core = (path, request = {}) => request(',
]) {
  if (botControl.includes(forbidden)) throw new Error(`V10_BOT_CONTROL_REQUEST_SHADOW_REGRESSION:${forbidden}`);
}

globalThis.__AIGUKA_V10_SERVER_RELEASE__ = VERSION;
console.log(`[AIGUKA V10] ${VERSION} verified: checksummed server, Core Learning admin and safe management DB clients`);
try {
  await import("./patch-v10-report-contact-scan-meta-metric.js");
} catch (error) {
  console.error(`[AIGUKA V10] report scan/meta patch degraded: ${error instanceof Error ? error.message : String(error)}`);
}
await import("./server-v10-final.js");