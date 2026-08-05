import express from "express";
import vm from "node:vm";
import { createProxyMiddleware } from "http-proxy-middleware";
import { installReportRoutes } from "./report-handler.js";
import { installV10AdminDashboard } from "./dashboard-v10-admin-shell.js";
import { installLearningRoutes } from "./learning-handler.js";
import { installLearningAdminV2 } from "./learning-admin-v2.js";
import { installReviewedLearning } from "./reviewed-learning-ui.js";
import { installBotControlUi } from "./bot-control-ui.js";
import { installMetaFacebookLogin } from "./meta-facebook-login.js";
import { patchLearningUi } from "./learning-ui-patch.js";
import { patchDashboardUi } from "./dashboard-ui-patch.js";
import { patchV10ReportTablesUi } from "./dashboard-report-v10-patch.js";
import { repairExtraUiHtml } from "./repair-ui.js";
import { installAiProviderManager } from "./ai-provider-manager.js";
import { installAiContextCenterV3 } from "./ai-context-center-v3.js";
import { installAiContextRestoreRoute } from "./ai-context-restore-route.js";
import { installAiContextManagerV2 } from "./ai-context-manager-v2.js";
import { installDriveSlideManagerV4 } from "./drive-slide-manager-v4.js";
import { installMappingCenter } from "./src/routes/mappingCenterRoutes.js";
import { installV9AdminAuth } from "./v9-admin-auth.js";
import { installV9AdminReportApiV2 } from "./v9-admin-report-api-v2.js";
import { installV9ReportBenchmarkApi } from "./v9-report-benchmark-api.js";
import { installV9AdminUiV2 } from "./v9-admin-ui-v2.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = String(
  process.env.SUPABASE_URL || "https://ezygfpeeqbbirdeazene.supabase.co",
).replace(/\/$/, "");
const SUPABASE_PUBLIC_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "";
const TEST_SESSION_VALUE = "AIGUKA_RAILWAY_TEST_MODE";

const pageRoutes = new Map([
  ["/", "aiguka-v8-admin"],
  ["/dashboard", "aiguka-v8-admin"],
  ["/admin-v8", "aiguka-v8-admin"],
  ["/control-center", "aiguka-v8-meta-admin"],
  ["/readiness", "aiguka-v8-readiness"],
  ["/observe", "aiguka-v8-quality"],
  ["/quality", "aiguka-v8-quality"],
  ["/learning", "aiguka-v8-learning-ui-v18"],
  ["/aiguka-v8-admin", "aiguka-v8-admin"],
  ["/aiguka-v8-meta-admin", "aiguka-v8-meta-admin"],
  ["/aiguka-v8-readiness", "aiguka-v8-readiness"],
  ["/aiguka-v8-quality", "aiguka-v8-quality"],
  ["/aiguka-v8-learning-ui-v18", "aiguka-v8-learning-ui-v18"],
]);

function setProxyAuth(proxyReq, req) {
  if (SUPABASE_PUBLIC_KEY) {
    if (!req.headers.apikey) proxyReq.setHeader("apikey", SUPABASE_PUBLIC_KEY);
    if (!req.headers.authorization) {
      proxyReq.setHeader("authorization", `Bearer ${SUPABASE_PUBLIC_KEY}`);
    }
  }
  proxyReq.setHeader("x-aiguka-railway-test", "enabled");
  proxyReq.setHeader("x-aiguka-admin-secret", TEST_SESSION_VALUE);
}

