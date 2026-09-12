import crypto from "node:crypto";
import express from "express";

const ACCESS_COOKIE = "aiguka_access_token";
const REFRESH_COOKIE = "aiguka_refresh_token";
const LOCAL_OWNER_COOKIE = "aiguka_local_owner";
const DEFAULT_ACCESS_TTL_SECONDS = 60 * 60;
const DEFAULT_REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;
const INTERNAL_TOKEN = process.env.AIGUKA_INTERNAL_HTTP_TOKEN || crypto.randomBytes(32).toString("hex");
process.env.AIGUKA_INTERNAL_HTTP_TOKEN = INTERNAL_TOKEN;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character]);
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    try { cookies[name] = decodeURIComponent(part.slice(separator + 1).trim()); }
    catch { cookies[name] = part.slice(separator + 1).trim(); }
  }
  return cookies;
}

function safeNext(value) {
  const candidate = String(value || "").trim();
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return "/dashboard";
  if (candidate.startsWith("/auth/")) return "/dashboard";
  return candidate;
}

function wantsHtml(req) {
  return /text\/html/i.test(String(req.headers.accept || "")) && /^(GET|HEAD)$/i.test(req.method);
}

function publicRequest(req) {
  const path = String(req.path || req.url || "").split("?", 1)[0].replace(/\/+$/, "") || "/";
  if (path === "/health" || path === "/favicon.ico" || path === "/robots.txt") return true;
  if (path === "/__aiguka/verify-meta-signature") return true;
  if (path === "/auth/login" || path === "/auth/logout") return true;
  return [
    "/functions/v1/aiguka-v9-webhook",
    "/functions/v1/aiguka-v8-webhook",
  ].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function internalRequest(req) {
  const address = String(req.socket?.remoteAddress || "").toLowerCase();
  const loopback = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  const supplied = String(req.headers["x-aiguka-internal-auth"] || "");
  const left = Buffer.from(supplied);
  const right = Buffer.from(INTERNAL_TOKEN);
  return loopback && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cookieOptions(req, maxAgeSeconds) {
  const secure = process.env.NODE_ENV === "production"
    || String(req.headers["x-forwarded-proto"] || "").split(",", 1)[0].trim() === "https";
  return {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: Math.max(0, Number(maxAgeSeconds || 0)) * 1000,
  };
}

function clearSession(res, req) {
  res.clearCookie(ACCESS_COOKIE, cookieOptions(req, 0));
  res.clearCookie(REFRESH_COOKIE, cookieOptions(req, 0));
  res.clearCookie(LOCAL_OWNER_COOKIE, cookieOptions(req, 0));
}

function saveSession(res, req, session) {
  res.cookie(
    ACCESS_COOKIE,
    String(session.access_token || ""),
    cookieOptions(req, Number(session.expires_in || DEFAULT_ACCESS_TTL_SECONDS)),
  );
  res.cookie(
    REFRESH_COOKIE,
    String(session.refresh_token || ""),
    cookieOptions(req, DEFAULT_REFRESH_TTL_SECONDS),
  );
}

function localOwnerEmail() {
  return String(process.env.AIGUKA_LOCAL_ADMIN_EMAIL || "").trim().toLowerCase();
}

function localOwnerConfigured() {
  return Boolean(
    localOwnerEmail()
    && String(process.env.AIGUKA_LOCAL_ADMIN_PASSWORD_SCRYPT || "").trim()
    && String(process.env.AIGUKA_LOCAL_ADMIN_SESSION_SECRET || "").trim(),
  );
}

function safeEqualBuffer(left, right) {
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function verifyLocalOwnerPassword(email, password) {
  if (!localOwnerConfigured()) return false;
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (normalizedEmail !== localOwnerEmail()) return false;
  const encoded = String(process.env.AIGUKA_LOCAL_ADMIN_PASSWORD_SCRYPT || "");
  const [scheme, saltHex, digestHex] = encoded.split("$");
  if (scheme !== "scrypt" || !/^[0-9a-f]{32}$/i.test(saltHex || "") || !/^[0-9a-f]{64}$/i.test(digestHex || "")) return false;
  try {
    const actual = crypto.scryptSync(String(password || ""), Buffer.from(saltHex, "hex"), 32, { N: 16384, r: 8, p: 1 });
    return safeEqualBuffer(actual, Buffer.from(digestHex, "hex"));
  } catch {
    return false;
  }
}

function localOwnerCookieValue(email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const encodedEmail = Buffer.from(normalizedEmail, "utf8").toString("base64url");
  const secret = String(process.env.AIGUKA_LOCAL_ADMIN_SESSION_SECRET || "");
  const signature = crypto.createHmac("sha256", secret).update(encodedEmail).digest("base64url");
  return `${encodedEmail}.${signature}`;
}

function verifyLocalOwnerCookie(value) {
  if (!localOwnerConfigured()) return null;
  const [encodedEmail, suppliedSignature] = String(value || "").split(".");
  if (!encodedEmail || !suppliedSignature) return null;
  let email = "";
  try { email = Buffer.from(encodedEmail, "base64url").toString("utf8").trim().toLowerCase(); }
  catch { return null; }
  if (email !== localOwnerEmail()) return null;
  const secret = String(process.env.AIGUKA_LOCAL_ADMIN_SESSION_SECRET || "");
  const expectedSignature = crypto.createHmac("sha256", secret).update(encodedEmail).digest("base64url");
  const left = Buffer.from(suppliedSignature);
  const right = Buffer.from(expectedSignature);
  return safeEqualBuffer(left, right) ? email : null;
}

function saveLocalOwnerSession(res, req, email) {
  res.cookie(LOCAL_OWNER_COOKIE, localOwnerCookieValue(email), cookieOptions(req, DEFAULT_REFRESH_TTL_SECONDS));
  res.clearCookie(ACCESS_COOKIE, cookieOptions(req, 0));
  res.clearCookie(REFRESH_COOKIE, cookieOptions(req, 0));
}

async function authRequest(supabaseUrl, publishableKey, path, request = {}) {
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...request,
    headers: {
      apikey: publishableKey,
      "content-type": "application/json",
      ...(request.headers || {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { message: text.slice(0, 300) }; }
  return { response, data };
}

async function getUser(supabaseUrl, publishableKey, accessToken) {
  const result = await authRequest(supabaseUrl, publishableKey, "/auth/v1/user", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  return result.response.ok ? result.data : null;
}

async function refreshSession(supabaseUrl, publishableKey, refreshToken) {
  const result = await authRequest(supabaseUrl, publishableKey, "/auth/v1/token?grant_type=refresh_token", {
    method: "POST",
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  return result.response.ok ? result.data : null;
}

function normalizedAllowedEmails() {
  return new Set(String(process.env.AIGUKA_AUTH_ALLOWED_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean));
}

function authorizedUser(user) {
  const allowed = normalizedAllowedEmails();
  if (allowed.size > 0) return allowed.has(String(user?.email || "").trim().toLowerCase());
  const role = String(user?.app_metadata?.role || "").trim().toLowerCase();
  return role === "admin" || role === "owner";
}

function loginHtml(next, error = "") {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Đăng nhập AIGUKA</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f7fb;color:#172033;font:14px Arial}.card{width:min(390px,calc(100vw - 32px));background:#fff;border:1px solid #d9e2ef;border-radius:14px;padding:24px;box-shadow:0 16px 45px #18315318}h1{margin:0 0 8px;font-size:24px}p{color:#667085}label{display:block;font-weight:700;margin-top:14px}input{box-sizing:border-box;width:100%;padding:11px;margin-top:6px;border:1px solid #b9c5d6;border-radius:8px}button{width:100%;margin-top:18px;padding:11px;border:0;border-radius:8px;background:#155eef;color:#fff;font-weight:700;cursor:pointer}.error{padding:10px;border-radius:8px;background:#fee4e2;color:#912018}</style></head><body><form class="card" method="post" action="/auth/login"><h1>AIGUKA Admin</h1><p>Đăng nhập bằng tài khoản quản trị AIGUKA hoặc Supabase được cấp quyền.</p>${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}<input type="hidden" name="next" value="${escapeHtml(safeNext(next))}"><label>Email<input name="email" type="email" autocomplete="username" required autofocus></label><label>Mật khẩu<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Đăng nhập</button></form></body></html>`;
}

export function installSupabaseAdminAuth(app, options = {}) {
  const supabaseUrl = String(options.supabaseUrl || process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const publishableKey = String(
    options.publishableKey || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "",
  );
  const configured = Boolean(supabaseUrl && publishableKey);
  const form = express.urlencoded({ extended: false, limit: "32kb" });

  app.get("/auth/login", (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.status(200).type("html").send(loginHtml(req.query.next));
  });

  app.post("/auth/login", form, async (req, res) => {
    res.setHeader("cache-control", "no-store");
    const next = safeNext(req.body?.next);
    const submittedEmail = String(req.body?.email || "").trim();
    const submittedPassword = String(req.body?.password || "");

    if (verifyLocalOwnerPassword(submittedEmail, submittedPassword)) {
      saveLocalOwnerSession(res, req, submittedEmail);
      res.redirect(303, next);
      return;
    }

    if (!configured) {
      res.status(503).type("html").send(loginHtml(next, "Supabase Auth chưa được cấu hình và tài khoản quản trị AIGUKA không hợp lệ."));
      return;
    }
    try {
      const result = await authRequest(supabaseUrl, publishableKey, "/auth/v1/token?grant_type=password", {
        method: "POST",
        body: JSON.stringify({ email: submittedEmail, password: submittedPassword }),
      });
      if (!result.response.ok || !result.data?.access_token) {
        res.status(401).type("html").send(loginHtml(next, "Email hoặc mật khẩu không đúng."));
        return;
      }
      const user = result.data.user || await getUser(supabaseUrl, publishableKey, result.data.access_token);
      if (!authorizedUser(user)) {
        clearSession(res, req);
        res.status(403).type("html").send(loginHtml(next, "Tài khoản chưa được cấp quyền quản trị AIGUKA."));
        return;
      }
      saveSession(res, req, result.data);
      res.redirect(303, next);
    } catch (error) {
      res.status(502).type("html").send(loginHtml(next, `Không kết nối được Supabase Auth: ${error instanceof Error ? error.message : String(error)}`));
    }
  });

  app.all("/auth/logout", async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const accessToken = cookies[ACCESS_COOKIE];
    clearSession(res, req);
    if (configured && accessToken) {
      void authRequest(supabaseUrl, publishableKey, "/auth/v1/logout", {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}` },
      }).catch(() => {});
    }
    res.redirect(303, "/auth/login");
  });

  app.use(async (req, res, next) => {
    if (publicRequest(req) || internalRequest(req)) return next();

    const cookies = parseCookies(req.headers.cookie);
    const localEmail = verifyLocalOwnerCookie(cookies[LOCAL_OWNER_COOKIE]);
    if (localEmail) {
      req.aigukaUser = { id: "local-owner", email: localEmail, app_metadata: { role: "owner" } };
      req.aigukaAccessToken = "";
      return next();
    }

    if (!configured) {
      res.setHeader("cache-control", "no-store");
      res.status(503).json({ ok: false, error: "SUPABASE_AUTH_NOT_CONFIGURED" });
      return;
    }
    try {
      let accessToken = cookies[ACCESS_COOKIE];
      let user = accessToken ? await getUser(supabaseUrl, publishableKey, accessToken) : null;
      if (!user && cookies[REFRESH_COOKIE]) {
        const session = await refreshSession(supabaseUrl, publishableKey, cookies[REFRESH_COOKIE]);
        if (session?.access_token) {
          saveSession(res, req, session);
          accessToken = session.access_token;
          user = session.user || await getUser(supabaseUrl, publishableKey, accessToken);
        }
      }
      if (user && authorizedUser(user)) {
        req.aigukaUser = user;
        req.aigukaAccessToken = accessToken;
        return next();
      }
      clearSession(res, req);
      if (wantsHtml(req)) {
        res.redirect(303, `/auth/login?next=${encodeURIComponent(safeNext(req.originalUrl || req.url))}`);
        return;
      }
      res.status(user ? 403 : 401).json({ ok: false, error: user ? "AIGUKA_ADMIN_FORBIDDEN" : "AUTH_REQUIRED" });
    } catch (error) {
      res.status(503).json({ ok: false, error: "AUTH_SERVICE_UNAVAILABLE", detail: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/auth/session", (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.status(200).json({
      ok: true,
      user: { id: req.aigukaUser.id, email: req.aigukaUser.email },
    });
  });
}

export const __private__ = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  LOCAL_OWNER_COOKIE,
  authorizedUser,
  internalRequest,
  parseCookies,
  publicRequest,
  safeNext,
  verifyLocalOwnerCookie,
  verifyLocalOwnerPassword,
};