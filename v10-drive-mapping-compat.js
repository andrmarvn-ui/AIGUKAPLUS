import express from "express";

const clean = (v = "") => String(v ?? "").trim();
const norm = (v = "") => clean(v).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const uniq = (rows) => [...new Set((rows || []).filter(Boolean))];
const chunks = (rows, size = 100) => { const out = []; for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size)); return out; };

export function installV10DriveMappingCompat(app, options = {}) {
  const base = clean(options.supabaseUrl || process.env.SUPABASE_URL).replace(/\/$/, "");
  const serviceKey = clean(process.env.SUPABASE_SERVICE_ROLE_KEY || options.serviceRoleKey);
  const driveKey = clean(process.env.GOOGLE_DRIVE_API_KEY);
  const rootFolderId = clean(process.env.GOOGLE_DRIVE_PRODUCTS_ROOT_ID);
  const publicBase = clean(process.env.PUBLIC_BASE_URL).replace(/\/$/, "") || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "https://aigukaplus.up.railway.app");
  const graphVersion = clean(process.env.META_GRAPH_VERSION || "v23.0");
  const syncState = { running: false, started_at: null, finished_at: null, total: 0, completed: 0, folders_scanned: 0, images_synced: 0, mappings_synced: 0, skipped: 0, errors: [] };

  if (!base || !serviceKey) {
    console.warn("[AIGUKA V10 Drive] disabled: Supabase service credential missing");
    return;
  }

  async function rest(path, init = {}) {
    const response = await fetch(`${base}/rest/v1/${path}`, {
      method: init.method || "GET",
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
        prefer: init.prefer || "return=representation",
        ...(init.headers || {}),
      },
      body: init.body === undefined ? undefined : (typeof init.body === "string" ? init.body : JSON.stringify(init.body)),
      signal: AbortSignal.timeout(init.timeout || 45000),
      cache: "no-store",
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
    if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `SUPABASE_${response.status}`);
    return data;
  }

  async function ensureConnection() {
    const existing = (await rest("ai_drive_connections?connection_key=eq.google_drive&select=*&limit=1"))?.[0] || null;
    if (existing) return existing;
    if (!driveKey || !rootFolderId) return null;
    const row = {
      connection_key: "google_drive",
      client_id: "aiguka_v10_env_api_key",
      client_secret_ciphertext: null,
      client_secret_hint: `••••${driveKey.slice(-6)}`,
      root_folder_id: rootFolderId,
      is_enabled: true,
      connection_status: "configured",
      metadata: { connection_mode: "env_api_key", secret_source: "railway_env" },
      last_error: null,
      updated_at: new Date().toISOString(),
    };
    return (await rest("ai_drive_connections?on_conflict=connection_key", { method: "POST", prefer: "resolution=merge-duplicates,return=representation", body: row }))?.[0] || row;
  }

  async function driveJson(path, query = {}) {
    if (!driveKey) throw new Error("GOOGLE_DRIVE_API_KEY_MISSING");
    const params = new URLSearchParams({ ...query, key: driveKey });
    const response = await fetch(`https://www.googleapis.com/drive/v3/${path}?${params}`, { signal: AbortSignal.timeout(30000), cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || `GOOGLE_DRIVE_${response.status}`);
    return data;
  }

  async function verifyDrive() {
    const conn = await ensureConnection();
    const root = clean(conn?.root_folder_id || rootFolderId);
    if (!root) throw new Error("GOOGLE_DRIVE_ROOT_MISSING");
    const info = await driveJson(`files/${encodeURIComponent(root)}`, { fields: "id,name,mimeType,webViewLink", supportsAllDrives: "true" });
    if (info.mimeType !== "application/vnd.google-apps.folder") throw new Error("GOOGLE_DRIVE_ROOT_NOT_FOLDER");
    await rest("ai_drive_connections?connection_key=eq.google_drive", { method: "PATCH", body: { connection_status: "connected", account_name: info.name || "Google Drive", last_verified_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() } }).catch(() => {});
    return { conn, root, info };
  }

  async function listChildren(folderId) {
    const rows = [];
    let pageToken = "";
    let pages = 0;
    do {
      const data = await driveJson("files", {
        q: `'${folderId}' in parents and trashed=false`,
        fields: "nextPageToken,files(id,name,mimeType,webViewLink,thumbnailLink,size,createdTime,modifiedTime,parents)",
        pageSize: "1000",
        orderBy: "folder,name",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        ...(pageToken ? { pageToken } : {}),
      });
      rows.push(...(data.files || []));
      pageToken = data.nextPageToken || "";
      pages += 1;
    } while (pageToken && pages < 20);
    return rows;
  }

  async function scanDrive(maxDepth = 8) {
    const { root, info } = await verifyDrive();
    const folders = [{ id: root, name: info.name || "Google Drive", path: info.name || "Google Drive", parent_id: null, depth: 0, direct_images: 0 }];
    const images = [];
    const queue = [{ id: root, name: info.name || "Google Drive", path: info.name || "Google Drive", parent_id: null, depth: 0, ancestors: [root] }];
    const visited = new Set();
    while (queue.length && visited.size < 1200 && images.length < 12000) {
      const folder = queue.shift();
      if (!folder || visited.has(folder.id)) continue;
      visited.add(folder.id);
      const children = await listChildren(folder.id);
      const folderRow = folders.find((x) => x.id === folder.id);
      if (folderRow) folderRow.direct_images = children.filter((x) => /^image\//i.test(x.mimeType || "")).length;
      for (const item of children) {
        if (item.mimeType === "application/vnd.google-apps.folder") {
          const next = { id: item.id, name: item.name, path: `${folder.path} / ${item.name}`, parent_id: folder.id, depth: folder.depth + 1, ancestors: [...folder.ancestors, item.id], direct_images: 0 };
          folders.push(next);
          if (next.depth < maxDepth) queue.push(next);
        } else if (/^image\//i.test(item.mimeType || "")) {
          images.push({ ...item, folder_id: folder.id, folder_name: folder.name, folder_path: folder.path, ancestors: folder.ancestors });
        }
      }
    }
    return { root, root_name: info.name || "Google Drive", folders, images, folders_scanned: visited.size };
  }

  function catalogTerms(row) {
    const terms = [row.display_name, row.catalog_key?.replace(/_/g, " "), ...(Array.isArray(row.aliases) ? row.aliases : [])].map(norm).filter((x) => x.length >= 3);
    return uniq(terms);
  }

  function scoreCatalog(catalog, image, selectedFolderIds = []) {
    if (selectedFolderIds.length && image.ancestors?.some((id) => selectedFolderIds.includes(id))) return 10000 + selectedFolderIds.length;
    const path = norm(image.folder_path);
    const leaf = norm(image.folder_name);
    const file = norm(image.name);
    let best = 0;
    for (const term of catalogTerms(catalog)) {
      if (leaf === term) best = Math.max(best, 900 + term.length);
      if (leaf.includes(term) || term.includes(leaf)) best = Math.max(best, 650 + term.length);
      if (path.includes(term)) best = Math.max(best, 500 + term.length);
      if (file.includes(term)) best = Math.max(best, 350 + term.length);
    }
    const key = clean(catalog.catalog_key);
    if (key === "voi_lavabo" && /voi.*(lavabo|chau)/.test(path)) best += 120;
    if (key === "voi_rua_bat" && /(voi.*(rua bat|bep)|bep.*voi)/.test(path)) best += 120;
    if (key === "phu_kien_nha_tam" && /(phu kien.*(tam|ve sinh)|nha tam.*phu kien)/.test(path)) best += 100;
    if (key === "phu_kien_inox_bep" && /(phu kien.*bep|inox.*bep|gia bat)/.test(path)) best += 100;
    if (key === "quat_den" && /(quat|den chum|den trang tri)/.test(path)) best += 100;
    return best;
  }

  function folderPolicy(catalog) {
    const meta = catalog?.metadata && typeof catalog.metadata === "object" ? catalog.metadata : {};
    const policy = catalog?.asset_policy && typeof catalog.asset_policy === "object" ? catalog.asset_policy : {};
    const raw = policy.drive_folder_ids || meta.drive_folder_ids || meta.selected_drive_folder_ids || [];
    return uniq((Array.isArray(raw) ? raw : [raw]).map((x) => typeof x === "string" ? x : x?.id).filter(Boolean));
  }

  async function syncAllDriveAssets({ force = false } = {}) {
    if (syncState.running) return { ...syncState };
    Object.assign(syncState, { running: true, started_at: new Date().toISOString(), finished_at: null, total: 0, completed: 0, folders_scanned: 0, images_synced: 0, mappings_synced: 0, skipped: 0, errors: [] });
    try {
      const [scan, catalogs] = await Promise.all([
        scanDrive(),
        rest("ai_catalog_nodes?select=*&is_active=eq.true&order=display_name.asc"),
      ]);
      syncState.folders_scanned = scan.folders_scanned;
      syncState.total = scan.images.length;
      const assignments = [];
      const assetRows = [];
      const now = new Date().toISOString();
      for (const image of scan.images) {
        let best = null;
        let bestScore = 0;
        for (const catalog of catalogs || []) {
          const score = scoreCatalog(catalog, image, folderPolicy(catalog));
          if (score > bestScore) { bestScore = score; best = catalog; }
        }
        const sourceUrl = `${publicBase}/api/slide-manager/drive-image/${encodeURIComponent(image.id)}`;
        assetRows.push({
          provider: "google_drive",
          external_id: image.id,
          folder_id: image.folder_id,
          file_name: image.name || null,
          mime_type: image.mimeType || null,
          source_url: sourceUrl,
          thumbnail_url: image.thumbnailLink || null,
          file_size: image.size ? Number(image.size) : null,
          metadata: { folder_name: image.folder_name, folder_path: image.folder_path, web_view_link: image.webViewLink || null, modified_time: image.modifiedTime || null, match_score: bestScore, matched_catalog_key: best?.catalog_key || null },
          is_active: true,
          last_synced_at: now,
          updated_at: now,
        });
        if (best && bestScore >= 350) assignments.push({ external_id: image.id, catalog_key: best.catalog_key, score: bestScore });
      }
      await rest("ai_assets?provider=eq.google_drive", { method: "PATCH", body: { is_active: false, updated_at: now } }).catch(() => {});
      const storedAssets = [];
      for (const batch of chunks(assetRows, 100)) {
        const rows = await rest("ai_assets?on_conflict=provider,external_id", { method: "POST", prefer: "resolution=merge-duplicates,return=representation", body: batch, timeout: 60000 });
        storedAssets.push(...(rows || []));
        syncState.completed += batch.length;
      }
      const idByExternal = new Map(storedAssets.map((x) => [clean(x.external_id), x.id]));
      const allGoogleAssets = await rest("ai_assets?provider=eq.google_drive&select=id,external_id,is_active");
      for (const batch of chunks((allGoogleAssets || []).map((x) => x.id), 100)) {
        if (!batch.length) continue;
        await rest(`ai_catalog_assets?asset_id=in.(${batch.join(",")})`, { method: "DELETE", prefer: "return=minimal" }).catch(() => {});
      }
      const links = [];
      for (const item of assignments) {
        const assetId = idByExternal.get(item.external_id) || (allGoogleAssets || []).find((x) => x.external_id === item.external_id)?.id;
        if (assetId) links.push({ catalog_key: item.catalog_key, asset_id: assetId, asset_role: "slide", sort_order: links.length + 1, metadata: { match_score: item.score }, created_at: now });
      }
      for (const batch of chunks(links, 100)) {
        await rest("ai_catalog_assets?on_conflict=catalog_key,asset_id,asset_role", { method: "POST", prefer: "resolution=merge-duplicates,return=representation", body: batch });
      }
      syncState.images_synced = assetRows.length;
      syncState.mappings_synced = uniq(assignments.map((x) => x.catalog_key)).length;
      await rest("ai_drive_connections?connection_key=eq.google_drive", { method: "PATCH", body: { connection_status: "connected", last_verified_at: now, last_error: null, metadata: { connection_mode: "env_api_key", secret_source: "railway_env", last_sync_at: now, folders_scanned: scan.folders_scanned, images_synced: assetRows.length, catalog_links: links.length }, updated_at: now } }).catch(() => {});
      console.log(`[AIGUKA V10 Drive] sync healthy: folders=${scan.folders_scanned}, images=${assetRows.length}, catalog_links=${links.length}, catalogs=${syncState.mappings_synced}`);
    } catch (error) {
      syncState.errors.push({ error: error instanceof Error ? error.message : String(error) });
      await ensureConnection().then(() => rest("ai_drive_connections?connection_key=eq.google_drive", { method: "PATCH", body: { connection_status: "error", last_error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() } })).catch(() => {});
      console.error(`[AIGUKA V10 Drive] sync failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      syncState.running = false;
      syncState.finished_at = new Date().toISOString();
    }
    return { ...syncState };
  }

  function folderSummary(assets = []) {
    const map = new Map();
    for (const asset of assets || []) {
      if (!asset.folder_id) continue;
      const meta = asset.metadata && typeof asset.metadata === "object" ? asset.metadata : {};
      const row = map.get(asset.folder_id) || { folder_id: asset.folder_id, folder_name: meta.folder_name || asset.folder_id, folder_path: meta.folder_path || meta.folder_name || asset.folder_id, folder_url: `https://drive.google.com/drive/folders/${asset.folder_id}`, parent_folder_id: null, direct_images: 0, images: 0, catalogs: new Set() };
      row.direct_images += 1; row.images += 1;
      if (meta.matched_catalog_key) row.catalogs.add(meta.matched_catalog_key);
      map.set(asset.folder_id, row);
    }
    return [...map.values()].map((x) => ({ ...x, catalogs: [...x.catalogs], child_count: 0 }));
  }

  function mapCatalog(row) {
    const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    return { ...row, catalog_name: row.display_name, root_product_key: row.root_key, drive_folder_id: folderPolicy(row)[0] || null, drive_folder_url: folderPolicy(row)[0] ? `https://drive.google.com/drive/folders/${folderPolicy(row)[0]}` : null, folder_path: meta.folder_path || null, level_no: row.parent_key ? 2 : 1, is_sendable: row.node_type !== "root" };
  }

  function mapAdMapping(row) {
    const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    return { ...row, ad_name: meta.ad_name || "", ad_account_name: meta.ad_account_name || "", campaign_name: meta.campaign_name || "", adset_name: meta.adset_name || "", product_group: meta.product_group || "", product_item_key: row.catalog_keys?.[0] || meta.product_item_key || "", selected_folders: meta.selected_folders || [], drive_folders: meta.selected_folders || [], resolved_folder_ids: meta.selected_folders || [], notes: meta.notes || "", enabled: row.is_active, effective_status: meta.effective_status || "ACTIVE" };
  }

  async function slideMappings(catalogs, assets, links) {
    const assetById = new Map((assets || []).map((x) => [x.id, x]));
    const linksByCatalog = new Map();
    for (const link of links || []) { const arr = linksByCatalog.get(link.catalog_key) || []; arr.push(link); linksByCatalog.set(link.catalog_key, arr); }
    return (catalogs || []).map((catalog) => {
      const linked = (linksByCatalog.get(catalog.catalog_key) || []).map((l) => assetById.get(l.asset_id)).filter(Boolean);
      const folders = uniq(linked.map((x) => x.folder_id)).map((id) => { const a = linked.find((x) => x.folder_id === id); const m = a?.metadata || {}; return { id, name: m.folder_name || id, path: m.folder_path || m.folder_name || id, parent_id: null }; });
      const meta = catalog.metadata || {};
      return { id: catalog.catalog_key, product_key: catalog.catalog_key, product_name: catalog.display_name, page_id: meta.slide_page_id || null, drive_folder_ids: folders, drive_folder_id: folders[0]?.id || null, drive_folder_url: folders[0]?.id ? `https://drive.google.com/drive/folders/${folders[0].id}` : null, priority: Number(meta.slide_priority || 100), is_active: catalog.is_active !== false, note: meta.slide_note || null, sync_status: linked.length ? "success" : "idle", last_synced_at: linked.map((x) => x.last_synced_at).filter(Boolean).sort().at(-1) || null, asset_count: linked.length };
    });
  }

  async function activePageId() {
    const pages = await rest("v9_pages?select=page_id,operating_mode,is_active&is_active=eq.true&order=updated_at.desc");
    return clean((pages || []).find((x) => ["SUPPORT", "ON", "ACTIVE"].includes(clean(x.operating_mode).toUpperCase()))?.page_id || pages?.[0]?.page_id);
  }

  async function bootstrapPayload(days = 45) {
    const [pagesRaw, catalogsRaw, assets, links, adMappings, accounts] = await Promise.all([
      rest("v9_pages?select=page_id,page_name,is_active,operating_mode,settings&order=page_name.asc"),
      rest("ai_catalog_nodes?select=*&order=display_name.asc"),
      rest("ai_assets?select=*&is_active=eq.true&order=file_name.asc&limit=12000"),
      rest("ai_catalog_assets?select=*&order=sort_order.asc&limit=20000"),
      rest("ai_ad_mappings?select=*&order=updated_at.desc&limit=3000"),
      rest("v10_report_scope?select=*&is_active=eq.true&order=ad_account_name.asc"),
    ]);
    const catalogs = (catalogsRaw || []).map(mapCatalog);
    const mappings = (adMappings || []).map(mapAdMapping);
    const slides = await slideMappings(catalogsRaw || [], assets || [], links || []);
    const cutoff = Date.now() - days * 86400000;
    const events = await rest(`v9_events?select=page_id,sender_id,referral,occurred_at&occurred_at=gte.${encodeURIComponent(new Date(cutoff).toISOString())}&order=occurred_at.desc&limit=10000`).catch(() => []);
    const current = new Map();
    for (const e of events || []) {
      const r = e.referral && typeof e.referral === "object" ? e.referral : {};
      const adId = clean(r.ad_id || r.ad?.id || r.source_ad_id);
      if (!adId) continue;
      const key = `${e.page_id || ""}:${adId}`;
      const row = current.get(key) || { page_id: e.page_id || "", page_name: (pagesRaw || []).find((p) => p.page_id === e.page_id)?.page_name || "", ad_id: adId, ad_title: clean(r.ad_title || r.ad_name || r.ad?.name), referrals: 0, customers: new Set(), contacts: new Set(), last_referral: e.occurred_at };
      row.referrals += 1; if (e.sender_id) row.customers.add(e.sender_id); if (Date.parse(e.occurred_at || 0) > Date.parse(row.last_referral || 0)) row.last_referral = e.occurred_at; current.set(key, row);
    }
    for (const m of mappings) {
      const key = `${m.page_id || ""}:${m.ad_id || ""}`;
      if (!m.ad_id || current.has(key)) continue;
      current.set(key, { page_id: m.page_id || "", page_name: (pagesRaw || []).find((p) => p.page_id === m.page_id)?.page_name || "", ad_id: m.ad_id, ad_title: m.ad_name || "", referrals: 0, customers: new Set(), contacts: new Set(), last_referral: null });
    }
    const currentAds = [...current.values()].map((x) => { const mapping = mappings.find((m) => m.ad_id === x.ad_id && (!m.page_id || m.page_id === x.page_id)); return { ...x, customers: x.customers.size, contacts: x.contacts.size, mapped: Boolean(mapping?.is_active && (mapping.product_item_key || mapping.product_group || mapping.selected_folders?.length)), mapping: mapping || null }; });
    const folders = folderSummary(assets || []);
    return {
      ok: true, version: "v10_core_drive_mapping_compat_v1", generated_at: new Date().toISOString(), days,
      pages: (pagesRaw || []).map((p) => ({ ...p, mode: p.operating_mode })),
      runtime: (pagesRaw || []).map((p) => ({ page_id: p.page_id, mode: p.settings?.mapping_mode || "ACTIVE", minimum_apply_confidence: Number(p.settings?.mapping_confidence || 0.78), recent_context_minutes: Number(p.settings?.recent_context_minutes || 60), use_ad_mapping: true, use_recent_context: true, use_slide_mapping: true })),
      groups: catalogs.filter((c) => !c.parent_key).map((c, i) => ({ group_key: c.catalog_key, group_name: c.catalog_name, priority: i + 1, is_active: c.is_active })),
      catalogs: catalogs.filter((c) => c.is_active !== false), all_catalogs: catalogs, mappings, slide_mappings: slides, current_ads: currentAds,
      ad_accounts: (accounts || []).map((a) => ({ ad_account_id: clean(a.ad_account_id).replace(/^act_/, ""), ad_account_name: a.ad_account_name, account_status: "ACTIVE", source: "v10_report_scope" })), businesses: [],
      asset_summary: { by_catalog: catalogs.map((c) => ({ catalog_key: c.catalog_key, images: (links || []).filter((l) => l.catalog_key === c.catalog_key).length, verified: (links || []).filter((l) => l.catalog_key === c.catalog_key).length, errors: 0, folders: uniq((links || []).filter((l) => l.catalog_key === c.catalog_key).map((l) => assetByIdLookup(assets, l.asset_id)?.folder_id).filter(Boolean)) })), folders },
      change_log: [], summary: { current_ads: currentAds.length, mapped_current_ads: currentAds.filter((x) => x.mapped).length, unmapped_current_ads: currentAds.filter((x) => !x.mapped).length, total_mappings: mappings.length, active_images: (assets || []).length }, warnings: [],
    };
  }

  const assetByIdLookup = (assets, id) => (assets || []).find((x) => x.id === id);

  app.get("/api/v8-mapping-center/bootstrap", async (req, res) => {
    try { res.json(await bootstrapPayload(Math.min(Math.max(Number(req.query.days || 45), 7), 180))); }
    catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });

  app.post("/api/v8-mapping-center/ad-mapping", express.json({ limit: "2mb" }), async (req, res) => {
    try {
      const b = req.body || {}; const adId = clean(b.ad_id); if (!adId) throw new Error("AD_ID_REQUIRED");
      const pageId = clean(b.page_id) || await activePageId();
      const catalogKeys = uniq([clean(b.product_item_key), clean(b.product_group)].filter((x) => x && x !== "general"));
      const row = { page_id: pageId || null, ad_account_id: clean(b.ad_account_id) || null, campaign_id: clean(b.campaign_id) || null, adset_id: clean(b.adset_id) || null, ad_id: adId, catalog_keys: catalogKeys, confidence: 1, source: "manual_admin", is_active: b.is_active !== false && b.enabled !== false, metadata: { ad_name: clean(b.ad_name), ad_account_name: clean(b.ad_account_name), campaign_name: clean(b.campaign_name), adset_name: clean(b.adset_name), product_group: clean(b.product_group), product_item_key: clean(b.product_item_key), selected_folders: uniq(b.selected_folders || []), notes: clean(b.notes), effective_status: clean(b.effective_status || "ACTIVE") }, updated_at: new Date().toISOString() };
      const saved = await rest("ai_ad_mappings?on_conflict=page_id,ad_id", { method: "POST", prefer: "resolution=merge-duplicates,return=representation", body: row });
      res.json({ ok: true, saved: mapAdMapping(saved?.[0] || row) });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/v8-mapping-center/ad-mapping/disable", express.json({ limit: "1mb" }), async (req, res) => {
    try { await rest(`ai_ad_mappings?ad_id=eq.${encodeURIComponent(clean(req.body?.ad_id))}`, { method: "PATCH", body: { is_active: false, updated_at: new Date().toISOString() } }); res.json({ ok: true }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/v8-mapping-center/slide-mapping", express.json({ limit: "2mb" }), async (req, res) => {
    try {
      const b = req.body || {}; const key = clean(b.product_key); if (!key) throw new Error("PRODUCT_KEY_REQUIRED");
      const current = (await rest(`ai_catalog_nodes?catalog_key=eq.${encodeURIComponent(key)}&select=*&limit=1`))?.[0]; if (!current) throw new Error("CATALOG_NOT_FOUND");
      const folders = (Array.isArray(b.drive_folder_ids) ? b.drive_folder_ids : []).map((x) => typeof x === "string" ? { id: x } : x).filter((x) => clean(x?.id));
      const metadata = { ...(current.metadata || {}), drive_folder_ids: folders, selected_drive_folder_ids: folders.map((x) => clean(x.id)), slide_priority: Number(b.priority || 100), slide_page_id: clean(b.page_id) || null, slide_note: clean(b.note) || null };
      const asset_policy = { ...(current.asset_policy || {}), drive_folder_ids: folders.map((x) => clean(x.id)) };
      await rest(`ai_catalog_nodes?catalog_key=eq.${encodeURIComponent(key)}`, { method: "PATCH", body: { metadata, asset_policy, is_active: b.is_active !== false, updated_at: new Date().toISOString() } });
      if (b.request_sync !== false) void syncAllDriveAssets({ force: true });
      res.json({ ok: true, saved: { id: key, product_key: key, product_name: clean(b.product_name || current.display_name), page_id: clean(b.page_id) || null, drive_folder_ids: folders, drive_folder_id: folders[0]?.id || null, priority: Number(b.priority || 100), is_active: b.is_active !== false, note: clean(b.note), sync_status: "requested" } });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/v8-mapping-center/runtime", express.json({ limit: "1mb" }), async (req, res) => {
    try { const b = req.body || {}; const page = (await rest(`v9_pages?page_id=eq.${encodeURIComponent(clean(b.page_id))}&select=settings&limit=1`))?.[0] || {}; const settings = { ...(page.settings || {}), mapping_mode: clean(b.mode || "ACTIVE"), mapping_confidence: Number(b.minimum_apply_confidence || 0.78), recent_context_minutes: Number(b.recent_context_minutes || 60), use_ad_mapping: b.use_ad_mapping !== false, use_recent_context: b.use_recent_context !== false, use_slide_mapping: b.use_slide_mapping !== false }; await rest(`v9_pages?page_id=eq.${encodeURIComponent(clean(b.page_id))}`, { method: "PATCH", body: { settings, updated_at: new Date().toISOString() } }); res.json({ ok: true }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/v8-mapping-center/test", express.json({ limit: "1mb" }), async (req, res) => {
    try {
      const b = req.body || {}; const adId = clean(b.ad_id); const text = norm(b.message_text); const mappings = await rest(`ai_ad_mappings?ad_id=eq.${encodeURIComponent(adId)}&is_active=eq.true&select=*&limit=10`); let catalogKey = mappings?.[0]?.catalog_keys?.[0] || "";
      if (!catalogKey) { const catalogs = await rest("ai_catalog_nodes?select=*&is_active=eq.true"); let best = 0; for (const c of catalogs || []) { for (const t of catalogTerms(c)) { if (text.includes(t) && t.length > best) { best = t.length; catalogKey = c.catalog_key; } } } }
      const links = catalogKey ? await rest(`ai_catalog_assets?catalog_key=eq.${encodeURIComponent(catalogKey)}&asset_role=eq.slide&select=asset_id,sort_order&order=sort_order.asc&limit=20`) : [];
      const ids = (links || []).map((x) => x.asset_id); const assets = ids.length ? await rest(`ai_assets?id=in.(${ids.join(",")})&is_active=eq.true&select=*`) : [];
      res.json({ ok: true, result: { status: catalogKey ? "catalog" : "unmatched", source: mappings?.length ? "ad_mapping" : "message_text", confidence: catalogKey ? 1 : 0, group_key: null, catalog_key: catalogKey || null, apply_to_runtime: Boolean(catalogKey), conflict: false, needs_clarification: !catalogKey, slide_asset_count: assets.length }, preview_assets: (assets || []).slice(0, 10).map((a) => ({ ...a, delivery_url: a.source_url, catalog_key: catalogKey })) });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.get("/api/slide-manager/data", async (_req, res) => { try { const p = await bootstrapPayload(45); const conn = await ensureConnection(); res.json({ ok: true, mappings: p.slide_mappings, assets: await rest("ai_assets?is_active=eq.true&select=*&order=file_name.asc&limit=12000"), pages: p.pages, drive_connection: { mode: conn?.metadata?.connection_mode || (driveKey ? "env_api_key" : "none"), configured: Boolean(driveKey && (conn?.root_folder_id || rootFolderId)), connected: conn?.connection_status === "connected", enabled: conn?.is_enabled !== false, status: conn?.connection_status || "not_configured", root_folder_id: conn?.root_folder_id || rootFolderId || "", api_key_hint: conn?.client_secret_hint || (driveKey ? `••••${driveKey.slice(-6)}` : ""), can_write: false, last_checked_at: conn?.last_verified_at || null }, meta_connected: Boolean(process.env.META_ACCESS_TOKEN) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });

  app.get("/api/slide-manager/drive/tree", async (req, res) => { try { const scan = await scanDrive(8); res.json({ ok: true, root_folder_id: scan.root, folders: scan.folders }); } catch (e) { res.status(400).json({ ok: false, error: e.message }); } });
  app.get("/api/slide-manager/drive/list", async (req, res) => { try { const id = clean(req.query.folder_id || rootFolderId); res.json({ ok: true, folder_id: id, items: await listChildren(id) }); } catch (e) { res.status(400).json({ ok: false, error: e.message }); } });
  app.post("/api/slide-manager/google/test", express.json({ limit: "1mb" }), async (_req, res) => { try { const v = await verifyDrive(); res.json({ ok: true, data: { mode: "env_api_key", configured: true, connected: true, enabled: true, status: "connected", root_folder_id: v.root, account_name: v.info.name, api_key_hint: `••••${driveKey.slice(-6)}`, can_write: false, last_checked_at: new Date().toISOString() }, root: v.info }); } catch (e) { res.status(400).json({ ok: false, error: e.message }); } });
  app.post("/api/slide-manager/drive/sync", express.json({ limit: "1mb" }), async (_req, res) => { try { const s = await syncAllDriveAssets({ force: true }); res.json({ ok: !s.errors.length, synced: s.images_synced, folders_scanned: s.folders_scanned, ...s }); } catch (e) { res.status(400).json({ ok: false, error: e.message }); } });
  app.post("/api/slide-manager/drive/sync-all", express.json({ limit: "1mb" }), async (_req, res) => { if (syncState.running) return res.status(202).json({ ok: true, started: false, ...syncState }); void syncAllDriveAssets({ force: true }); res.status(202).json({ ok: true, started: true, ...syncState, running: true }); });
  app.get("/api/slide-manager/drive/sync-all/status", (_req, res) => res.json({ ok: true, ...syncState }));

  app.get("/api/slide-manager/drive-image/:driveId", async (req, res) => {
    try {
      if (!driveKey) throw new Error("GOOGLE_DRIVE_API_KEY_MISSING");
      const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(req.params.driveId)}?alt=media&key=${encodeURIComponent(driveKey)}`, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`GOOGLE_DRIVE_MEDIA_${response.status}`);
      const type = response.headers.get("content-type") || "application/octet-stream";
      if (!type.startsWith("image/")) throw new Error("NOT_IMAGE");
      const buf = Buffer.from(await response.arrayBuffer()); res.set({ "content-type": type, "cache-control": "public,max-age=3600", "content-length": String(buf.length) }); res.send(buf);
    } catch (e) { res.status(404).json({ ok: false, error: e.message }); }
  });

  app.get("/api/slide-manager/recipients", async (req, res) => { try { const pageId = clean(req.query.page_id); const since = new Date(Date.now() - 24 * 3600000).toISOString(); const rows = await rest(`v9_events?page_id=eq.${encodeURIComponent(pageId)}&actor_type=eq.customer&event_type=eq.customer_message&occurred_at=gte.${encodeURIComponent(since)}&select=sender_id,message_text,occurred_at&order=occurred_at.desc&limit=1000`); const seen = new Set(); const recipients = []; for (const r of rows || []) { if (!r.sender_id || seen.has(r.sender_id)) continue; seen.add(r.sender_id); recipients.push({ page_id: pageId, sender_id: r.sender_id, label: `Khách …${String(r.sender_id).slice(-6)}`, last_message: r.message_text || "", last_message_at: r.occurred_at, source: "V10 Core" }); } res.json({ ok: true, page_id: pageId, window_hours: 24, recipients }); } catch (e) { res.status(400).json({ ok: false, error: e.message }); } });

  async function pageToken(pageId) { const userToken = clean(process.env.META_ACCESS_TOKEN || process.env.META_USER_ACCESS_TOKEN); if (!userToken) return ""; const response = await fetch(`https://graph.facebook.com/${graphVersion}/me/accounts?fields=id,access_token&limit=200&access_token=${encodeURIComponent(userToken)}`, { signal: AbortSignal.timeout(20000) }); const data = await response.json().catch(() => ({})); return (data.data || []).find((x) => String(x.id) === String(pageId))?.access_token || ""; }
  app.get("/api/slide-manager/meta-status", async (req, res) => { try { const token = await pageToken(clean(req.query.page_id)); res.json({ ok: true, data: { ok: Boolean(token), page_id: clean(req.query.page_id), has_page_token: Boolean(token), has_pages_messaging: Boolean(token), granted_scopes: [], action_url: "/facebook-connect", message: token ? "Page đã sẵn sàng gửi thử slide." : "Không tìm thấy Page Access Token." } }); } catch (e) { res.status(400).json({ ok: false, error: e.message }); } });

  app.post("/api/slide-manager/test-slide", express.json({ limit: "1mb" }), async (req, res) => {
    try {
      const pageId = clean(req.body?.page_id); const recipient = clean(req.body?.recipient_id); const key = clean(req.body?.mapping_id); if (!pageId || !recipient || !key) throw new Error("TEST_SLIDE_INPUT_REQUIRED");
      const links = await rest(`ai_catalog_assets?catalog_key=eq.${encodeURIComponent(key)}&asset_role=eq.slide&select=asset_id,sort_order&order=sort_order.asc&limit=10`); const ids = (links || []).map((x) => x.asset_id); const assets = ids.length ? await rest(`ai_assets?id=in.(${ids.join(",")})&is_active=eq.true&select=*`) : []; if (!assets.length) throw new Error("CATALOG_HAS_NO_IMAGES");
      const token = await pageToken(pageId); if (!token) throw new Error("META_PAGE_TOKEN_MISSING");
      const catalog = (await rest(`ai_catalog_nodes?catalog_key=eq.${encodeURIComponent(key)}&select=display_name&limit=1`))?.[0];
      const elements = assets.slice(0, 10).map((a, i) => ({ title: `${clean(catalog?.display_name || key)} — Mẫu ${String(i + 1).padStart(2, "0")}`.slice(0, 80), image_url: a.source_url, subtitle: clean(a.file_name || "Mẫu sản phẩm").slice(0, 80), default_action: { type: "web_url", url: a.source_url, webview_height_ratio: "full" } }));
      const response = await fetch(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(pageId)}/messages?access_token=${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recipient: { id: recipient }, messaging_type: "RESPONSE", message: { attachment: { type: "template", payload: { template_type: "generic", image_aspect_ratio: "square", elements } } } }), signal: AbortSignal.timeout(30000) });
      const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data?.error?.message || `META_${response.status}`); res.json({ ok: true, all_sent: true, delivery_type: "generic_template", message_count: 1, slide_count: elements.length, media_source: "v10_drive_proxy", message_id: data.message_id || null, recipient_id: data.recipient_id || recipient });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // Catalog management compatibility on V10 Core.
  app.post("/api/v8-mapping-center/catalog", express.json({ limit: "1mb" }), async (req, res) => { try { const b = req.body || {}; const key = clean(b.catalog_key).toLowerCase(); if (!/^[a-z0-9][a-z0-9_]{0,79}$/.test(key)) throw new Error("INVALID_CATALOG_KEY"); const existing = (await rest(`ai_catalog_nodes?catalog_key=eq.${encodeURIComponent(key)}&select=*&limit=1`))?.[0]; const row = { catalog_key: key, display_name: clean(b.catalog_name || key), parent_key: clean(b.parent_key) || null, root_key: clean(b.parent_key) || key, node_type: "product_group", aliases: existing?.aliases || [], intents: existing?.intents || ["xem mẫu", "báo giá"], rules: existing?.rules || [], asset_policy: existing?.asset_policy || {}, metadata: { ...(existing?.metadata || {}), admin_order: existing?.metadata?.admin_order || 100 }, is_active: b.is_active !== false, updated_at: new Date().toISOString() }; const saved = await rest("ai_catalog_nodes?on_conflict=catalog_key", { method: "POST", prefer: "resolution=merge-duplicates,return=representation", body: row }); res.json({ ok: true, saved: mapCatalog(saved?.[0] || row) }); } catch (e) { res.status(400).json({ ok: false, error: e.message }); } });
  app.post("/api/v8-mapping-center/catalog/rename", express.json({ limit: "1mb" }), async (_req, res) => res.status(409).json({ ok: false, error: "V10 không đổi catalog_key trực tiếp để tránh phá liên kết ảnh; hãy tạo catalog mới rồi chuyển Mapping." }));
  app.post("/api/v8-mapping-center/catalog/reorder", express.json({ limit: "1mb" }), async (_req, res) => res.json({ ok: true, unchanged: true }));

  console.log("[AIGUKA V10 Drive] Core Drive/Mapping/Test Slide compatibility routes installed");
  setTimeout(() => { void syncAllDriveAssets({ force: false }); }, 2500).unref?.();
}