installV9AdminAuth(app);
installV9AdminReportApiV2(app);
installV9ReportBenchmarkApi(app);
installV9AdminUiV2(app);
installReportRoutes(app,{supabaseUrl:SUPABASE_URL,publishableKey:SUPABASE_PUBLIC_KEY});
installV10AdminDashboard(app);
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
app.get("/leads",(_req,res)=>res.redirect(302,"/dashboard?view=leads"));
app.get("/customers",(_req,res)=>res.redirect(302,"/dashboard?view=leads"));
app.get("/daily-report",(_req,res)=>res.redirect(302,"/dashboard?view=daily"));
app.get("/reports",(_req,res)=>res.redirect(302,"/dashboard?view=daily"));
app.get("/dashboard-meta-month",(_req,res)=>res.redirect(302,"/dashboard?view=daily"));
app.get("/v7-dashboard",(_req,res)=>res.redirect(302,"/dashboard?view=dashboard"));
app.get("/dashboard-v7",(_req,res)=>res.redirect(302,"/dashboard?view=dashboard"));
pageRoutes.set("/v8-dashboard","aiguka-v8-admin");
pageRoutes.set("/ai-providers","aiguka-v8-ai-provider-ui");
pageRoutes.set("/tich-hop-ai","aiguka-v8-ai-provider-ui");

const proxyCommon = {
  target: SUPABASE_URL,
  changeOrigin: true,
  secure: true,
  xfwd: true,
  proxyTimeout: 120_000,
  timeout: 120_000,
  on: {
    proxyReq: setProxyAuth,
    error(error, _req, res) {
      console.error("[AIGUKA proxy]", error.message);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      }
      res.end(JSON.stringify({ ok: false, error: "SUPABASE_PROXY_ERROR" }));
    },
  },
};

app.use(
  "/functions/v1",
  createProxyMiddleware({
    ...proxyCommon,
    pathRewrite: (path) => `/functions/v1${path}`,
  }),
);

app.use(
  "/rest/v1",
  createProxyMiddleware({
    ...proxyCommon,
    pathRewrite: (path) => `/rest/v1${path}`,
  }),
);

function repairBrokenInterpolations(input) {
  let html = input;
  for (let i = 0; i < 8; i += 1) {
    const before = html;
    html = html.replace(/''\+(.+?)\+''/g, (_match, expression) => {
      return `\\''+${expression}+'\\'`;
    });
    if (html === before) break;
  }
  return html;
}

function forceSameOrigin(input) {
  return input.split(SUPABASE_URL).join("");
}

