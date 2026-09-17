import express from "express";

// AIGUKA admin UI is intentionally unlocked for the private Railway deployment.
// Keep this module as the compatibility entry point so the existing server wiring
// remains unchanged, while removing the interactive login gate completely.
const BYPASS_USER = {
  id: "local-owner",
  email: "aiguka-local-owner",
  app_metadata: { role: "owner" },
};

function safeNext(value) {
  const candidate = String(value || "").trim();
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.startsWith("/auth/")) return "/dashboard";
  return candidate;
}

function publicRequest(req) {
  const path = String(req.path || req.url || "").split("?", 1)[0].replace(/\/+$/, "") || "/";
  return path === "/health"
    || path === "/favicon.ico"
    || path === "/robots.txt"
    || path === "/__aiguka/verify-meta-signature"
    || path === "/auth/login"
    || path === "/auth/logout"
    || path.startsWith("/functions/v1/aiguka-v9-webhook")
    || path.startsWith("/functions/v1/aiguka-v8-webhook");
}

function internalRequest() {
  return false;
}

export function installSupabaseAdminAuth(app, _options = {}) {
  // /auth/login no longer displays a credential form.
  app.get("/auth/login", (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.redirect(303, safeNext(req.query.next));
  });

  // Preserve logout URL compatibility, but there is no login session to destroy.
  app.all("/auth/logout", (_req, res) => {
    res.setHeader("cache-control", "no-store");
    res.redirect(303, "/dashboard");
  });

  // Authentication is disabled for the admin UI. Keep the request identity shape
  // expected by existing admin modules so their behavior is otherwise unchanged.
  app.use((req, _res, next) => {
    req.aigukaUser = { ...BYPASS_USER };
    req.aigukaAccessToken = "";
    next();
  });

  app.get("/auth/session", (_req, res) => {
    res.setHeader("cache-control", "no-store");
    res.status(200).json({ ok: true, user: { id: BYPASS_USER.id, email: BYPASS_USER.email } });
  });
}

export const __private__ = {
  publicRequest,
  internalRequest,
  safeNext,
};
