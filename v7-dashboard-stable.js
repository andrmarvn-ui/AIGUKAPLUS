import express from "express";
import { pathToFileURL } from "node:url";

const REPORT_PATHS = new Set([
  "/",
  "/dashboard",
  "/dashboard-today",
  "/dashboard-yesterday",
  "/dashboard-meta-month",
  "/daily-report",
  "/reports",
  "/leads",
  "/customers",
  "/admin-v5",
  "/api/v7-dashboard/status",
  "/export",
  "/__aiguka/prewarm-v7-report-ui",
]);

const REPORT_PATCHES = [
  "./patch-v7-report-accuracy.js",
  "./patch-v7-product-detection.js",
  "./patch-v7-navigation.js",
  "./patch-v7-pancake-toggle.js",
  "./patch-v7-lead-filters.js",
  "./patch-v7-daily-grouped.js",
  "./patch-v7-daily-staff-history.js",
  "./patch-v7-daily-layout-sample.js",
  "./patch-v7-filter-final.js",
  "./patch-v7-daily-staff-aligned.js",
  "./patch-v7-daily-runtime-self-contained.js",
  "./patch-v7-leads-meta-primary.js",
  "./patch-v7-leads-referral-source.js",
  "./patch-v7-pancake-tag-completeness.js",
  "./patch-v7-pancake-tag-final.js",
  "./patch-v7-daily-final-anchor-fix.js",
  "./patch-v7-daily-final.js",
  "./patch-v7-daily-runtime-fallback.js",
  "./patch-v7-lead-table-v4.js",
  "./patch-v7-lead-filter-logical.js",
  "./patch-v7-lead-contact-ui.js",
  "./patch-v7-null-safety.js",
  "./patch-v7-runtime-integrity.js",
  "./patch-v7-lead-meta-insights-truth.js",
  "./patch-v7-lead-reel-old-ad-attribution.js",
  "./patch-v7-lead-reel-reply-guard.js",
  "./patch-v7-split-leads-compat.js",
  "./patch-v7-split-leads-ad-performance.js",
  "./patch-v7-lead-filter-status-fix.js",
  "./patch-v7-lead-account-reconcile.js",
];

const reportRouter = express.Router();
let readyPromise = null;
let loadedAt = null;
let lastError = null;

async function loadExactPreV21ReportUi() {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Fetch and verify the exact embedded V7.5 source only when reporting is used.
  // This keeps Railway startup independent from temporary Supabase pressure.
  await import(`./materialize-v7-dashboard-resilient.js?lazy=${token}`);

  // Reapply the complete pre-Report-V2.1 report patch chain in its original order.
  for (let index = 0; index < REPORT_PATCHES.length; index += 1) {
    await import(`${REPORT_PATCHES[index]}?lazy=${token}-${index}`);
  }

  // materialize-v7-dashboard-resilient.js replaces this source file on disk with
  // the verified legacy implementation. Import that generated module separately.
  const generatedUrl = `${pathToFileURL(`${process.cwd()}/v7-dashboard-stable.js`).href}?generated=${token}`;
  const generated = await import(generatedUrl);
  if (typeof generated.installStableV7Dashboard !== "function") {
    throw new Error("PRE_V21_REPORT_INSTALLER_MISSING");
  }

  generated.installStableV7Dashboard(reportRouter);
  loadedAt = new Date().toISOString();
  lastError = null;
  console.log(`[AIGUKA] Exact pre-V2.1 report UI loaded at ${loadedAt}`);
}

export async function ensureStableV7DashboardReady() {
  if (!readyPromise) {
    readyPromise = loadExactPreV21ReportUi().catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      readyPromise = null;
      console.error(`[AIGUKA pre-V2.1 report UI] ${lastError}`);
      throw error;
    });
  }
  return readyPromise;
}

export function installStableV7Dashboard(app) {
  app.use(async (req, res, next) => {
    if (!REPORT_PATHS.has(req.path)) return next();

    try {
      await ensureStableV7DashboardReady();
      if (req.path === "/__aiguka/prewarm-v7-report-ui") {
        return res.status(200).json({
          ok: true,
          source: "pre-report-v2.1-v7.5",
          loaded_at: loadedAt,
          last_error: lastError,
        });
      }
      return reportRouter(req, res, next);
    } catch (error) {
      return res.status(503).type("text/html; charset=utf-8").send(
        `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Đang khôi phục Báo cáo</title></head><body style="font-family:Arial,sans-serif;padding:24px"><h2>Đang khôi phục giao diện Báo cáo trước Report V2.1</h2><p>Nguồn giao diện đang được tải lại. Hãy thử lại sau ít phút.</p><pre>${String(error instanceof Error ? error.message : error).replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]))}</pre></body></html>`,
      );
    }
  });

  console.log("[AIGUKA] Lazy pre-V2.1 report UI route installed");
}