function injectTestBootstrap(html) {
  const script = `<script id="aiguka-test-bootstrap">
(function(){
  const TEST_VALUE=${JSON.stringify(TEST_SESSION_VALUE)};
  try{sessionStorage.setItem('aiguka_admin_secret',TEST_VALUE);}catch(_){ }
  window.__AIGUKA_TEST_MODE__=true;
  const nativePrompt=window.prompt.bind(window);
  window.prompt=function(message,defaultValue){
    if(/mã quản trị|ma quan tri|admin secret/i.test(String(message||''))){
      try{sessionStorage.setItem('aiguka_admin_secret',TEST_VALUE);}catch(_){ }
      return TEST_VALUE;
    }
    return nativePrompt(message,defaultValue);
  };
})();
</script>`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${script}`);
  }
  return `${script}${html}`;
}

function validateInlineScripts(html) {
  const errors = [];
  const pattern = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  let index = 0;
  while ((match = pattern.exec(html)) !== null) {
    index += 1;
    const attrs = match[1] || "";
    const source = match[2] || "";
    if (/\bsrc\s*=/.test(attrs)) continue;
    const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
    if (typeMatch && !/(javascript|ecmascript|module)/i.test(typeMatch[1])) continue;
    if (/\btype\s*=\s*["']module["']/i.test(attrs)) continue;
    try {
      new vm.Script(source, { filename: `inline-script-${index}.js` });
    } catch (error) {
      errors.push({
        index,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return errors;
}

function injectRuntimeUi(html, scriptErrors) {
  const errorCount = scriptErrors.length;
  const injection = `
<style id="aiguka-runtime-feedback-style">
#aiguka-runtime-state{position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:9px 12px;border-radius:999px;background:#b54708;color:#fff;font:600 13px Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.22);user-select:none}
#aiguka-runtime-state.ok{background:#067647}#aiguka-runtime-state.bad{background:#b42318}#aiguka-runtime-state.wait{background:#b54708}
#aiguka-action-toast{position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483647;padding:10px 14px;border-radius:9px;background:#111827;color:#fff;font:600 13px Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.24);opacity:0;pointer-events:none;transition:opacity .16s ease}
#aiguka-action-toast.show{opacity:1}
button,.btn,.nav,a[href],[role="button"]{transition:transform .08s ease,filter .12s ease,opacity .12s ease!important}
.aiguka-clicked{transform:scale(.97)!important;filter:brightness(.9)!important;opacity:.78!important;pointer-events:none!important}
#aiguka-runtime-error{position:fixed;left:12px;right:12px;top:12px;z-index:2147483646;padding:12px 14px;border-radius:9px;background:#fee4e2;color:#912018;border:1px solid #fecdca;font:700 13px Arial,sans-serif;display:none}
#aiguka-runtime-error.show{display:block}
</style>
<div id="aiguka-action-toast">Đã nhận thao tác · đang xử lý…</div>
<div id="aiguka-runtime-error"></div>
<div id="aiguka-runtime-state" class="${errorCount ? "bad" : "wait"}">${errorCount ? `Còn ${errorCount} lỗi JavaScript` : "Đang kết nối dữ liệu…"}</div>
<script id="aiguka-runtime-feedback-script">
(function(){
  const initialScriptErrors=${JSON.stringify(scriptErrors)};
  const toast=document.getElementById('aiguka-action-toast');
  const state=document.getElementById('aiguka-runtime-state');
  const errorBox=document.getElementById('aiguka-runtime-error');
  let toastTimer=0,checking=false,lastCheck=0;
  function showToast(text){
    toast.textContent=text||'Đã nhận thao tác · đang xử lý…';
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer=setTimeout(()=>toast.classList.remove('show'),1100);
  }
  function showError(text){
    errorBox.textContent=text;
    errorBox.classList.add('show');
    state.className='bad';
    state.textContent='Có lỗi giao diện';
  }
  if(initialScriptErrors.length){
    showError('AIGUKA phát hiện lỗi JavaScript: '+initialScriptErrors.map(x=>x.message).join(' | '));
  }
  document.addEventListener('click',function(event){
    const target=event.target&&event.target.closest?event.target.closest('button,.btn,.nav,a[href],[role="button"]'):null;
    if(!target||target.disabled)return;
    target.classList.add('aiguka-clicked');
    target.setAttribute('aria-busy','true');
    showToast('Đã nhận thao tác · đang xử lý…');
    setTimeout(function(){target.classList.remove('aiguka-clicked');target.removeAttribute('aria-busy');},650);
    setTimeout(()=>checkDatabase(false),850);
  },true);
  window.addEventListener('error',function(event){showError('Lỗi JavaScript: '+(event.message||'Không xác định'));});
  window.addEventListener('unhandledrejection',function(event){
    const reason=event.reason&&event.reason.message?event.reason.message:String(event.reason||'Không xác định');
    showError('Lỗi xử lý: '+reason);
  });
  async function checkDatabase(force){
    const now=Date.now();
    if(checking||(!force&&now-lastCheck<4000))return;
    lastCheck=now;checking=true;
    state.className='wait';state.textContent='Đang kiểm tra dữ liệu…';
    try{
      const response=await fetch('/__aiguka/db-check',{cache:'no-store'});
      const data=await response.json().catch(()=>({}));
      if(!response.ok||!data.ok)throw new Error(data.error||('HTTP '+response.status));
      state.className='ok';state.textContent='Dữ liệu đã kết nối';
      state.title='Page: '+(data.pages??'-')+' · Tài khoản QC: '+(data.ad_accounts??'-');
    }catch(error){
      state.className='bad';state.textContent='Dữ liệu chưa kết nối';
      state.title=error&&error.message?error.message:String(error);
    }finally{checking=false;}
  }
  setTimeout(()=>checkDatabase(true),700);
})();
</script>`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${injection}</body>`);
  return `${html}${injection}`;
}

