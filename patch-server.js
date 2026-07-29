import fs from "node:fs";

const file = "server-fixed.js";
let source = fs.readFileSync(file, "utf8");

const importAnchor = 'import { createProxyMiddleware } from "http-proxy-middleware";';
const imports = `${importAnchor}
import { installReportRoutes } from "./report-handler.js";
import { installLearningRoutes } from "./learning-handler.js";
import { installLearningAdminV2 } from "./learning-admin-v2.js";
import { installReviewedLearning } from "./reviewed-learning-ui.js";
import { installBotControlUi } from "./bot-control-ui.js";
import { installMetaFacebookLogin } from "./meta-facebook-login.js";
import { patchLearningUi } from "./learning-ui-patch.js";
import { patchDashboardUi } from "./dashboard-ui-patch.js";
import { repairExtraUiHtml } from "./repair-ui.js";
import { installAiProviderManager } from "./ai-provider-manager.js";
import { installAiContextCenterV3 } from "./ai-context-center-v3.js";
import { installAiContextRestoreRoute } from "./ai-context-restore-route.js";
import { installAiContextManagerV2 } from "./ai-context-manager-v2.js";
import { installDriveSlideManagerV4 } from "./drive-slide-manager-v4.js";
import { installMappingCenter } from "./src/routes/mappingCenterRoutes.js";`;

if (!source.includes('from "./report-handler.js"')) {
  if (source.includes(importAnchor)) source = source.replace(importAnchor, imports);
  else throw new Error("SERVER_IMPORT_ANCHOR_NOT_FOUND");
}

// Remove every temporary/local dashboard override. The required UI is the
// original Supabase aiguka-v8-admin page with the dark sidebar and full filters.
source = source
  .replace(/^import \{ installStableV7Dashboard \} from "\.\/v7-dashboard-stable\.js";\n/m, "")
  .replace(/\n?installStableV7Dashboard\(app\);/g, "");

const routeInstall = `const ORIGINAL_DASHBOARD_PATHS = [
  "/",
  "/dashboard",
  "/admin-v8",
  "/v8-dashboard",
  "/v7-dashboard",
  "/dashboard-v7",
  "/aiguka-v8-admin",
];
for (const dashboardPath of ORIGINAL_DASHBOARD_PATHS) {
  app.get(dashboardPath, async (_req, res) => {
    res.setHeader("x-aiguka-dashboard-source", "supabase-aiguka-v8-admin-v8");
    res.setHeader("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("pragma", "no-cache");
    res.setHeader("expires", "0");
    try {
      await serveSupabasePage("aiguka-v8-admin", res);
    } catch (error) {
      console.error("[AIGUKA original dashboard]", error);
      res.status(502).type("text/plain").send(
        "Không tải được Dashboard AIGUKA gốc: " +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  });
}

installReportRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});
app.json = express.json;
installLearningRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY,serviceRoleKey:process.env.SUPABASE_SERVICE_ROLE_KEY});
installLearningAdminV2(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY,serviceRoleKey:process.env.SUPABASE_SERVICE_ROLE_KEY});
installBotControlUi(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY,serviceRoleKey:process.env.SUPABASE_SERVICE_ROLE_KEY});
installReviewedLearning(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});
installMetaFacebookLogin(app);
installAiProviderManager(app);
installAiContextCenterV3(app);
installAiContextRestoreRoute(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY,serviceRoleKey:process.env.SUPABASE_SERVICE_ROLE_KEY});
installAiContextManagerV2(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY,serviceRoleKey:process.env.SUPABASE_SERVICE_ROLE_KEY});
installDriveSlideManagerV4(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY,serviceRoleKey:process.env.SUPABASE_SERVICE_ROLE_KEY});
installMappingCenter(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY,serviceRoleKey:process.env.SUPABASE_SERVICE_ROLE_KEY});
app.get("/learning",(_req,res)=>res.redirect(302,"/learning-reviewed"));
app.get("/v8-learning",(_req,res)=>res.redirect(302,"/learning-reviewed"));
app.get("/context-ai",(_req,res)=>res.redirect(302,"/ai-contexts"));
app.get("/control-center",(_req,res)=>res.redirect(302,"/bot-control"));
app.get("/v8-control-center",(_req,res)=>res.redirect(302,"/bot-control"));
pageRoutes.set("/v8-dashboard","aiguka-v8-admin");
pageRoutes.set("/v7-dashboard","aiguka-v8-admin");
pageRoutes.set("/dashboard-v7","aiguka-v8-admin");
pageRoutes.set("/ai-providers","aiguka-v8-ai-provider-ui");
pageRoutes.set("/tich-hop-ai","aiguka-v8-ai-provider-ui");`;

if (!source.includes("ORIGINAL_DASHBOARD_PATHS")) {
  const routeAnchor = "const proxyCommon = {";
  if (!source.includes(routeAnchor)) throw new Error("SERVER_ROUTE_ANCHOR_NOT_FOUND");
  source = source.replace(routeAnchor, `${routeInstall}\n\n${routeAnchor}`);
}

if (!source.includes("repairExtraUiHtml(html)")) {
  source = source.replace("html = repairBrokenInterpolations(html);", "html = repairBrokenInterpolations(html);\n  html = repairExtraUiHtml(html);");
}
if (!source.includes("patchLearningUi(html)")) {
  source = source.replace("html = injectTestBootstrap(html);", 'html = injectTestBootstrap(html);\n  if(slug === "aiguka-v8-learning-ui-v18") html = patchLearningUi(html);');
}
if (!source.includes("patchDashboardUi(html)")) {
  source = source.replace('if(slug === "aiguka-v8-learning-ui-v18") html = patchLearningUi(html);', 'if(slug === "aiguka-v8-learning-ui-v18") html = patchLearningUi(html);\n  if(slug === "aiguka-v8-admin") html = patchDashboardUi(html);');
}

source = source.replace(
  'const url = `${SUPABASE_URL}/functions/v1/aiguka-v8-report-api?action=filters`;',
  'const url = `http://127.0.0.1:${PORT}/functions/v1/aiguka-v8-report-api?action=filters`;',
);

for (const version of [
  "1.0.3-test-no-browser-key","1.0.4-test-rpc-data","1.0.5-learning-tags",
  "1.0.6-control-center-fix","1.0.7-all-ui-green","1.1.0-v7-dashboard-bridge",
  "1.1.1-v7-import-pending","1.2.0-v7-stable-dashboard","1.2.1-reviewed-learning-restored",
  "1.2.2-reviewed-learning-startup-fix","1.3.0-facebook-login","1.3.1-facebook-callback-fixed",
  "1.3.2-v7-all-account-filter-fixed","1.3.3-card-and-column-filters","1.3.4-practical-lead-filters",
  "1.3.5-filter-card-fixed","1.4.0-learning-bot-control-restored","1.4.1-learning-data-complete",
  "1.5.0-ai-context-manager","1.6.0-drive-context-lead-stable","1.6.1-lead-v4-drive-recursive","1.6.2-context-restore-drive-sync","1.6.3-all-actions-verified","1.6.4-aiguka-context-center","1.6.5-drive-v4-meta-messaging","1.6.6-valid-meta-scopes","1.6.7-messenger-carousel"
]) source = source.replaceAll(version, "1.7.2-original-dashboard-hard-route");

fs.writeFileSync(file, source);
console.log("[AIGUKA] Original Supabase dashboard hard routes installed");
await import("./patch-server-degraded-health.js");