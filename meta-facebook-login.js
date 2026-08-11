import crypto from "node:crypto";
import {
  listMetaConnections,
  metaOAuthStoreConfigured,
  saveMetaConnection,
} from "./meta-token-store.js";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v23.0";
const META_APP_ID = process.env.META_APP_ID || "";
const META_APP_SECRET = process.env.META_APP_SECRET || "";
const REQUESTED_SCOPES = String(
  process.env.META_OAUTH_SCOPES ||
    "ads_read,business_management,pages_show_list,pages_read_engagement,pages_messaging,pages_manage_metadata",
)
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value && value !== "pages_read_user_content");

const esc = (value = "") =>
  String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);

function configured() {
  return Boolean(META_APP_ID && META_APP_SECRET && metaOAuthStoreConfigured());
}

function callbackUrl(req) {
  if (process.env.META_OAUTH_REDIRECT_URI) return process.env.META_OAUTH_REDIRECT_URI;
  const protocol = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0];
  return `${protocol}://${req.get("host")}/facebook/callback`;
}

function signState() {
  const payload = Buffer.from(JSON.stringify({
    nonce: crypto.randomBytes(18).toString("hex"),
    exp: Date.now() + 10 * 60 * 1000,
  })).toString("base64url");
  const signature = crypto
    .createHmac("sha256", META_APP_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function validState(value) {
  try {
    const [payload, signature] = String(value || "").split(".");
    if (!payload || !signature) return false;
    const expected = crypto
      .createHmac("sha256", META_APP_SECRET)
      .update(payload)
      .digest("base64url");
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length) return false;
    if (!crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return false;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

function cookieValue(req, name) {
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

async function fetchJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(25_000),
    cache: "no-store",
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  if (!response.ok || data?.error) {
    throw new Error(data?.error?.message || data?.message || `META_HTTP_${response.status}`);
  }
  return data;
}

async function fetchPages(url, maxPages = 20) {
  const rows = [];
  let next = url;
  let pageNumber = 0;
  while (next && pageNumber++ < maxPages) {
    const data = await fetchJson(next);
    rows.push(...(data.data || []));
    next = data?.paging?.next || "";
  }
  return rows;
}

function page(title, body) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f4f7fb;color:#172033;font:15px Arial,sans-serif}.top{background:#0f172a;color:#fff;padding:20px}.wrap{max-width:920px;margin:24px auto;padding:0 14px}.card{background:#fff;border:1px solid #d7dfeb;border-radius:14px;padding:18px;margin-bottom:14px}.btn{display:inline-block;padding:12px 16px;border-radius:9px;background:#1877f2;color:#fff;text-decoration:none;font-weight:700}.muted{color:#667085}.good{background:#ecfdf3;border-color:#abefc6}.bad{background:#fff1f0;border-color:#fecdca}.code{font-family:monospace;background:#f2f4f7;padding:9px;border-radius:7px;word-break:break-all}.row{padding:10px 0;border-bottom:1px solid #eaecf0}.row:last-child{border-bottom:0}</style></head><body><div class="top"><h2 style="margin:0">AIGUKA — Kết nối Facebook</h2></div><div class="wrap">${body}</div></body></html>`;
}

function successPage(profileName, accountCount) {
  return page("Đã kết nối", `<div class="card good"><h2>Đã kết nối ${esc(profileName)}</h2><p>AIGUKA nhìn thấy <b>${accountCount}</b> tài khoản quảng cáo.</p><p id="apply-state">Đang làm mới dữ liệu Meta và chuyển về Dashboard…</p></div><script>
  (async function(){
    const status=document.getElementById('apply-state');
    try{
      const response=await fetch('/api/v7-dashboard/status?oauth_refresh='+Date.now(),{cache:'no-store'});
      if(!response.ok) throw new Error('HTTP '+response.status);
      status.textContent='Đã áp dụng kết nối. Đang mở Dashboard…';
    }catch(error){
      status.textContent='Đã lưu kết nối. Dashboard sẽ tự làm mới dữ liệu Meta.';
    }
    setTimeout(function(){location.replace('/dashboard?facebook_connected=1');},900);
  })();
  </script>`);
}

export function installMetaFacebookLogin(app) {
  app.get("/facebook-connect", async (req, res) => {
    const redirect = callbackUrl(req);
    let connections = [];
    let listError = "";
    try { connections = await listMetaConnections(); } catch (error) { listError = error.message; }

    const status = configured()
      ? `<div class="card good"><b>Sẵn sàng kết nối</b><p>Đăng nhập đúng tài khoản Facebook đang quản lý tài khoản quảng cáo cần đưa vào AIGUKA.</p><a class="btn" href="/facebook/login">Đăng nhập bằng Facebook</a></div>`
      : `<div class="card bad"><b>Chưa đủ cấu hình Railway</b><p>Cần thêm <code>META_APP_ID</code>, <code>META_APP_SECRET</code> và giữ <code>SUPABASE_SERVICE_ROLE_KEY</code>.</p></div>`;

    const rows = connections.length
      ? connections.map((item) => `<div class="row"><b>${esc(item.facebook_user_name || item.facebook_user_id)}</b> ${item.active ? "· đang dùng" : ""}<br><span class="muted">${(item.ad_accounts || []).length} tài khoản quảng cáo · cập nhật ${esc(item.updated_at || "")}</span></div>`).join("")
      : `<div class="muted">Chưa có tài khoản Facebook nào được kết nối.</div>`;

    res.type("html").send(page("Kết nối Facebook", `${status}<div class="card"><b>Redirect URI phải khai báo trong Meta</b><div class="code">${esc(redirect)}</div></div><div class="card"><h3 style="margin-top:0">Tài khoản đã kết nối</h3>${listError ? `<div class="bad">${esc(listError)}</div>` : rows}</div><a href="/dashboard">← Về Dashboard</a>`));
  });

  app.get("/facebook/login", (req, res) => {
    if (!configured()) {
      res.status(503).type("html").send(page("Thiếu cấu hình", `<div class="card bad">Thiếu META_APP_ID, META_APP_SECRET hoặc cấu hình lưu token.</div>`));
      return;
    }
    const state = signState();
    const redirect = callbackUrl(req);
    res.setHeader(
      "set-cookie",
      `aiguka_fb_state=${encodeURIComponent(state)}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`,
    );
    const params = new URLSearchParams({
      client_id: META_APP_ID,
      redirect_uri: redirect,
      state,
      response_type: "code",
      scope: REQUESTED_SCOPES.join(","),
      auth_type: "rerequest",
    });
    res.redirect(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params}`);
  });

  app.get("/facebook/callback", async (req, res) => {
    try {
      if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
      const state = String(req.query.state || "");
      if (!validState(state) || cookieValue(req, "aiguka_fb_state") !== state) {
        throw new Error("FACEBOOK_OAUTH_STATE_INVALID");
      }
      const code = String(req.query.code || "");
      if (!code) throw new Error("FACEBOOK_OAUTH_CODE_MISSING");
      const redirect = callbackUrl(req);

      const shortParams = new URLSearchParams({
        client_id: META_APP_ID,
        client_secret: META_APP_SECRET,
        redirect_uri: redirect,
        code,
      });
      const short = await fetchJson(
        `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?${shortParams}`,
      );
      let accessToken = short.access_token;

      try {
        const longParams = new URLSearchParams({
          grant_type: "fb_exchange_token",
          client_id: META_APP_ID,
          client_secret: META_APP_SECRET,
          fb_exchange_token: accessToken,
        });
        const long = await fetchJson(
          `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?${longParams}`,
        );
        if (long.access_token) accessToken = long.access_token;
      } catch (error) {
        console.warn("[AIGUKA Meta OAuth] Long-lived exchange failed:", error.message);
      }

      const token = encodeURIComponent(accessToken);
      const [profile, permissions, adAccounts] = await Promise.all([
        fetchJson(`https://graph.facebook.com/${GRAPH_VERSION}/me?fields=id,name&access_token=${token}`),
        fetchPages(`https://graph.facebook.com/${GRAPH_VERSION}/me/permissions?limit=200&access_token=${token}`),
        fetchPages(`https://graph.facebook.com/${GRAPH_VERSION}/me/adaccounts?fields=id,name,account_status&limit=200&access_token=${token}`),
      ]);
      const scopes = permissions
        .filter((item) => item.status === "granted")
        .map((item) => item.permission);

      await saveMetaConnection({
        facebookUserId: profile.id,
        facebookUserName: profile.name,
        accessToken,
        scopes,
        adAccounts,
      });
      process.env.META_ACCESS_TOKEN = accessToken;

      res.setHeader("set-cookie", "aiguka_fb_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax");
      res.status(200).type("html").send(successPage(profile.name, adAccounts.length));
    } catch (error) {
      console.error("[AIGUKA Meta OAuth]", error);
      res.status(400).type("html").send(page("Kết nối thất bại", `<div class="card bad"><b>Không thể kết nối Facebook</b><p>${esc(error.message)}</p></div><a href="/facebook-connect">Thử lại</a>`));
    }
  });
}