async function fetchAndPreparePage(slug) {
  const url = `${SUPABASE_URL}/functions/v1/${slug}?railway_ui=${Date.now()}`;
  const upstream = await fetch(url, {
    headers: { accept: "text/plain, text/html;q=0.9, */*;q=0.8" },
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  const original = await upstream.text();
  if (!upstream.ok) return { ok: false, status: upstream.status, original, html: original, errors: [] };
  let html = forceSameOrigin(original);
  html = repairBrokenInterpolations(html);
  html = repairExtraUiHtml(html);
  html = injectTestBootstrap(html);
  if(slug === "aiguka-v8-learning-ui-v18") html = patchLearningUi(html);
  if(slug === "aiguka-v8-admin") html = patchDashboardUi(html);
  if(slug === "aiguka-v8-admin") html = patchV10ReportTablesUi(html);
  const errors = validateInlineScripts(html);
  html = injectRuntimeUi(html, errors);
  return { ok: true, status: 200, original, html, errors };
}

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "aiguka-v8-railway-admin",
    version: "2.1.1-v10-admin-navigation",
    supabase: SUPABASE_URL,
    public_key_configured: Boolean(SUPABASE_PUBLIC_KEY),
    browser_admin_key_required: false,
    now: new Date().toISOString(),
  });
});

app.get("/health/ui", async (_req, res) => {
  const slugs = [...new Set(pageRoutes.values())];
  const results = [];
  for (const slug of slugs) {
    try {
      const page = await fetchAndPreparePage(slug);
      results.push({
        slug,
        upstream_ok: page.ok,
        upstream_status: page.status,
        original_bytes: page.original.length,
        repaired_bytes: page.html.length,
        script_errors: page.errors,
        remaining_bad_interpolations: (page.html.match(/''\+(.+?)\+''/g) || []).length,
      });
    } catch (error) {
      results.push({ slug, upstream_ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  res.json({ ok: results.every((x) => x.upstream_ok && (!x.script_errors || x.script_errors.length === 0)), results });
});

app.get("/__aiguka/db-check", async (_req, res) => {
  if (!SUPABASE_PUBLIC_KEY) {
    res.status(503).json({ ok: false, error: "MISSING_SUPABASE_PUBLIC_KEY" });
    return;
  }
  try {
    const url = `http://127.0.0.1:${PORT}/functions/v1/aiguka-v8-report-api?action=filters`;
    const response = await fetch(url, {
      headers: {
        apikey: SUPABASE_PUBLIC_KEY,
        authorization: `Bearer ${SUPABASE_PUBLIC_KEY}`,
        "x-aiguka-railway-test": "enabled",
        "x-aiguka-admin-secret": TEST_SESSION_VALUE,
      },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    const body = await response.text();
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = { raw: body.slice(0, 300) }; }
    if (!response.ok || parsed?.ok === false) {
      res.status(response.status || 502).json({ ok: false, error: parsed?.error || `SUPABASE_HTTP_${response.status}` });
      return;
    }
    res.json({
      ok: true,
      upstream_status: response.status,
      pages: Array.isArray(parsed?.data?.pages) ? parsed.data.pages.length : null,
      ad_accounts: Array.isArray(parsed?.data?.ad_accounts) ? parsed.data.ad_accounts.length : null,
      ads: Array.isArray(parsed?.data?.ads) ? parsed.data.ads.length : null,
    });
  } catch (error) {
    res.status(502).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

async function serveSupabasePage(slug, res) {
  const page = await fetchAndPreparePage(slug);
  if (!page.ok) {
    res.status(page.status).type("text/plain").send(`Không tải được giao diện ${slug}: HTTP ${page.status}\n${page.original}`);
    return;
  }
  res.status(200);
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("pragma", "no-cache");
  res.setHeader("expires", "0");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-aiguka-ui-script-errors", String(page.errors.length));
  res.send(page.html);
}

for (const [path, slug] of pageRoutes.entries()) {
  app.get(path, async (_req, res) => {
    try {
      await serveSupabasePage(slug, res);
    } catch (error) {
      console.error(`[AIGUKA page ${slug}]`, error);
      res.status(502).type("text/plain").send(`Không tải được giao diện AIGUKA: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "NOT_FOUND" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[AIGUKA] Railway admin listening on 0.0.0.0:${PORT}`);
  console.log(`[AIGUKA] Supabase upstream: ${SUPABASE_URL}`);
  console.log("[AIGUKA] Browser admin key prompt disabled for test mode");
});