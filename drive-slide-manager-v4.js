import crypto from "node:crypto";
import express from "express";

const clean = (value = "") => String(value ?? "").trim();
const esc = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
})[char]);
const idFromUrl = (value) => clean(value).match(/(?:folders\/|\/d\/|[?&]id=)([-\w]+)/)?.[1] || clean(value);
const isFolder = (mime = "") => mime === "application/vnd.google-apps.folder";
const isImage = (mime = "") => /^image\//i.test(mime);
const uniqueBy = (rows, keyFn) => [...new Map(rows.map((row) => [keyFn(row), row])).values()];
const folderRef = (value) => {
  if (typeof value === "string") return { id: idFromUrl(value), name: "", path: "", parent_id: null };
  return {
    id: idFromUrl(value?.id || value?.folder_id || value?.drive_folder_id || ""),
    name: clean(value?.name || value?.folder_name),
    path: clean(value?.path || value?.folder_path),
    parent_id: idFromUrl(value?.parent_id || value?.parent_folder_id || "") || null,
  };
};

export function installDriveSlideManagerV4(app, { supabaseUrl, publishableKey, serviceRoleKey }) {
  const dbKey = serviceRoleKey || publishableKey;
  if (!supabaseUrl || !dbKey) throw new Error("DRIVE_MANAGER_SUPABASE_NOT_CONFIGURED");
  const coreBase = clean(process.env.AIGUKA_V9_CORE_URL).replace(/\/$/, "");
  const coreKey = clean(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY);
  const encryptionKey = crypto.createHash("sha256").update(`${serviceRoleKey || dbKey}|${supabaseUrl}|AIGUKA_GOOGLE_DRIVE_OAUTH_V2`).digest();
  const encrypt = (value) => {
    if (!value) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
  };
  const decrypt = (value) => {
    if (!value) return "";
    const parts = String(value).split(".");
    if (parts.length !== 3) return String(value);
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(parts[0], "base64"));
    decipher.setAuthTag(Buffer.from(parts[1], "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], "base64")), decipher.final()]).toString("utf8");
  };
  const db = async (path, init = {}) => {
    const response = await fetch(`${String(supabaseUrl).replace(/\/$/, "")}/rest/v1/${path}`, {
      method: init.method || "GET",
      headers: {
        apikey: dbKey,
        authorization: `Bearer ${dbKey}`,
        "content-type": "application/json",
        prefer: init.prefer || "return=representation",
        ...(init.headers || {}),
      },
      body: init.body === undefined ? undefined : (typeof init.body === "string" ? init.body : JSON.stringify(init.body)),
      signal: AbortSignal.timeout(init.timeout || 30000),
      cache: "no-store",
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) throw new Error(data?.message || data?.hint || data?.error || `SUPABASE_${response.status}`);
    return data;
  };
  const coreDb = async (path) => {
    if (!coreBase || !coreKey) return [];
    const response = await fetch(`${coreBase}/rest/v1/${path}`, {
      headers: {
        apikey: coreKey,
        authorization: `Bearer ${coreKey}`,
      },
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) throw new Error(data?.message || data?.hint || data?.error || `CORE_${response.status}`);
    return data;
  };
  const getConnection = async () => (await db("v8_google_drive_connections?connection_key=eq.google_drive&select=*&limit=1"))?.[0] || null;
  const saveConnection = async (row) => (await db("v8_google_drive_connections?on_conflict=connection_key", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: { connection_key: "google_drive", ...row, updated_at: new Date().toISOString() },
  }))?.[0] || null;
  const runtimeGoogleClientId = clean(process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID);
  const runtimeGoogleClientSecret = clean(process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET);
  const modeOf = (row) => clean(row?.client_id) === "aiguka_v7_api_key" ? "api_key" : ((row?.client_id || runtimeGoogleClientId) ? "oauth" : "none");
  const apiKeyOf = (row) => modeOf(row) === "api_key" ? decrypt(row?.client_secret_ciphertext) : "";
  const oauthClientId = (row) => clean(row?.client_id === "aiguka_v7_api_key" ? "" : row?.client_id) || runtimeGoogleClientId;
  const oauthClientSecret = (row) => decrypt(row?.client_secret_ciphertext) || runtimeGoogleClientSecret;
  const publicConnection = (row) => ({
    mode: modeOf(row),
    configured: Boolean(row?.client_id && row?.client_secret_ciphertext),
    connected: row?.is_enabled !== false && ["connected", "configured"].includes(row?.connection_status) && Boolean(row?.root_folder_id || row?.refresh_token_ciphertext || row?.access_token_ciphertext),
    enabled: row?.is_enabled !== false,
    status: row?.connection_status || "not_configured",
    root_folder_id: row?.root_folder_id || "",
    account_email: row?.account_email || "",
    account_name: row?.account_name || "",
    api_key_hint: modeOf(row) === "api_key" ? row?.client_secret_hint || "" : "",
    oauth_client_hint: modeOf(row) === "oauth" ? oauthClientId(row) : "",
    oauth_ready: Boolean(oauthClientId(row) && oauthClientSecret(row)),
    last_error: row?.last_error || null,
    can_write: Boolean(row?.refresh_token_ciphertext || row?.access_token_ciphertext),
    last_checked_at: row?.last_checked_at || null,
  });
  const requestOrigin = (request) => clean(process.env.PUBLIC_BASE_URL).replace(/\/$/, "") || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `${request.get("x-forwarded-proto") || request.protocol || "https"}://${request.get("host")}`);
  const callbackUrl = (request) => `${requestOrigin(request)}/api/slide-manager/google/callback`;
  const signState = () => {
    const payload = Buffer.from(JSON.stringify({ t: Date.now(), n: crypto.randomBytes(10).toString("hex") })).toString("base64url");
    return `${payload}.${crypto.createHmac("sha256", encryptionKey).update(payload).digest("base64url")}`;
  };
  const verifyState = (state) => {
    const [payload, signature] = clean(state).split(".");
    if (!payload || !signature) return false;
    const expected = crypto.createHmac("sha256", encryptionKey).update(payload).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
    try { return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).t > Date.now() - 15 * 60_000; } catch { return false; }
  };
  const accessToken = async (row, force = false) => {
    if (!row || modeOf(row) !== "oauth" || row.is_enabled === false) return "";
    const current = decrypt(row.access_token_ciphertext);
    const expires = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;
    if (!force && current && expires > Date.now() + 90000) return current;
    const refresh = decrypt(row.refresh_token_ciphertext);
    if (!refresh) return current;
    const clientId = oauthClientId(row);
    const clientSecret = oauthClientSecret(row);
    if (!clientId || !clientSecret) throw new Error("Chưa có cấu hình OAuth Google của AIGUKA");
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: "refresh_token" }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || `GOOGLE_OAUTH_${response.status}`);
    await saveConnection({ access_token_ciphertext: encrypt(data.access_token), token_expires_at: new Date(Date.now() + Number(data.expires_in || 3600) * 1000).toISOString(), connection_status: "connected", last_error: null });
    return data.access_token;
  };
  const driveRequest = async (row, path, { method = "GET", body, query = {} } = {}) => {
    const apiKey = apiKeyOf(row);
    const token = await accessToken(row).catch(() => "");
    if (!apiKey && !token) throw new Error("Chưa cấu hình API key hoặc đăng nhập Google Drive");
    const params = new URLSearchParams(query);
    if (apiKey) params.set("key", apiKey);
    const response = await fetch(`https://www.googleapis.com/drive/v3/${path}${params.size ? `?${params}` : ""}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || `GOOGLE_DRIVE_${response.status}`);
    return data;
  };
  const verifyConnection = async (row) => {
    const root = idFromUrl(row?.root_folder_id);
    if (!root) throw new Error("Cần nhập link hoặc ID thư mục gốc");
    const info = await driveRequest(row, `files/${encodeURIComponent(root)}`, { query: { fields: "id,name,mimeType,webViewLink,owners(displayName,emailAddress)", supportsAllDrives: "true" } });
    if (!isFolder(info.mimeType)) throw new Error("ID đã nhập không phải thư mục Google Drive");
    return info;
  };
  const listFolder = async (row, folderId) => {
    const files = [];
    let pageTokenValue = "";
    let pages = 0;
    do {
      const result = await driveRequest(row, "files", {
        query: {
          q: `'${idFromUrl(folderId)}' in parents and trashed=false`,
          fields: "nextPageToken,files(id,name,mimeType,webViewLink,webContentLink,thumbnailLink,size,createdTime,modifiedTime,parents)",
          pageSize: "1000",
          orderBy: "folder,name",
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
          ...(pageTokenValue ? { pageToken: pageTokenValue } : {}),
        },
      });
      files.push(...(result.files || []));
      pageTokenValue = result.nextPageToken || "";
    } while (pageTokenValue && ++pages < 20);
    return files.sort((a, b) => Number(!isFolder(a.mimeType)) - Number(!isFolder(b.mimeType)) || String(a.name).localeCompare(String(b.name), "vi"));
  };
  const listFolderTree = async (row, rootFolderId, maxDepth = 7) => {
    const rootId = idFromUrl(rootFolderId);
    const rootInfo = await driveRequest(row, `files/${encodeURIComponent(rootId)}`, { query: { fields: "id,name,mimeType" } });
    const rows = [{ id: rootId, name: rootInfo.name || "Thư mục gốc", path: rootInfo.name || "Thư mục gốc", parent_id: null, depth: 0, direct_images: 0 }];
    const byId = new Map(rows.map((folder) => [folder.id, folder]));
    const queue = [{ id: rootId, path: rootInfo.name || "Thư mục gốc", depth: 0 }];
    const visited = new Set();
    while (queue.length && visited.size < 600) {
      const current = queue.shift();
      if (!current?.id || visited.has(current.id)) continue;
      visited.add(current.id);
      const children = await listFolder(row, current.id);
      const currentRow = byId.get(current.id);
      if (currentRow) currentRow.direct_images = children.filter((item) => isImage(item.mimeType)).length;
      for (const child of children.filter((item) => isFolder(item.mimeType))) {
        const next = { id: child.id, name: child.name, path: `${current.path} / ${child.name}`, parent_id: current.id, depth: current.depth + 1, direct_images: 0 };
        rows.push(next);
        byId.set(next.id, next);
        if (next.depth < maxDepth) queue.push(next);
      }
    }
    const childrenByParent = new Map();
    for (const folder of rows) {
      if (!folder.parent_id) continue;
      const children = childrenByParent.get(folder.parent_id) || [];
      children.push(folder.id);
      childrenByParent.set(folder.parent_id, children);
    }
    const memo = new Map();
    const summarize = (id, visiting = new Set()) => {
      if (memo.has(id)) return memo.get(id);
      if (visiting.has(id)) return { images: 0, descendants: 0 };
      const folder = byId.get(id);
      if (!folder) return { images: 0, descendants: 0 };
      let images = Number(folder.direct_images || 0);
      let descendants = 0;
      const nextVisiting = new Set(visiting).add(id);
      for (const childId of childrenByParent.get(id) || []) {
        const child = summarize(childId, nextVisiting);
        images += child.images;
        descendants += 1 + child.descendants;
      }
      const result = { images, descendants };
      memo.set(id, result);
      return result;
    };
    for (const folder of rows) {
      const summary = summarize(folder.id);
      folder.images = summary.images;
      folder.child_count = summary.descendants;
      folder.direct_child_count = (childrenByParent.get(folder.id) || []).length;
    }
    return rows;
  };
  const listImagesRecursive = async (row, rootFolderId, maxDepth = 7, rootLabel = "") => {
    const images = [];
    const rootPath = clean(rootLabel).replace(/\s*\/\s*/g, " / ");
    const rootName = rootPath.split(/\s*\/\s*/).filter(Boolean).at(-1) || "";
    const queue = [{ id: idFromUrl(rootFolderId), name: rootName, path: rootPath, parent_id: null, depth: 0 }];
    const visited = new Set();
    while (queue.length && visited.size < 800 && images.length < 3000) {
      const folder = queue.shift();
      if (!folder?.id || visited.has(folder.id)) continue;
      visited.add(folder.id);
      const items = await listFolder(row, folder.id);
      for (const item of items) {
        if (isFolder(item.mimeType) && folder.depth < maxDepth) queue.push({ id: item.id, name: item.name, path: folder.path ? `${folder.path} / ${item.name}` : item.name, parent_id: folder.id, depth: folder.depth + 1 });
        else if (isImage(item.mimeType)) images.push({ ...item, parent_folder_id: folder.id, parent_folder_name: folder.name, parent_folder_path: folder.path, parent_folder_parent_id: folder.parent_id });
      }
    }
    return { images, folders_scanned: visited.size };
  };
  const graphToken = () => process.env.META_PAGE_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN || process.env.META_USER_ACCESS_TOKEN || "";
  const pageToken = async (pageId) => {
    if (process.env.META_PAGE_ACCESS_TOKEN) return process.env.META_PAGE_ACCESS_TOKEN;
    const token = graphToken();
    if (!token) return "";
    const response = await fetch(`https://graph.facebook.com/v23.0/me/accounts?fields=id,access_token&limit=200&access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(25000) });
    const data = await response.json().catch(() => ({}));
    return (data.data || []).find((item) => String(item.id) === String(pageId))?.access_token || "";
  };
  const metaPermissionStatus = async (pageId) => {
    const active = (await db("v8_meta_oauth_connections?active=eq.true&select=facebook_user_name,granted_scopes,updated_at&order=updated_at.desc&limit=1").catch(() => []))?.[0] || null;
    const scopes = Array.isArray(active?.granted_scopes) ? active.granted_scopes : [];
    const hasMessaging = scopes.includes("pages_messaging") || Boolean(process.env.META_PAGE_ACCESS_TOKEN && process.env.META_ASSUME_PAGE_TOKEN_MESSAGING === "true");
    const token = pageId ? await pageToken(pageId).catch(() => "") : "";
    return {
      ok: hasMessaging && Boolean(token),
      page_id: pageId || null,
      has_page_token: Boolean(token),
      has_pages_messaging: hasMessaging,
      granted_scopes: scopes,
      facebook_user_name: active?.facebook_user_name || null,
      action_url: "/facebook-connect",
      message: !hasMessaging ? "Kết nối Facebook hiện chưa được cấp quyền pages_messaging. Hãy kết nối lại Facebook và đồng ý quyền nhắn tin Page." : (!token ? "Không tìm thấy Page Access Token của Page đã chọn." : "Page đã sẵn sàng gửi thử slide."),
    };
  };
  const router = express.Router();
  router.use(express.json({ limit: "10mb" }));
  router.get("/data", async (_req, res) => {
    try {
      const [mappings, assets, pages, connection] = await Promise.all([
        db("v8_slide_mapping?select=*&order=priority.asc,product_name.asc"),
        db("v8_drive_assets?select=*&deleted_from_drive_at=is.null&order=product_key.asc,sort_order.asc"),
        db("v8_pages?select=page_id,page_name,is_active,connection_status,webhook_status&is_active=eq.true&order=page_name.asc"),
        getConnection().catch(() => null),
      ]);
      res.json({ ok: true, mappings: mappings || [], assets: assets || [], pages: pages || [], drive_connection: publicConnection(connection), meta_connected: Boolean(graphToken()) });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });
  router.get("/drive/tree", async (req, res) => {
    try {
      const row = await getConnection();
      const rootId = idFromUrl(req.query.root_folder_id || row?.root_folder_id);
      if (!rootId) throw new Error("Chưa có thư mục gốc Google Drive");
      res.json({ ok: true, root_folder_id: rootId, folders: await listFolderTree(row, rootId) });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
  router.get("/drive/list", async (req, res) => {
    try {
      const row = await getConnection();
      const folderId = idFromUrl(req.query.folder_id || row?.root_folder_id);
      if (!folderId) throw new Error("Chưa có thư mục gốc");
      res.json({ ok: true, folder_id: folderId, items: await listFolder(row, folderId), connection: publicConnection(row) });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
  router.post("/google/api-key", async (req, res) => {
    try {
      const apiKey = clean(req.body?.api_key);
      const root = idFromUrl(req.body?.root_folder_id);
      const old = await getConnection();
      if (!apiKey && modeOf(old) !== "api_key") throw new Error("Cần nhập Google Drive API key");
      if (!root) throw new Error("Cần nhập link hoặc ID thư mục gốc");
      const row = { ...(old || {}), client_id: "aiguka_v7_api_key", client_secret_ciphertext: apiKey ? encrypt(apiKey) : old.client_secret_ciphertext, client_secret_hint: apiKey ? `••••${apiKey.slice(-6)}` : old.client_secret_hint, root_folder_id: root, is_enabled: true, connection_status: "configured", access_token_ciphertext: null, refresh_token_ciphertext: null, token_expires_at: null, last_error: null };
      const info = await verifyConnection(row);
      const saved = await saveConnection({ ...row, connection_status: "connected", account_name: info.name || "Google Drive", account_email: info.owners?.[0]?.emailAddress || null, last_checked_at: new Date().toISOString(), metadata: { connection_mode: "api_key", root_folder_name: info.name } });
      res.json({ ok: true, data: publicConnection(saved), root: info });
    } catch (error) {
      await saveConnection({ connection_status: "error", last_error: error.message }).catch(() => {});
      res.status(400).json({ ok: false, error: error.message });
    }
  });
  router.post("/google/oauth-config", async (req, res) => {
    try {
      const old = await getConnection();
      const clientId = clean(req.body?.client_id) || runtimeGoogleClientId;
      const secret = clean(req.body?.client_secret) || runtimeGoogleClientSecret;
      const root = idFromUrl(req.body?.root_folder_id || old?.root_folder_id);
      if (!clientId || !secret) throw new Error("AIGUKA chưa có cấu hình OAuth Google để cấp quyền ghi");
      const saved = await saveConnection({ client_id: clientId, client_secret_ciphertext: encrypt(secret), client_secret_hint: `••••${secret.slice(-4)}`, root_folder_id: root || null, is_enabled: true, connection_status: "configured", access_token_ciphertext: modeOf(old) === "oauth" ? old.access_token_ciphertext : null, refresh_token_ciphertext: modeOf(old) === "oauth" ? old.refresh_token_ciphertext : null, last_error: null });
      res.json({ ok: true, data: publicConnection(saved), callback_url: callbackUrl(req) });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
  router.get("/google/connect", async (req, res) => {
    try {
      const row = await getConnection();
      const clientId = oauthClientId(row);
      const secret = oauthClientSecret(row);
      if (!clientId || !secret) throw new Error("AIGUKA chưa có OAuth Google. API key chỉ đọc; muốn tạo/sửa/xóa thư mục cần cấu hình OAuth một lần.");
      if (!row?.root_folder_id) throw new Error("Chưa chọn thư mục gốc Google Drive");
      const params = new URLSearchParams({ client_id: clientId, redirect_uri: callbackUrl(req), response_type: "code", access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true", scope: "https://www.googleapis.com/auth/drive", state: signState() });
      res.json({ ok: true, authorization_url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
  router.get("/google/callback", async (req, res) => {
    try {
      if (req.query.error) throw new Error(clean(req.query.error_description || req.query.error));
      if (!verifyState(req.query.state)) throw new Error("Phiên đăng nhập Google không hợp lệ hoặc đã hết hạn");
      const row = await getConnection();
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: clean(req.query.code), client_id: oauthClientId(row), client_secret: oauthClientSecret(row), redirect_uri: callbackUrl(req), grant_type: "authorization_code" }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || `GOOGLE_OAUTH_${response.status}`);
      await saveConnection({ access_token_ciphertext: encrypt(data.access_token), refresh_token_ciphertext: data.refresh_token ? encrypt(data.refresh_token) : row.refresh_token_ciphertext, token_expires_at: new Date(Date.now() + Number(data.expires_in || 3600) * 1000).toISOString(), connection_status: "connected", is_enabled: true, last_error: null });
      res.redirect(302, "/drive-slides?tab=drive&google=connected");
    } catch (error) {
      await saveConnection({ connection_status: "error", last_error: error.message }).catch(() => {});
      res.redirect(302, `/drive-slides?tab=google&google=error&message=${encodeURIComponent(error.message)}`);
    }
  });
  router.post("/google/test", async (_req, res) => {
    try {
      const row = await getConnection();
      const info = await verifyConnection(row);
      const saved = await saveConnection({ connection_status: "connected", account_name: row.account_name || info.name, account_email: row.account_email || info.owners?.[0]?.emailAddress || null, last_checked_at: new Date().toISOString(), last_error: null });
      res.json({ ok: true, data: publicConnection(saved), root: info });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
  router.post("/drive/folder", async (req, res) => {
    try {
      const row = await getConnection();
      if (!publicConnection(row).can_write) {
        res.status(409).json({ ok: false, code: "GOOGLE_WRITE_LOGIN_REQUIRED", error: "Kết nối hiện tại là API key nên chỉ đọc. Hãy đăng nhập Google để bật quyền tạo, sửa và xóa thư mục.", action_url: "/api/slide-manager/google/connect" });
        return;
      }
      const name = clean(req.body?.name);
      if (!name) throw new Error("Cần nhập tên thư mục");
      const parentId = idFromUrl(req.body?.parent_id || row.root_folder_id);
      const data = await driveRequest(row, "files", { method: "POST", body: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }, query: { fields: "id,name,webViewLink,parents" } });
      res.json({ ok: true, data });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
  router.post("/mapping", async (req, res) => {
    try {
      const body = req.body || {};
      const productKey = clean(body.product_key);
      const productName = clean(body.product_name || productKey);
      const folders = uniqueBy((Array.isArray(body.drive_folder_ids) ? body.drive_folder_ids : []).map(folderRef).filter((item) => item.id), (item) => item.id);
      if (!productKey) throw new Error("Cần nhập mã sản phẩm");
      if (!productName) throw new Error("Cần nhập tên sản phẩm");
      if (!folders.length) throw new Error("Hãy chọn ít nhất một thư mục trong cây Google Drive");
      const primary = folders[0];
      const row = { page_id: clean(body.page_id) || null, product_key: productKey, product_name: productName, slide_title: clean(body.slide_title || `Slide ${productName}`), slide_url: `https://drive.google.com/drive/folders/${primary.id}`, drive_folder_url: `https://drive.google.com/drive/folders/${primary.id}`, drive_folder_id: primary.id, drive_folder_ids: folders, priority: Number(body.priority || 100), is_active: body.is_active !== false, note: clean(body.note) || null, updated_at: new Date().toISOString() };
      const result = body.id ? await db(`v8_slide_mapping?id=eq.${encodeURIComponent(body.id)}`, { method: "PATCH", body: row }) : await db("v8_slide_mapping", { method: "POST", body: row });
      res.json({ ok: true, data: result?.[0] || null });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
  router.delete("/mapping/:id", async (req, res) => {
    try { await db(`v8_slide_mapping?id=eq.${encodeURIComponent(req.params.id)}`, { method: "DELETE" }); res.json({ ok: true }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
  const syncAllState = {
    running: false,
    started_at: null,
    finished_at: null,
    force: false,
    stale_after_minutes: 15,
    total: 0,
    completed: 0,
    skipped: 0,
    mappings_synced: 0,
    images_synced: 0,
    folders_scanned: 0,
    errors: []
  };
  const syncAllSnapshot = () => ({ ...syncAllState, errors: [...syncAllState.errors] });
  const foldersForMapping = (mapping) => {
    const rawFolders = Array.isArray(mapping?.drive_folder_ids) && mapping.drive_folder_ids.length
      ? mapping.drive_folder_ids
      : [{ id: mapping?.drive_folder_id, name: mapping?.product_name, path: mapping?.product_name }];
    return uniqueBy(rawFolders.map(folderRef).filter((item) => item.id), (item) => item.id);
  };
  const markMappingSyncError = async (mappingId, error) => {
    if (!mappingId) return;
    await db(`v8_slide_mapping?id=eq.${encodeURIComponent(mappingId)}`, {
      method: "PATCH",
      body: { sync_status: "error", sync_error: error.message }
    }).catch(() => {});
  };
  const syncDriveMapping = async (row, mapping) => {
    const mappingId = clean(mapping?.id);
    if (!mappingId) throw new Error("Mapping không có ID");
    const folders = foldersForMapping(mapping);
    if (!folders.length) throw new Error("Mapping chưa chọn thư mục Drive");
    let foldersScanned = 0;
    const collected = [];
    for (const folder of folders) {
      const scan = await listImagesRecursive(row, folder.id, 7, folder.path || folder.name || mapping.product_name);
      foldersScanned += scan.folders_scanned;
      for (const item of scan.images) {
        collected.push({
          ...item,
          selected_root_id: folder.id,
          selected_root_name: folder.name,
          selected_root_path: folder.path
        });
      }
    }
    const images = uniqueBy(collected, (item) => item.id);
    let count = 0;
    for (const [index, item] of images.entries()) {
      const existing = await db(`v8_drive_assets?drive_file_id=eq.${encodeURIComponent(item.id)}&select=id,metadata&limit=1`);
      const assetRow = {
        product_key: mapping.product_key,
        product_name: mapping.product_name,
        catalog_key: mapping.product_key,
        root_folder_url: `https://drive.google.com/drive/folders/${item.selected_root_id}`,
        parent_folder_id: item.parent_folder_id || item.selected_root_id,
        parent_folder_name: item.parent_folder_name || item.selected_root_name || mapping.product_name || "",
        parent_folder_url: `https://drive.google.com/drive/folders/${item.parent_folder_id || item.selected_root_id}`,
        drive_file_id: item.id,
        file_name: item.name,
        mime_type: item.mimeType,
        file_url: item.webViewLink || `https://drive.google.com/file/d/${item.id}/view`,
        delivery_url: `https://drive.google.com/uc?export=view&id=${item.id}`,
        file_size: item.size ? Number(item.size) : null,
        created_time: item.createdTime || null,
        modified_time: item.modifiedTime || null,
        sort_order: index + 1,
        is_image: true,
        is_active: true,
        last_seen_at: new Date().toISOString(),
        deleted_from_drive_at: null,
        metadata: {
          ...(existing?.[0]?.metadata && typeof existing[0].metadata === "object" ? existing[0].metadata : {}),
          catalog_key: mapping.product_key,
          folder_path: item.parent_folder_path || item.selected_root_path || item.selected_root_name || mapping.product_name,
          folder_parent_id: item.parent_folder_parent_id || null,
          selected_root_folder_id: item.selected_root_id,
          selected_root_folder_path: item.selected_root_path || item.selected_root_name || mapping.product_name
        }
      };
      if (existing?.[0]?.id) {
        await db(`v8_drive_assets?id=eq.${encodeURIComponent(existing[0].id)}`, { method: "PATCH", body: assetRow });
      } else {
        await db("v8_drive_assets", { method: "POST", body: assetRow });
      }
      count++;
    }
    await db(`v8_slide_mapping?id=eq.${encodeURIComponent(mappingId)}`, {
      method: "PATCH",
      body: { sync_status: "success", last_synced_at: new Date().toISOString(), sync_error: null }
    });
    return {
      mapping_id: mappingId,
      product_key: mapping.product_key,
      product_name: mapping.product_name,
      synced: count,
      selected_folders: folders.length,
      folders_scanned: foldersScanned,
      total_items: images.length
    };
  };

  router.post("/drive/sync", async (req, res) => {
    const mappingId = clean(req.body?.mapping_id);
    try {
      const row = await getConnection();
      const mapping = (await db(`v8_slide_mapping?id=eq.${encodeURIComponent(mappingId)}&select=*&limit=1`))?.[0];
      if (!mapping) throw new Error("Không tìm thấy mapping");
      const result = await syncDriveMapping(row, mapping);
      res.json({ ok: true, ...result });
    } catch (error) {
      await markMappingSyncError(mappingId, error);
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  const runSyncAll = async ({ force, staleAfterMinutes }) => {
    const row = await getConnection();
    const mappings = await db("v8_slide_mapping?select=*&is_active=eq.true&order=priority.asc,product_name.asc");
    const syncable = (Array.isArray(mappings) ? mappings : []).filter((mapping) =>
      mapping?.is_active !== false && foldersForMapping(mapping).length
    );
    const cutoff = Date.now() - staleAfterMinutes * 60000;
    const queue = syncable.filter((mapping) => {
      if (force) return true;
      const lastSynced = Date.parse(mapping.last_synced_at || "");
      return String(mapping.sync_status || "").toLowerCase() !== "success"
        || !Number.isFinite(lastSynced)
        || lastSynced < cutoff;
    });
    syncAllState.total = queue.length;
    syncAllState.skipped = syncable.length - queue.length;
    for (const mapping of queue) {
      try {
        const result = await syncDriveMapping(row, mapping);
        syncAllState.mappings_synced += 1;
        syncAllState.images_synced += Number(result.synced || 0);
        syncAllState.folders_scanned += Number(result.folders_scanned || 0);
      } catch (error) {
        await markMappingSyncError(clean(mapping?.id), error);
        syncAllState.errors.push({
          mapping_id: clean(mapping?.id),
          product_key: clean(mapping?.product_key),
          product_name: clean(mapping?.product_name),
          error: error.message
        });
      } finally {
        syncAllState.completed += 1;
      }
    }
    syncAllState.running = false;
    syncAllState.finished_at = new Date().toISOString();
  };

  router.post("/drive/sync-all", async (req, res) => {
    if (syncAllState.running) {
      res.status(202).json({ ok: true, started: false, ...syncAllSnapshot() });
      return;
    }
    const force = req.body?.force === true;
    const staleAfterMinutes = Math.min(Math.max(Number(req.body?.stale_after_minutes || 15), 1), 1440);
    Object.assign(syncAllState, {
      running: true,
      started_at: new Date().toISOString(),
      finished_at: null,
      force,
      stale_after_minutes: staleAfterMinutes,
      total: 0,
      completed: 0,
      skipped: 0,
      mappings_synced: 0,
      images_synced: 0,
      folders_scanned: 0,
      errors: []
    });
    void runSyncAll({ force, staleAfterMinutes }).catch((error) => {
      syncAllState.running = false;
      syncAllState.finished_at = new Date().toISOString();
      syncAllState.errors.push({ error: error.message });
    });
    res.status(202).json({ ok: true, started: true, ...syncAllSnapshot() });
  });

  router.get("/drive/sync-all/status", (_req, res) => {
    res.json({ ok: true, ...syncAllSnapshot() });
  });

  router.get("/image/:id", async (req, res) => {
    try {
      const asset = (await db(`v8_drive_assets?id=eq.${encodeURIComponent(req.params.id)}&select=*&limit=1`))?.[0];
      if (!asset) throw new Error("Không tìm thấy ảnh");
      const row = await getConnection();
      const token = await accessToken(row).catch(() => "");
      const url = token ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(asset.drive_file_id)}?alt=media` : asset.delivery_url;
      const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, redirect: "follow", signal: AbortSignal.timeout(25000) });
      const type = response.headers.get("content-type") || "";
      if (!response.ok || !type.startsWith("image/")) throw new Error(`Ảnh không đọc được: HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      res.set({ "content-type": type, "cache-control": "public,max-age=300", "content-length": String(buffer.length) });
      res.send(buffer);
    } catch (error) { res.status(404).json({ ok: false, error: error.message }); }
  });
  router.get("/recipients", async (req, res) => {
    try {
      const pageId = clean(req.query.page_id);
      if (!pageId) throw new Error("Chưa chọn Page Facebook");
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const [legacyEvents, coreEvents, pancakeRows] = await Promise.all([
        db(`v8_meta_events?page_id=eq.${encodeURIComponent(pageId)}&sender_id=not.is.null&event_time=gte.${encodeURIComponent(since)}&select=page_id,sender_id,message_text,event_time&order=event_time.desc&limit=1500`),
        coreDb(`v9_events?page_id=eq.${encodeURIComponent(pageId)}&sender_id=not.is.null&actor_type=eq.customer&event_type=eq.customer_message&occurred_at=gte.${encodeURIComponent(since)}&select=page_id,sender_id,message_text,occurred_at&order=occurred_at.desc&limit=1500`).catch(() => []),
        db(`v8_pancake_conversation_cache?page_id=eq.${encodeURIComponent(pageId)}&last_customer_message_at=gte.${encodeURIComponent(since)}&select=page_id,customer_id,customer_name,last_customer_message_at&order=last_customer_message_at.desc&limit=1500`).catch(() => []),
      ]);
      const events = [
        ...(legacyEvents || []),
        ...(coreEvents || []).map((row) => ({ ...row, event_time: row.occurred_at })),
      ].sort((left, right) => Date.parse(right.event_time || 0) - Date.parse(left.event_time || 0));
      const names = new Map((pancakeRows || []).map((row) => [String(row.customer_id || ""), clean(row.customer_name)]));
      const seen = new Set();
      const recipients = [];
      for (const event of events || []) {
        const senderId = clean(event.sender_id);
        if (!/^\d{10,32}$/.test(senderId) || senderId === pageId || seen.has(senderId)) continue;
        seen.add(senderId);
        recipients.push({ page_id: pageId, sender_id: senderId, label: names.get(senderId) || `Khách …${senderId.slice(-6)}`, last_message: clean(event.message_text), last_message_at: event.event_time || null, source: names.has(senderId) ? "Meta + Pancake" : "Meta webhook" });
      }
      res.json({ ok: true, page_id: pageId, window_hours: 24, recipients });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
  router.get("/meta-status", async (req, res) => {
    try { res.json({ ok: true, data: await metaPermissionStatus(clean(req.query.page_id)) }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
  router.post("/test-slide", async (req, res) => {
    try {
      const pageId = clean(req.body?.page_id);
      const recipient = clean(req.body?.recipient_id);
      const mappingId = clean(req.body?.mapping_id);
      if (!pageId) throw new Error("Chưa chọn Page Facebook");
      if (!/^\d{10,32}$/.test(recipient)) throw new Error("Hãy chọn khách vừa nhắn Page trong danh sách tự động");
      const permission = await metaPermissionStatus(pageId);
      if (!permission.ok) { res.status(409).json({ ok: false, code: "META_PAGES_MESSAGING_REQUIRED", error: permission.message, action_url: permission.action_url, permission }); return; }
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const [recentLegacy, recentCore] = await Promise.all([
        db(`v8_meta_events?page_id=eq.${encodeURIComponent(pageId)}&sender_id=eq.${encodeURIComponent(recipient)}&event_time=gte.${encodeURIComponent(since)}&select=id,event_time&order=event_time.desc&limit=1`),
        coreDb(`v9_events?page_id=eq.${encodeURIComponent(pageId)}&sender_id=eq.${encodeURIComponent(recipient)}&actor_type=eq.customer&event_type=eq.customer_message&occurred_at=gte.${encodeURIComponent(since)}&select=id,occurred_at&order=occurred_at.desc&limit=1`).catch(() => []),
      ]);
      if (!recentLegacy?.length && !recentCore?.length) throw new Error("Khách không thuộc Page đã chọn hoặc đã ngoài cửa sổ 24 giờ");
      const mapping = (await db(`v8_slide_mapping?id=eq.${encodeURIComponent(mappingId)}&select=*&limit=1`))?.[0];
      if (!mapping) throw new Error("Không tìm thấy mapping");
      const assets = await db(`v8_drive_assets?product_key=eq.${encodeURIComponent(mapping.product_key)}&is_active=eq.true&deleted_from_drive_at=is.null&select=*&order=sort_order.asc&limit=10`);
      if (!assets?.length) throw new Error("Mapping chưa có ảnh; hãy đồng bộ thư mục Drive trước");
      const token = await pageToken(pageId);
      if (!token) throw new Error("Không tìm thấy Page Access Token");
      const results = [];
      for (const asset of assets) {
        const imageUrl = `${requestOrigin(req)}/api/slide-manager/image/${asset.id}`;
        const response = await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(pageId)}/messages?access_token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ recipient: { id: recipient }, messaging_type: "RESPONSE", message: { attachment: { type: "image", payload: { url: imageUrl, is_reusable: true } } } }),
          signal: AbortSignal.timeout(30000),
        });
        const data = await response.json().catch(() => ({}));
        let error = data.error?.message || `META_${response.status}`;
        if (Number(data.error?.code) === 230 || /pages_messaging/i.test(error)) error = "Kết nối Facebook chưa có quyền pages_messaging. Hãy kết nối lại Facebook rồi thử lại.";
        if (/cannot send messages to this id/i.test(error)) error = "PSID không thuộc Page đã chọn.";
        if (/outside.*24|24.hour|messaging window/i.test(error)) error = "Khách đã ngoài cửa sổ nhắn tin 24 giờ.";
        results.push(response.ok ? { ok: true, file_name: asset.file_name, message_id: data.message_id } : { ok: false, file_name: asset.file_name, error, meta_code: data.error?.code || null });
      }
      const success = results.filter((item) => item.ok).length;
      res.json({ ok: true, all_sent: success === results.length, total: results.length, success_count: success, failure_count: results.length - success, results });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
  app.use("/api/slide-manager", router);
  app.get("/drive-slides", (_req, res) => res.type("html").send(pageHtml()));
}

function pageHtml() {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mapping, Google Drive và chạy thử slide</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f7fb;color:#172033;font:14px Arial,sans-serif}.wrap{max-width:1540px;margin:auto;padding:20px}.top,.panel{background:#fff;border:1px solid #c8d5e5;border-radius:11px;padding:15px;margin-bottom:13px}.top{display:flex;justify-content:space-between;align-items:center}.tabs,.actions{display:flex;gap:7px;flex-wrap:wrap}.tabs{margin-bottom:13px}button,input,select{border:1px solid #b8c8dc;border-radius:6px;padding:8px;background:#fff;font:inherit}button{cursor:pointer}.active,.primary{background:#1e5fd5!important;color:#fff;border-color:#1e5fd5!important}.hide{display:none!important}.status,.notice,.card{padding:10px 12px;border:1px solid #86b4eb;background:#edf6ff;border-radius:7px}.status{margin-bottom:13px}.status.bad,.permission-bad{border-color:#ef9a9a;background:#fff0f0;color:#a61b1b}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}.wide{grid-column:span 2}.full{grid-column:1/-1}label{display:block;font-weight:700;font-size:12px;margin-bottom:5px}input,select{width:100%}table{width:100%;border-collapse:collapse}th,td{border:1px solid rgba(84,118,158,.34);padding:8px;text-align:left;vertical-align:top}th{background:rgba(46,91,145,.14);color:#1f3c61}tbody tr:nth-child(even){background:rgba(225,235,247,.28)}.table{overflow:auto}.card{background:#fbfdff;border-color:#c8d5e5}.tree{max-height:520px;overflow:auto}.drive-row{display:grid;grid-template-columns:32px 1fr auto;gap:8px;padding:8px;border-bottom:1px solid #dbe4ef;align-items:center}.muted{color:#667085}.preview{display:flex;gap:8px;flex-wrap:wrap}.preview figure{margin:0;width:105px;font-size:11px}.preview img{width:105px;height:75px;object-fit:cover;border-radius:5px;border:1px solid #c8d5e5}.folder-chip{display:inline-flex;margin:3px;padding:5px 8px;border-radius:999px;background:#e8f1ff;color:#184d9d}.folder-picker{position:fixed;inset:0;background:rgba(15,23,42,.42);display:flex;align-items:center;justify-content:center;padding:20px;z-index:50}.folder-picker-box{width:min(960px,96vw);max-height:88vh;overflow:auto;background:#fff;border-radius:12px;padding:16px}.folder-option{display:flex;gap:9px;padding:8px;border-bottom:1px solid #e0e8f2}.folder-option input{width:auto}.permission-good{border-color:#8fd1aa;background:#ecfbf2;color:#075c36}@media(max-width:900px){.grid{grid-template-columns:1fr}.wide,.full{grid-column:auto}}
</style></head><body><div class="wrap"><div class="top"><div><h1>Mapping, Google Drive và chạy thử slide</h1><div class="muted">Chọn trực tiếp thư mục Drive, đồng bộ ảnh và gửi thử qua Meta.</div></div><a href="/dashboard">Về bảng điều khiển</a></div><div id="status" class="status">Đang tải dữ liệu…</div><div class="tabs"><button class="active" data-tab="mapping">Mapping</button><button data-tab="drive">Thư mục & tệp Drive</button><button data-tab="test">Chạy thử slide</button><button data-tab="google">Kết nối Google Drive</button></div>
<section id="mapping" class="panel tab"><h2>Mapping sản phẩm → thư mục Drive</h2><div class="notice"><b>Không cần dán ID thư mục.</b> Bấm “Chọn thư mục Drive”, tích một hoặc nhiều thư mục cha/con.</div><form id="mapping-form" class="grid"><input type="hidden" name="id"><div><label>Mã sản phẩm</label><input name="product_key" required></div><div><label>Tên sản phẩm</label><input name="product_name" required></div><div><label>Page</label><select name="page_id" id="mapping-page"></select></div><div><label>Ưu tiên</label><input name="priority" type="number" value="100"></div><div class="full"><label>Thư mục Drive đã chọn</label><div id="selected-folders" class="card">Chưa chọn thư mục.</div><div class="actions" style="margin-top:7px"><button type="button" id="choose-folders" class="primary">Chọn thư mục Drive</button><button type="button" id="clear-folders">Bỏ chọn</button></div></div><div class="full"><label>Ghi chú</label><input name="note"></div><div class="actions"><button class="primary" type="submit">Lưu mapping</button><button type="button" id="mapping-new">+ Thêm mới</button></div></form><div class="table" style="margin-top:12px"><table><thead><tr><th>Sản phẩm</th><th>Thư mục đã chọn</th><th>Page</th><th>Số ảnh</th><th>Thao tác</th></tr></thead><tbody id="mapping-rows"></tbody></table></div></section>
<section id="drive" class="panel tab hide"><h2>Thư mục và tệp Google Drive</h2><div id="drive-connection" class="card"></div><div id="drive-write-note" class="notice"></div><div class="actions" style="margin:10px 0"><button id="drive-root">Về thư mục gốc</button><button id="drive-up">Lên một cấp</button><button id="drive-reload">Tải lại</button><input id="folder-new-name" style="width:240px" placeholder="Tên thư mục mới"><button id="folder-create" class="primary">+ Tạo thư mục</button></div><div id="breadcrumb" class="muted"></div><div id="drive-list" class="tree card"></div></section>
<section id="test" class="panel tab hide"><h2>Chạy thử slide</h2><div class="notice"><b>Không cần tìm ID Facebook.</b> Chọn Page và khách vừa nhắn Page trong 24 giờ.</div><div id="meta-permission" class="card">Đang kiểm tra quyền gửi tin…</div><div class="grid" style="margin-top:10px"><div><label>Page Facebook</label><select id="test-page"></select></div><div class="wide"><label>Khách vừa nhắn Page</label><select id="recipient"></select><div id="recipient-help" class="muted"></div></div><div><label>Mapping</label><select id="test-mapping"></select></div><div class="actions full"><button id="refresh-recipients" type="button">Làm mới khách</button><a id="reconnect-facebook" class="hide" href="/facebook-connect">Kết nối lại Facebook</a><button class="primary" id="run-test" type="button">Gửi thử</button></div></div><div id="preview" class="preview" style="margin-top:12px"></div><div id="test-result" class="card" style="margin-top:12px">Chưa chạy thử.</div></section>
<section id="google" class="panel tab hide"><h2>Kết nối Google Drive</h2><div class="notice"><b>API key:</b> đọc và đồng bộ. <b>Đăng nhập Google:</b> tạo/sửa/xóa thư mục.</div><div id="google-state" class="card"></div><div class="grid" style="margin-top:12px"><div class="wide"><label>Google Drive API key</label><input id="api-key" type="password"></div><div class="wide"><label>Link/ID thư mục gốc</label><input id="root-folder"></div><div class="actions full"><button class="primary" id="save-api-key">Lưu kết nối đọc</button><button id="test-connection">Kiểm tra</button><button id="login-google">Đăng nhập Google để cấp quyền ghi</button></div></div><details><summary>Cấu hình OAuth nâng cao</summary><div class="grid"><div class="wide"><label>OAuth Client ID</label><input id="oauth-client-id"></div><div class="wide"><label>OAuth Client Secret</label><input id="oauth-client-secret" type="password"></div><div class="wide"><label>Thư mục gốc</label><input id="oauth-root-folder"></div><div><button id="save-oauth">Lưu OAuth</button></div></div><div id="callback-info"></div></details></section>
<div id="folder-picker" class="folder-picker hide"><div class="folder-picker-box"><div class="top"><div><h2>Chọn thư mục Google Drive</h2><div class="muted">Tích nhiều thư mục; chọn thư mục cha sẽ quét toàn bộ thư mục con.</div></div><button id="close-folder-picker">Đóng</button></div><input id="folder-search" placeholder="Tìm thư mục…"><div class="actions"><button id="select-root-folder">Chọn thư mục gốc</button><button id="unselect-all-folders">Bỏ chọn tất cả</button><button id="apply-folders" class="primary">Áp dụng</button></div><div id="folder-tree" class="tree card">Đang tải…</div></div></div>
</div><script>
let D={mappings:[],assets:[],pages:[],recentRecipients:[],drive_connection:{}},folderStack=[],folderTree=[],selectedFolders=[],draftFolders=[];const $=id=>document.getElementById(id),E=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));function status(t,ok=true){$('status').textContent=t;$('status').className='status'+(ok?'':' bad')}async function api(path,opt={}){const r=await fetch('/api/slide-manager'+path,{...opt,headers:{'content-type':'application/json',...(opt.headers||{})}}),t=await r.text();let j;try{j=t?JSON.parse(t):{}}catch{j={error:t}}if(!r.ok||j.ok===false){const e=Error(j.error||'Có lỗi');e.data=j;throw e}return j}function tab(id){document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===id));document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('hide',x.id!==id));if(id==='test')Promise.all([loadRecipients(),loadMetaStatus()]).catch(x=>status(x.message,false))}function formData(f){return Object.fromEntries(new FormData(f).entries())}function normalizeFolders(x){return Array.isArray(x?.drive_folder_ids)&&x.drive_folder_ids.length?x.drive_folder_ids:(x?.drive_folder_id?[{id:x.drive_folder_id,name:x.product_name,path:x.product_name}]:[])}function renderSelected(){ $('selected-folders').innerHTML=selectedFolders.length?selectedFolders.map(x=>'<span class="folder-chip">📁 '+E(x.path||x.name||x.id)+'</span>').join(''):'Chưa chọn thư mục.' }function fresh(open=false){$('mapping-form').reset();$('mapping-form').elements.id.value='';$('mapping-form').elements.priority.value=100;selectedFolders=[];renderSelected();status('Đang tạo mapping mới.');if(open)openPicker()}function render(){const c=new Map();D.assets.filter(x=>x.is_active).forEach(x=>c.set(x.product_key,(c.get(x.product_key)||0)+1));$('mapping-rows').innerHTML=D.mappings.map(x=>'<tr><td><b>'+E(x.product_name)+'</b><br><small>'+E(x.product_key)+'</small></td><td>'+E(normalizeFolders(x).map(f=>f.path||f.name||f.id).join(' • '))+'</td><td>'+E(x.page_id||'Tất cả')+'</td><td>'+E(c.get(x.product_key)||0)+'</td><td><button data-edit="'+E(x.id)+'">Sửa</button> <button data-sync="'+E(x.id)+'">Đồng bộ</button> <button data-del="'+E(x.id)+'">Xóa</button></td></tr>').join('');$('mapping-page').innerHTML='<option value="">Tất cả Page</option>'+D.pages.map(x=>'<option value="'+E(x.page_id)+'">'+E(x.page_name)+'</option>').join('');$('test-page').innerHTML=D.pages.map(x=>'<option value="'+E(x.page_id)+'">'+E(x.page_name)+'</option>').join('');$('test-mapping').innerHTML=D.mappings.map(x=>'<option value="'+E(x.id)+'">'+E(x.product_name)+'</option>').join('');const g=D.drive_connection||{};$('google-state').innerHTML='<b>'+(g.connected?'Đã kết nối':'Chưa kết nối')+'</b> · '+E(g.mode||'')+(g.account_email?' · '+E(g.account_email):'');$('drive-connection').innerHTML=$('google-state').innerHTML;$('drive-write-note').innerHTML=g.can_write?'Đã có quyền tạo thư mục.':'API key chỉ đọc. Bấm tạo thư mục sẽ chuyển sang đăng nhập Google.';$('root-folder').value=g.root_folder_id||'';$('oauth-root-folder').value=g.root_folder_id||'';preview();renderSelected()}async function load(){D=await api('/data');render();await Promise.all([loadRecipients().catch(()=>{}),loadMetaStatus().catch(()=>{})]);if(D.drive_connection?.connected)await listFolder(D.drive_connection.root_folder_id,'Gốc');status('Đã tải '+D.mappings.length+' mapping.')}async function listFolder(id,name){const j=await api('/drive/list?folder_id='+encodeURIComponent(id));if(!folderStack.length||folderStack.at(-1).id!==id)folderStack.push({id,name:name||id});$('breadcrumb').textContent=folderStack.map(x=>x.name).join(' / ');$('drive-list').innerHTML=j.items.map(x=>'<div class="drive-row"><span>'+(x.mimeType==='application/vnd.google-apps.folder'?'📁':'🖼️')+'</span><div><b>'+E(x.name)+'</b></div><div>'+(x.mimeType==='application/vnd.google-apps.folder'?'<button data-open-folder="'+E(x.id)+'" data-folder-name="'+E(x.name)+'">Mở</button>':'<a target="_blank" href="'+E(x.webViewLink||'#')+'">Xem</a>')+'</div></div>').join('')}async function openPicker(){try{$('folder-picker').classList.remove('hide');draftFolders=selectedFolders.map(x=>({...x}));if(!folderTree.length)folderTree=(await api('/drive/tree')).folders||[];drawTree()}catch(x){status(x.message,false)}}function drawTree(){const q=$('folder-search').value.toLowerCase();$('folder-tree').innerHTML=folderTree.filter(x=>!q||String(x.path).toLowerCase().includes(q)).map(x=>'<label class="folder-option" style="padding-left:'+(8+x.depth*18)+'px"><input type="checkbox" data-folder-id="'+E(x.id)+'" '+(draftFolders.some(f=>f.id===x.id)?'checked':'')+'><span>📁 <b>'+E(x.name)+'</b><div class="muted">'+E(x.path)+'</div></span></label>').join('')}function preview(){const m=D.mappings.find(x=>x.id===$('test-mapping').value)||D.mappings[0];$('preview').innerHTML=D.assets.filter(x=>m&&x.product_key===m.product_key&&x.is_active).slice(0,10).map(x=>'<figure><img src="/api/slide-manager/image/'+E(x.id)+'"><figcaption>'+E(x.file_name)+'</figcaption></figure>').join('')}function time(v){return v?new Date(v).toLocaleString('vi-VN',{hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit'}):''}async function loadRecipients(){const p=$('test-page').value;if(!p)return;D.recentRecipients=(await api('/recipients?page_id='+encodeURIComponent(p))).recipients||[];$('recipient').innerHTML='<option value="">— Chọn khách —</option>'+D.recentRecipients.map(x=>'<option value="'+E(x.sender_id)+'">'+E(x.label)+' · '+E(time(x.last_message_at))+' · '+E(String(x.last_message||'').slice(0,45))+'</option>').join('');$('recipient-help').textContent='Có '+D.recentRecipients.length+' khách trong 24 giờ.'}async function loadMetaStatus(){const p=$('test-page').value;if(!p)return;const d=(await api('/meta-status?page_id='+encodeURIComponent(p))).data;$('meta-permission').className='card '+(d.ok?'permission-good':'permission-bad');$('meta-permission').innerHTML='<b>'+(d.ok?'Đã sẵn sàng':'Chưa đủ quyền')+'</b><div>'+E(d.message)+'</div>';$('reconnect-facebook').classList.toggle('hide',d.ok);$('run-test').disabled=!d.ok}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>tab(b.dataset.tab));$('mapping-new').onclick=()=>fresh(true);$('choose-folders').onclick=openPicker;$('clear-folders').onclick=()=>{selectedFolders=[];renderSelected()};$('close-folder-picker').onclick=()=>$('folder-picker').classList.add('hide');$('folder-search').oninput=drawTree;$('folder-tree').onchange=e=>{const b=e.target.closest('[data-folder-id]');if(!b)return;const f=folderTree.find(x=>x.id===b.dataset.folderId);if(b.checked){if(f&&!draftFolders.some(x=>x.id===f.id))draftFolders.push(f)}else draftFolders=draftFolders.filter(x=>x.id!==b.dataset.folderId)};$('select-root-folder').onclick=()=>{draftFolders=folderTree.filter(x=>x.depth===0);drawTree()};$('unselect-all-folders').onclick=()=>{draftFolders=[];drawTree()};$('apply-folders').onclick=()=>{selectedFolders=draftFolders.map(x=>({...x}));renderSelected();$('folder-picker').classList.add('hide')};$('mapping-form').onsubmit=async e=>{e.preventDefault();try{await api('/mapping',{method:'POST',body:JSON.stringify({...formData(e.currentTarget),drive_folder_ids:selectedFolders})});fresh();await load();status('Đã lưu mapping.')}catch(x){status(x.message,false)}};$('mapping-rows').onclick=async e=>{const b=e.target.closest('button');if(!b)return;try{if(b.dataset.edit){const x=D.mappings.find(v=>v.id===b.dataset.edit);fresh();Object.entries(x||{}).forEach(([k,v])=>{if($('mapping-form').elements[k])$('mapping-form').elements[k].value=v??''});selectedFolders=normalizeFolders(x);renderSelected()}else if(b.dataset.sync){const j=await api('/drive/sync',{method:'POST',body:JSON.stringify({mapping_id:b.dataset.sync})});status('Đã quét '+j.folders_scanned+' thư mục, đồng bộ '+j.synced+' ảnh.');await load()}else if(b.dataset.del&&confirm('Xóa mapping?')){await api('/mapping/'+b.dataset.del,{method:'DELETE'});await load()}}catch(x){status(x.message,false)}};$('drive-list').onclick=e=>{const b=e.target.closest('[data-open-folder]');if(b)listFolder(b.dataset.openFolder,b.dataset.folderName)};$('drive-root').onclick=()=>{folderStack=[];listFolder(D.drive_connection.root_folder_id,'Gốc')};$('drive-up').onclick=()=>{if(folderStack.length>1)folderStack.pop();const x=folderStack.pop()||{id:D.drive_connection.root_folder_id,name:'Gốc'};listFolder(x.id,x.name)};$('drive-reload').onclick=()=>listFolder(folderStack.at(-1)?.id||D.drive_connection.root_folder_id,folderStack.at(-1)?.name||'Gốc');$('folder-create').onclick=async()=>{try{const name=$('folder-new-name').value.trim();if(!name)throw Error('Nhập tên thư mục');const j=await api('/drive/folder',{method:'POST',body:JSON.stringify({name,parent_id:folderStack.at(-1)?.id})});status('Đã tạo '+j.data.name);folderTree=[];await listFolder(folderStack.at(-1)?.id,D.drive_connection.root_folder_id)}catch(x){if(x.data?.code==='GOOGLE_WRITE_LOGIN_REQUIRED')tab('google');status(x.message,false)}};$('save-api-key').onclick=async()=>{try{const j=await api('/google/api-key',{method:'POST',body:JSON.stringify({api_key:$('api-key').value,root_folder_id:$('root-folder').value})});D.drive_connection=j.data;folderTree=[];render();status('Đã kết nối Drive.')}catch(x){status(x.message,false)}};$('test-connection').onclick=()=>api('/google/test',{method:'POST'}).then(()=>status('Kết nối Drive hoạt động.')).catch(x=>status(x.message,false));$('save-oauth').onclick=async()=>{try{const j=await api('/google/oauth-config',{method:'POST',body:JSON.stringify({client_id:$('oauth-client-id').value,client_secret:$('oauth-client-secret').value,root_folder_id:$('oauth-root-folder').value})});$('callback-info').textContent=j.callback_url;status('Đã lưu OAuth.')}catch(x){status(x.message,false)}};$('login-google').onclick=async()=>{try{location.href=(await api('/google/connect')).authorization_url}catch(x){status(x.message,false)}};$('test-page').onchange=()=>Promise.all([loadRecipients(),loadMetaStatus()]).catch(x=>status(x.message,false));$('refresh-recipients').onclick=()=>loadRecipients().catch(x=>status(x.message,false));$('test-mapping').onchange=preview;$('run-test').onclick=async()=>{try{const j=await api('/test-slide',{method:'POST',body:JSON.stringify({page_id:$('test-page').value,recipient_id:$('recipient').value,mapping_id:$('test-mapping').value})});$('test-result').innerHTML='<b>Đã gửi '+j.success_count+'/'+j.total+' ảnh</b><br>'+j.results.map(x=>(x.ok?'✅ ':'❌ ')+E(x.file_name)+(x.error?' — '+E(x.error):'')).join('<br>');status(j.all_sent?'Gửi thử thành công.':'Có ảnh lỗi.',j.all_sent)}catch(x){$('test-result').innerHTML=E(x.message)+(x.data?.action_url?' · <a href="'+E(x.data.action_url)+'">Kết nối lại Facebook</a>':'');status(x.message,false)}};const q=new URLSearchParams(location.search);load().then(()=>{if(q.get('tab'))tab(q.get('tab'))}).catch(x=>status(x.message,false));
</script></body></html>`;
}
