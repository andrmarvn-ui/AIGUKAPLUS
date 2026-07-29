import crypto from "node:crypto";

const USERNAME = String(process.env.AIGUKA_V9_ADMIN_USER || "admin");
const SECRET = String(process.env.AIGUKA_V9_ADMIN_SECRET || process.env.AIGUKA_ADMIN_SECRET || "");

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function parseBasic(header) {
  const value = String(header || "");
  if (!value.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(value.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch { return null; }
}

export function installV9AdminAuth(app) {
  const guard = (req, res, next) => {
    if (!SECRET) {
      res.status(503).json({ ok: false, error: "V9_ADMIN_SECRET_NOT_CONFIGURED" });
      return;
    }
    const credentials = parseBasic(req.headers.authorization);
    if (!credentials || !safeEqual(credentials.username, USERNAME) || !safeEqual(credentials.password, SECRET)) {
      res.setHeader("www-authenticate", 'Basic realm="AIGUKA V9 Admin", charset="UTF-8"');
      res.status(401).json({ ok: false, error: "V9_ADMIN_AUTH_REQUIRED" });
      return;
    }
    next();
  };

  app.use(["/v9", "/v9-admin", "/v9-dashboard", "/api/v9"], guard);
}

export const __private__ = { parseBasic, safeEqual };
