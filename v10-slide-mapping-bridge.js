import express from "express";

const clean = (v = "") => String(v ?? "").trim();
const asArray = (v) => Array.isArray(v) ? v : [];
const uniq = (rows) => [...new Set(rows.filter(Boolean).map(String))];

export function installV10SlideMappingBridge(app, options = {}) {
  const base = clean(options.supabaseUrl || process.env.SUPABASE_URL).replace(/\/$/, "");
  const key = clean(options.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY);
  const driveKey = clean(process.env.GOOGLE_DRIVE_API_KEY);
  const publicBase = clean(process.env.PUBLIC_BASE_URL) || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");
  const defaultRoot = clean(process.env.GOOGLE_DRIVE_PRODUCTS_ROOT_ID);
  const metaVersion = clean(process.env.META_GRAPH_VERSION || "v23.0");
  const router = express.Router();
  router.use(express.json({ limit: "2mb" }));
  let syncState = { running: false, total: 0, completed: 0, mappings_synced: 0, images_synced: 0, folders_scanned: 0, skipped: 0, errors: [], started_at: null, finished_at: null };

  async function db(path, init = {}) {
    if (!base || !key) throw new Error("V10_DB_NOT_CONFIGURED");
    const response = await fetch(`${base}/rest/v1/${path}`, {
      method: init.method || "GET",
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        prefer: init.prefer || "return=representation",
        ...(init.headers || {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeout || 30000),
      cache: "no-store",
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
    if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `DB_${response.status}`);
    return data;
  }

  async function drive(path, query = {}) {
    if (!driveKey) throw new Error("GOOGLE_DRIVE_API_KEY_MISSING");
    const params = new URLSearchParams(query);
    params.set("key", driveKey);
    const response = await fetch(`https://www.googleapis.com/drive/v3/${path}?${params}`, { signal: AbortSignal.timeout(30000), cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || `DRIVE_${response.status}`);
    return data;
  }

  async function listFolder(folderId) {
    const rows = [];
    let pageToken = "";
    do {
      const data = await drive("files", {
        q: `'${folderId}' in parents and trashed=false`,
        fields: "nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,parents)",
        pageSize: "1000",
        orderBy: "folder,name",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        ...(pageToken ? { pageToken } : {}),
      });
      rows.push(...asArray(data.files));
      pageToken = clean(data.nextPageToken);
    } while (pageToken && rows.length < 5000);
    return rows;
  }

  async function scanFolder(rootId, maxDepth = 7) {
    const queue = [{ id: rootId, name: rootId, path: rootId, depth: 0 }];
    const visited = new Set();
    const images = [];
    const folders = [];
    while (queue.length && visited.size < 1000 && images.length < 5000) {
      const folder = queue.shift();
      if (!folder?.id || visited.has(folder.id)) continue;
      visited.add(folder.id);
      folders.push(folder);
      const items = await listFolder(folder.id);
      for (const item of items) {
        if (item.mimeType === "application/vnd.google-apps.folder" && folder.depth < maxDepth) {
          queue.push({ id: item.id, name: item.name, path: folder.path === rootId ? item.name : `${folder.path}/${item.name}`, depth: folder.depth + 1 });
        } else if (/^image\//i.test(item.mimeType || "")) {
          images.push({ ...item, folder_id: folder.id, folder_name: folder.name, folder_path: folder.path });
        }
      }
    }
    return { images, folders, folders_scanned: visited.size };
  }

  function imageUrl(fileId) {
    return publicBase ? `${publicBase}/api/slide-v10/image/${encodeURIComponent(fileId)}` : `https://drive.google.com/uc?export=view&id=${encodeURIComponent(fileId)}`;
  }

  async function upsertAsset(catalogKey, item, sortOrder) {
    const rows = await db("ai_assets?on_conflict=provider,external_id", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: {
        provider: "google_drive",
        external_id: item.id,
        folder_id: item.folder_id || null,
        file_name: item.name || null,
        mime_type: item.mimeType || null,
        source_url: imageUrl(item.id),
        thumbnail_url: imageUrl(item.id),
        file_size: item.size ? Number(item.size) : null,
        metadata: {
          drive_file_id: item.id,
          folder_id: item.folder_id || null,
          folder_name: item.folder_name || null,
          folder_path: item.folder_path || null,
          created_time: item.createdTime || null,
          modified_time: item.modifiedTime || null,
        },
        is_active: true,
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    });
    const asset = rows?.[0];
    if (!asset?.id) return null;
    await db("ai_catalog_assets?on_conflict=catalog_key,asset_id,asset_role", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: { catalog_key: catalogKey, asset_id: asset.id, asset_role: "slide", sort_order: sortOrder, metadata: { source: "drive_sync_v10" } },
    });
    return asset;
  }

  async function syncCatalog(catalog) {
    const folderIds = uniq(catalog?.metadata?.drive_folder_ids || catalog?.asset_policy?.drive_folder_ids || []);
    if (!folderIds.length) return { catalog_key: catalog.catalog_key, skipped: true, synced: 0, folders_scanned: 0 };
    await db(`ai_catalog_assets?catalog_key=eq.${encodeURIComponent(catalog.catalog_key)}&asset_role=eq.slide`, { method: "DELETE", prefer: "return=minimal" }).catch(() => null);
    let collected = [];
    let foldersScanned = 0;
    for (const folderId of folderIds) {
      const scan = await scanFolder(folderId);
      foldersScanned += scan.folders_scanned;
      collected.push(...scan.images);
    }
    const byId = new Map(collected.map((x) => [x.id, x]));
    collected = [...byId.values()];
    let synced = 0;
    for (let i = 0; i < collected.length; i += 1) {
      const asset = await upsertAsset(catalog.catalog_key, collected[i], i + 1);
      if (asset) synced += 1;
    }
    const metadata = { ...(catalog.metadata || {}), drive_folder_ids: folderIds, last_synced_at: new Date().toISOString(), sync_status: "success", synced_images: synced, folders_scanned: foldersScanned };
    await db(`ai_catalog_nodes?catalog_key=eq.${encodeURIComponent(catalog.catalog_key)}`, { method: "PATCH", body: { metadata, updated_at: new Date().toISOString() } });
    return { catalog_key: catalog.catalog_key, synced, folders_scanned: foldersScanned };
  }

  async function allCatalogs() {
    return asArray(await db("ai_catalog_nodes?select=*&is_active=eq.true&order=display_name.asc"));
  }

  async function syncAll(force = false) {
    if (syncState.running) return syncState;
    syncState = { running: true, total: 0, completed: 0, mappings_synced: 0, images_synced: 0, folders_scanned: 0, skipped: 0, errors: [], started_at: new Date().toISOString(), finished_at: null, force };
    const catalogs = (await allCatalogs()).filter((c) => uniq(c?.metadata?.drive_folder_ids || []).length);
    syncState.total = catalogs.length;
    for (const catalog of catalogs) {
      try {
        const last = Date.parse(catalog?.metadata?.last_synced_at || "");
        if (!force && Number.isFinite(last) && Date.now() - last < 15 * 60_000 && Number(catalog?.metadata?.synced_images || 0) > 0) {
          syncState.skipped += 1;
        } else {
          const result = await syncCatalog(catalog);
          if (!result.skipped) syncState.mappings_synced += 1;
          syncState.images_synced += Number(result.synced || 0);
          syncState.folders_scanned += Number(result.folders_scanned || 0);
        }
      } catch (error) {
        syncState.errors.push({ catalog_key: catalog.catalog_key, error: error.message });
      } finally {
        syncState.completed += 1;
      }
    }
    syncState.running = false;
    syncState.finished_at = new Date().toISOString();
    return syncState;
  }

  async function defaultPageId() {
    const pages = asArray(await db("v9_pages?select=page_id,operating_mode,is_active&is_active=eq.true&order=updated_at.desc"));
    return clean(pages.find((p) => p.operating_mode !== "OFF")?.page_id || pages[0]?.page_id);
  }

  async function pageToken(pageId) {
    const root = clean(process.env.META_ACCESS_TOKEN || process.env.META_USER_ACCESS_TOKEN || process.env.PAGE_ACCESS_TOKEN);
    if (process.env.META_PAGE_ACCESS_TOKEN) return clean(process.env.META_PAGE_ACCESS_TOKEN);
    if (!root) return "";
    const r = await fetch(`https://graph.facebook.com/${metaVersion}/me/accounts?fields=id,access_token&limit=200&access_token=${encodeURIComponent(root)}`, { signal: AbortSignal.timeout(20000) });
    const data = await r.json().catch(() => ({}));
    return clean(asArray(data.data).find((x) => String(x.id) === String(pageId))?.access_token);
  }

  async function assetsForCatalog(catalogKey, limit = 20) {
    const links = asArray(await db(`ai_catalog_assets?select=asset_id,sort_order&catalog_key=eq.${encodeURIComponent(catalogKey)}&asset_role=eq.slide&order=sort_order.asc&limit=${Math.max(1, Math.min(100, limit))}`));
    if (!links.length) return [];
    const ids = links.map((x) => x.asset_id).filter(Boolean);
    const rows = asArray(await db(`ai_assets?select=*&id=in.(${ids.join(",")})&is_active=eq.true`));
    const byId = new Map(rows.map((x) => [x.id, x]));
    return links.map((x) => byId.get(x.asset_id)).filter(Boolean);
  }

  async function resolveCatalog({ ad_id, message_text }) {
    const adId = clean(ad_id);
    if (adId) {
      const map = asArray(await db(`ai_ad_mappings?select=*&ad_id=eq.${encodeURIComponent(adId)}&is_active=eq.true&limit=1`))?.[0];
      if (map?.catalog_keys?.length) return clean(map.catalog_keys[0]);
    }
    const text = clean(message_text).toLocaleLowerCase("vi-VN");
    const catalogs = await allCatalogs();
    for (const c of catalogs) {
      const terms = [c.display_name, ...asArray(c.aliases)].map((x) => clean(x).toLocaleLowerCase("vi-VN")).filter(Boolean);
      if (terms.some((t) => text.includes(t))) return c.catalog_key;
    }
    return "";
  }

  router.get("/api/slide-v10/image/:id", async (req, res) => {
    try {
      if (!driveKey) throw new Error("GOOGLE_DRIVE_API_KEY_MISSING");
      const upstream = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(req.params.id)}?alt=media&key=${encodeURIComponent(driveKey)}`, { signal: AbortSignal.timeout(25000) });
      if (!upstream.ok) throw new Error(`DRIVE_IMAGE_${upstream.status}`);
      const type = upstream.headers.get("content-type") || "image/jpeg";
      const bytes = Buffer.from(await upstream.arrayBuffer());
      res.set({ "content-type": type, "cache-control": "public,max-age=3600", "content-length": String(bytes.length) });
      res.send(bytes);
    } catch (error) { res.status(404).json({ ok: false, error: error.message }); }
  });

  router.get("/api/v8-mapping-center/bootstrap", async (_req, res) => {
    try {
      const [pages, catalogs, adMappings, assets, links] = await Promise.all([
        db("v9_pages?select=*&is_active=eq.true&order=page_name.asc"),
        allCatalogs(),
        db("ai_ad_mappings?select=*&order=updated_at.desc&limit=2000"),
        db("ai_assets?select=*&is_active=eq.true&limit=10000"),
        db("ai_catalog_assets?select=*&asset_role=eq.slide&order=sort_order.asc&limit=10000"),
      ]);
      const linkByAsset = new Map(asArray(links).map((x) => [x.asset_id, x]));
      const folderMap = new Map();
      for (const asset of asArray(assets)) {
        const m = asset.metadata || {};
        if (!asset.folder_id) continue;
        const row = folderMap.get(asset.folder_id) || { folder_id: asset.folder_id, folder_name: m.folder_name || asset.folder_id, folder_path: m.folder_path || m.folder_name || asset.folder_id, parent_folder_id: null, direct_images: 0, images: 0, catalogs: [] };
        row.direct_images += 1; row.images += 1;
        const link = linkByAsset.get(asset.id); if (link?.catalog_key && !row.catalogs.includes(link.catalog_key)) row.catalogs.push(link.catalog_key);
        folderMap.set(asset.folder_id, row);
      }
      const slideMappings = asArray(catalogs).filter((c) => uniq(c?.metadata?.drive_folder_ids || []).length).map((c) => ({ id: c.catalog_key, product_key: c.catalog_key, product_name: c.display_name, page_id: null, drive_folder_ids: uniq(c.metadata.drive_folder_ids), drive_folder_id: uniq(c.metadata.drive_folder_ids)[0] || null, priority: Number(c.metadata?.priority || 100), is_active: c.is_active !== false, last_synced_at: c.metadata?.last_synced_at || null, sync_status: c.metadata?.sync_status || "idle", note: c.metadata?.note || null }));
      const mappings = asArray(adMappings).map((m) => ({ id: m.id, page_id: m.page_id, ad_account_id: m.ad_account_id, campaign_id: m.campaign_id, adset_id: m.adset_id, ad_id: m.ad_id, product_item_key: m.catalog_keys?.[0] || "", product_group: m.metadata?.product_group || "", ad_name: m.metadata?.ad_name || "", ad_account_name: m.metadata?.ad_account_name || "", campaign_name: m.metadata?.campaign_name || "", adset_name: m.metadata?.adset_name || "", selected_folders: m.metadata?.selected_folders || [], drive_folders: m.metadata?.selected_folders || [], notes: m.metadata?.notes || "", is_active: m.is_active !== false, enabled: m.is_active !== false, updated_at: m.updated_at }));
      const catalogRows = asArray(catalogs).map((c) => ({ catalog_key: c.catalog_key, catalog_name: c.display_name, parent_key: c.parent_key, root_product_key: c.root_key, is_active: c.is_active, is_sendable: true, metadata: c.metadata || {}, folder_path: null, drive_folder_id: uniq(c?.metadata?.drive_folder_ids || [])[0] || null }));
      res.json({ ok: true, version: "v10_core_mapping_bridge", pages: asArray(pages), runtime: [], groups: catalogRows.map((c, i) => ({ group_key: c.catalog_key, group_name: c.catalog_name, priority: i + 1, is_active: c.is_active })), catalogs: catalogRows, all_catalogs: catalogRows, mappings, slide_mappings: slideMappings, current_ads: [], ad_accounts: [], businesses: [], asset_summary: { folders: [...folderMap.values()], by_catalog: [] }, change_log: [], summary: { current_ads: 0, mapped_current_ads: 0, unmapped_current_ads: 0, total_mappings: mappings.length, active_images: asArray(assets).length }, warnings: [] });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });

  router.post("/api/v8-mapping-center/ad-mapping", async (req, res) => {
    try {
      const b = req.body || {};
      if (!clean(b.ad_id)) throw new Error("AD_ID_REQUIRED");
      const pageId = clean(b.page_id) || await defaultPageId() || null;
      const catalogKeys = uniq([clean(b.product_item_key), clean(b.product_group)].filter((x) => x && x !== "general"));
      const metadata = { ad_name: clean(b.ad_name), ad_account_name: clean(b.ad_account_name), campaign_name: clean(b.campaign_name), adset_name: clean(b.adset_name), product_group: clean(b.product_group), selected_folders: asArray(b.selected_folders), notes: clean(b.notes) };
      const rows = await db("ai_ad_mappings?on_conflict=page_id,ad_id", { method: "POST", prefer: "resolution=merge-duplicates,return=representation", body: { page_id: pageId, ad_account_id: clean(b.ad_account_id) || null, campaign_id: clean(b.campaign_id) || null, adset_id: clean(b.adset_id) || null, ad_id: clean(b.ad_id), catalog_keys: catalogKeys, confidence: 1, source: "manual_mapping_ui_v10", is_active: b.is_active !== false, metadata, updated_at: new Date().toISOString() } });
      res.json({ ok: true, saved: rows?.[0] || null });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  router.post("/api/v8-mapping-center/ad-mapping/disable", async (req, res) => {
    try { await db(`ai_ad_mappings?ad_id=eq.${encodeURIComponent(clean(req.body?.ad_id))}`, { method: "PATCH", body: { is_active: false, updated_at: new Date().toISOString() } }); res.json({ ok: true }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  router.post("/api/v8-mapping-center/slide-mapping", async (req, res) => {
    try {
      const b = req.body || {};
      const catalogKey = clean(b.product_key);
      if (!catalogKey) throw new Error("CATALOG_REQUIRED");
      const row = asArray(await db(`ai_catalog_nodes?select=*&catalog_key=eq.${encodeURIComponent(catalogKey)}&limit=1`))?.[0];
      if (!row) throw new Error("CATALOG_NOT_FOUND");
      const metadata = { ...(row.metadata || {}), drive_folder_ids: uniq(asArray(b.drive_folder_ids).map((x) => typeof x === "string" ? x : x?.id).filter(Boolean).concat(clean(b.drive_folder_id) ? [clean(b.drive_folder_id)] : [])), priority: Number(b.priority || 100), note: clean(b.note), sync_status: b.request_sync ? "requested" : (row.metadata?.sync_status || "idle") };
      await db(`ai_catalog_nodes?catalog_key=eq.${encodeURIComponent(catalogKey)}`, { method: "PATCH", body: { display_name: clean(b.product_name) || row.display_name, metadata, is_active: b.is_active !== false, updated_at: new Date().toISOString() } });
      res.json({ ok: true, saved: { id: catalogKey, product_key: catalogKey, product_name: clean(b.product_name) || row.display_name, drive_folder_ids: metadata.drive_folder_ids, drive_folder_id: metadata.drive_folder_ids[0] || null, priority: metadata.priority, note: metadata.note, is_active: b.is_active !== false, sync_status: metadata.sync_status } });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  router.post("/api/v8-mapping-center/runtime", async (req, res) => {
    try {
      const b = req.body || {}; const pageId = clean(b.page_id); if (!pageId) throw new Error("PAGE_ID_REQUIRED");
      const row = asArray(await db(`v9_pages?select=settings&page_id=eq.${encodeURIComponent(pageId)}&limit=1`))?.[0] || { settings: {} };
      await db(`v9_pages?page_id=eq.${encodeURIComponent(pageId)}`, { method: "PATCH", body: { settings: { ...(row.settings || {}), mapping_runtime: b }, updated_at: new Date().toISOString() } });
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  router.post("/api/v8-mapping-center/test", async (req, res) => {
    try {
      const b = req.body || {}; const catalogKey = await resolveCatalog(b); const assets = catalogKey ? await assetsForCatalog(catalogKey, 20) : [];
      res.json({ ok: true, result: { status: catalogKey ? "catalog" : "unresolved", source: catalogKey ? "v10_core_mapping" : "none", confidence: catalogKey ? 1 : 0, catalog_key: catalogKey || null, group_key: catalogKey || null, apply_to_runtime: Boolean(catalogKey), conflict: false, needs_clarification: !catalogKey, slide_asset_count: assets.length }, preview_assets: assets.map((a) => ({ id: a.id, file_name: a.file_name, delivery_url: a.source_url, file_url: a.source_url, catalog_key: catalogKey })) });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  router.get("/api/slide-manager/drive/tree", async (_req, res) => {
    try {
      const roots = defaultRoot ? [defaultRoot] : uniq((await allCatalogs()).flatMap((c) => c?.metadata?.drive_folder_ids || []));
      const folders = [];
      for (const root of roots) { const scan = await scanFolder(root, 5); folders.push(...scan.folders.map((f) => ({ folder_id: f.id, folder_name: f.name, folder_path: f.path, parent_folder_id: null, direct_images: 0, images: 0 }))); }
      const unique = [...new Map(folders.map((f) => [f.folder_id, f])).values()];
      res.json({ ok: true, root_folder_id: defaultRoot || null, folders: unique });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  router.post("/api/slide-manager/drive/sync", async (req, res) => {
    try { const key = clean(req.body?.mapping_id); const catalog = asArray(await db(`ai_catalog_nodes?select=*&catalog_key=eq.${encodeURIComponent(key)}&limit=1`))?.[0]; if (!catalog) throw new Error("CATALOG_NOT_FOUND"); res.json({ ok: true, mapping_id: key, ...(await syncCatalog(catalog)) }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  router.post("/api/slide-manager/drive/sync-all", async (req, res) => {
    if (syncState.running) return res.status(202).json({ ok: true, started: false, ...syncState });
    void syncAll(req.body?.force === true);
    res.status(202).json({ ok: true, started: true, ...syncState });
  });
  router.get("/api/slide-manager/drive/sync-all/status", (_req, res) => res.json({ ok: true, ...syncState }));

  router.get("/api/slide-manager/recipients", async (req, res) => {
    try {
      const pageId = clean(req.query.page_id); if (!pageId) throw new Error("PAGE_ID_REQUIRED");
      const since = new Date(Date.now() - 24 * 3600000).toISOString();
      const events = asArray(await db(`v9_events?select=page_id,sender_id,message_text,occurred_at&page_id=eq.${encodeURIComponent(pageId)}&actor_type=eq.customer&event_type=eq.customer_message&occurred_at=gte.${encodeURIComponent(since)}&order=occurred_at.desc&limit=1000`));
      const seen = new Set(); const recipients = [];
      for (const e of events) { const id = clean(e.sender_id); if (!id || seen.has(id)) continue; seen.add(id); recipients.push({ page_id: pageId, sender_id: id, label: `Khách …${id.slice(-6)}`, last_message: e.message_text, last_message_at: e.occurred_at, source: "V10 webhook" }); }
      res.json({ ok: true, page_id: pageId, window_hours: 24, recipients });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  router.get("/api/slide-manager/meta-status", async (req, res) => {
    try { const token = await pageToken(clean(req.query.page_id)); res.json({ ok: true, data: { ok: Boolean(token), page_id: clean(req.query.page_id), has_page_token: Boolean(token), has_pages_messaging: Boolean(token), granted_scopes: [], action_url: "/facebook-connect", message: token ? "Page sẵn sàng gửi slide." : "Không tìm thấy Page Access Token." } }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  router.post("/api/slide-manager/test-slide", async (req, res) => {
    try {
      const pageId = clean(req.body?.page_id); const recipient = clean(req.body?.recipient_id); const catalogKey = clean(req.body?.mapping_id);
      if (!pageId || !recipient || !catalogKey) throw new Error("PAGE_RECIPIENT_CATALOG_REQUIRED");
      const token = await pageToken(pageId); if (!token) throw new Error("PAGE_ACCESS_TOKEN_MISSING");
      const assets = (await assetsForCatalog(catalogKey, 10)).slice(0, 10); if (!assets.length) throw new Error("CATALOG_HAS_NO_ASSETS");
      const catalog = asArray(await db(`ai_catalog_nodes?select=display_name&catalog_key=eq.${encodeURIComponent(catalogKey)}&limit=1`))?.[0];
      const elements = assets.map((a, i) => ({ title: `${catalog?.display_name || catalogKey} — Mẫu ${String(i + 1).padStart(2, "0")}`.slice(0, 80), image_url: a.source_url, subtitle: clean(a.file_name || `Mẫu ${i + 1}`).slice(0, 80), default_action: { type: "web_url", url: a.source_url, webview_height_ratio: "full" } }));
      const response = await fetch(`https://graph.facebook.com/${metaVersion}/${encodeURIComponent(pageId)}/messages?access_token=${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recipient: { id: recipient }, messaging_type: "RESPONSE", message: { attachment: { type: "template", payload: { template_type: "generic", image_aspect_ratio: "square", elements } } } }), signal: AbortSignal.timeout(30000) });
      const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data?.error?.message || `META_${response.status}`);
      res.json({ ok: true, all_sent: true, delivery_type: "generic_template", message_count: 1, slide_count: elements.length, message_id: data.message_id || null, recipient_id: data.recipient_id || recipient });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  router.get("/api/slide-manager/data", async (_req, res) => { try { const catalogs = await allCatalogs(); res.json({ ok: true, mappings: catalogs.filter((c) => uniq(c?.metadata?.drive_folder_ids || []).length), assets: await db("ai_assets?select=*&is_active=eq.true&limit=10000"), pages: await db("v9_pages?select=*&is_active=eq.true"), drive_connection: { configured: Boolean(driveKey), connected: Boolean(driveKey), enabled: Boolean(driveKey), status: driveKey ? "connected" : "not_configured", root_folder_id: defaultRoot, can_write: false }, meta_connected: Boolean(process.env.META_ACCESS_TOKEN) }); } catch (error) { res.status(500).json({ ok: false, error: error.message }); } });

  app.use(router);

  // Record a non-secret V10 Drive connection marker and rebuild assets automatically.
  void (async () => {
    try {
      await db("ai_drive_connections?on_conflict=connection_key", { method: "POST", prefer: "resolution=merge-duplicates,return=representation", body: { connection_key: "google_drive", root_folder_id: defaultRoot || null, account_name: "Google Drive Products", is_enabled: Boolean(driveKey), connection_status: driveKey ? "connected" : "not_configured", metadata: { source: "railway_env_v10", api_key_present: Boolean(driveKey) }, last_verified_at: new Date().toISOString(), updated_at: new Date().toISOString() } });
      if (driveKey) setTimeout(() => { void syncAll(false); }, 5000);
    } catch (error) { console.error("[AIGUKA V10 slide bridge] bootstrap:", error.message); }
  })();

  console.log("[AIGUKA V10 slide bridge] Core mapping/Drive/Test Slide routes installed");
}
