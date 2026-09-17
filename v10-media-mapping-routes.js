import express from "express";

const clean = (v = "") => String(v ?? "").trim();
const idFromUrl = (v) => clean(v).match(/(?:folders\/|\/d\/|[?&]id=)([-\w]+)/)?.[1] || clean(v);
const imageMime = (v = "") => /^image\//i.test(v);
const folderMime = (v = "") => v === "application/vnd.google-apps.folder";
const nowIso = () => new Date().toISOString();

const KEYWORDS = {
  combo_phong_tam: ["combo phong tam", "combo nha tam", "combo ve sinh", "bo phong tam"],
  bon_cau: ["bon cau", "bet", "toilet", "bệt"],
  lavabo: ["lavabo", "tu chau", "chau lavabo", "tủ chậu"],
  sen_tam: ["sen tam", "sen cay", "sen voi", "sen phím", "sen phim"],
  voi_lavabo: ["voi lavabo", "voi chau", "vòi lavabo"],
  guong: ["guong", "gương", "guong tu", "gương tủ"],
  phu_kien_nha_tam: ["phu kien nha tam", "phu kien ve sinh", "phụ kiện nhà tắm"],
  chau_rua_bat: ["chau rua bat", "chau bep", "chau nano", "chậu rửa bát"],
  voi_rua_bat: ["voi rua bat", "voi bep", "vòi rửa bát"],
  bep_hut_mui: ["bep tu", "hut mui", "máy hút mùi", "bếp từ"],
  phu_kien_inox_bep: ["phu kien inox bep", "gia bat", "ke bep", "giá bát"],
  quat_den: ["quat tran", "den chum", "quạt trần", "đèn chùm", "quat den"],
  gach_ngoi: ["gach", "ngoi", "gạch", "ngói"],
};

function normalizeVi(value = "") {
  return clean(value).toLocaleLowerCase("vi-VN")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d").replace(/[^a-z0-9]+/g, " ").trim();
}

function catalogForPath(path, catalogs) {
  const hay = ` ${normalizeVi(path)} `;
  let best = null;
  let bestScore = 0;
  for (const row of catalogs) {
    const terms = [row.display_name, ...(Array.isArray(row.aliases) ? row.aliases : []), ...(KEYWORDS[row.catalog_key] || [])]
      .map(normalizeVi).filter(Boolean).sort((a, b) => b.length - a.length);
    let score = 0;
    for (const term of terms) {
      if (hay.includes(` ${term} `)) score = Math.max(score, 1000 + term.length);
      else if (term.length >= 5 && hay.includes(term)) score = Math.max(score, 100 + term.length);
    }
    if (score > bestScore) { bestScore = score; best = row.catalog_key; }
  }
  return bestScore ? best : null;
}

export function installV10MediaMappingRoutes(app, options = {}) {
  const base = clean(options.supabaseUrl || process.env.SUPABASE_URL).replace(/\/$/, "");
  const serviceKey = clean(process.env.SUPABASE_SERVICE_ROLE_KEY || options.serviceRoleKey);
  const driveKey = clean(process.env.GOOGLE_DRIVE_API_KEY);
  const rootFolderId = idFromUrl(process.env.GOOGLE_DRIVE_PRODUCTS_ROOT_ID || process.env.GOOGLE_DRIVE_ROOT_ID || "");
  const publicBase = clean(process.env.PUBLIC_BASE_URL).replace(/\/$/, "") || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");
  if (!base || !serviceKey) return;

  const db = async (path, init = {}) => {
    const response = await fetch(`${base}/rest/v1/${path}`, {
      method: init.method || "GET",
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
        prefer: init.prefer || "return=representation",
        ...(init.headers || {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeout || 45000), cache: "no-store",
    });
    const raw = await response.text();
    let data; try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
    if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `DB_${response.status}`);
    return data;
  };

  const drive = async (path, query = {}) => {
    if (!driveKey) throw new Error("GOOGLE_DRIVE_API_KEY_MISSING");
    const params = new URLSearchParams({ ...query, key: driveKey });
    const response = await fetch(`https://www.googleapis.com/drive/v3/${path}?${params}`, { signal: AbortSignal.timeout(30000), cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || `GOOGLE_DRIVE_${response.status}`);
    return data;
  };

  const listFolder = async (folderId) => {
    const files = []; let token = ""; let page = 0;
    do {
      const data = await drive("files", {
        q: `'${idFromUrl(folderId)}' in parents and trashed=false`,
        fields: "nextPageToken,files(id,name,mimeType,webViewLink,thumbnailLink,size,createdTime,modifiedTime,parents)",
        pageSize: "1000", orderBy: "folder,name", supportsAllDrives: "true", includeItemsFromAllDrives: "true",
        ...(token ? { pageToken: token } : {}),
      });
      files.push(...(data.files || [])); token = data.nextPageToken || ""; page += 1;
    } while (token && page < 20);
    return files;
  };

  const rootInfo = async () => {
    if (!rootFolderId) throw new Error("GOOGLE_DRIVE_PRODUCTS_ROOT_ID_MISSING");
    return drive(`files/${encodeURIComponent(rootFolderId)}`, { fields: "id,name,mimeType,webViewLink", supportsAllDrives: "true" });
  };

  const scanTree = async (maxDepth = 8, maxFolders = 800, maxImages = 5000) => {
    const root = await rootInfo();
    if (!folderMime(root.mimeType)) throw new Error("GOOGLE_DRIVE_ROOT_NOT_FOLDER");
    const folders = [{ id: root.id, name: root.name || "Products", path: root.name || "Products", parent_id: null, depth: 0, direct_images: 0 }];
    const images = []; const queue = [folders[0]]; const visited = new Set();
    while (queue.length && visited.size < maxFolders && images.length < maxImages) {
      const current = queue.shift();
      if (!current?.id || visited.has(current.id)) continue;
      visited.add(current.id);
      const children = await listFolder(current.id);
      current.direct_images = children.filter(x => imageMime(x.mimeType)).length;
      for (const item of children) {
        if (folderMime(item.mimeType) && current.depth < maxDepth) {
          const folder = { id: item.id, name: item.name, path: `${current.path} / ${item.name}`, parent_id: current.id, depth: current.depth + 1, direct_images: 0 };
          folders.push(folder); queue.push(folder);
        } else if (imageMime(item.mimeType)) {
          images.push({ ...item, folder_id: current.id, folder_name: current.name, folder_path: current.path });
        }
      }
    }
    const childMap = new Map(); for (const f of folders) if (f.parent_id) { const a = childMap.get(f.parent_id) || []; a.push(f.id); childMap.set(f.parent_id, a); }
    const byId = new Map(folders.map(f => [f.id, f])); const memo = new Map();
    const sum = (id, seen = new Set()) => { if (memo.has(id)) return memo.get(id); if (seen.has(id)) return { images: 0, descendants: 0 }; const f = byId.get(id); if (!f) return { images: 0, descendants: 0 }; let images = f.direct_images || 0, descendants = 0; const next = new Set(seen).add(id); for (const c of childMap.get(id) || []) { const s = sum(c, next); images += s.images; descendants += 1 + s.descendants; } const out = { images, descendants }; memo.set(id, out); return out; };
    for (const f of folders) { const s = sum(f.id); f.images = s.images; f.child_count = s.descendants; }
    return { root, folders, images };
  };

  const assetUrl = (id) => publicBase ? `${publicBase}/api/v10-media/image/${encodeURIComponent(id)}` : `https://drive.google.com/uc?export=view&id=${encodeURIComponent(id)}`;

  const upsertAsset = async (item) => {
    const body = {
      provider: "google_drive", external_id: item.id, folder_id: item.folder_id || null, file_name: item.name || null,
      mime_type: item.mimeType || null, source_url: assetUrl(item.id), thumbnail_url: item.thumbnailLink || null,
      file_size: item.size ? Number(item.size) : null, is_active: true, last_synced_at: nowIso(),
      metadata: { folder_name: item.folder_name || null, folder_path: item.folder_path || null, drive_web_url: item.webViewLink || null, modified_time: item.modifiedTime || null },
      updated_at: nowIso(),
    };
    return (await db("ai_assets?on_conflict=provider,external_id", { method: "POST", prefer: "resolution=merge-duplicates,return=representation", body }))?.[0] || null;
  };

  const linkAsset = async (catalogKey, assetId, sortOrder = 0, metadata = {}) => {
    if (!catalogKey || !assetId) return;
    await db("ai_catalog_assets?on_conflict=catalog_key,asset_id,asset_role", {
      method: "POST", prefer: "resolution=merge-duplicates,return=representation",
      body: { catalog_key: catalogKey, asset_id: assetId, asset_role: "slide", sort_order: sortOrder, metadata },
    });
  };

  const saveDriveConnectionMeta = async (scan = null, error = null) => {
    await db("ai_drive_connections?on_conflict=connection_key", {
      method: "POST", prefer: "resolution=merge-duplicates,return=representation",
      body: {
        connection_key: "google_drive", client_id: driveKey ? "railway_env_api_key" : null, root_folder_id: rootFolderId || null,
        account_name: scan?.root?.name || "Google Drive Products", is_enabled: Boolean(driveKey && rootFolderId),
        connection_status: error ? "error" : (driveKey && rootFolderId ? "connected" : "not_configured"),
        metadata: { connection_mode: "railway_env_api_key", folders_scanned: scan?.folders?.length || 0, images_scanned: scan?.images?.length || 0 },
        last_verified_at: error ? null : nowIso(), last_error: error ? clean(error.message || error) : null, updated_at: nowIso(),
      },
    }).catch(() => {});
  };

  let scanState = { running: false, started_at: null, finished_at: null, folders_scanned: 0, images_scanned: 0, assets_upserted: 0, linked: 0, unmapped: 0, error: null };
  const syncAll = async ({ force = false } = {}) => {
    if (scanState.running) return scanState;
    scanState = { running: true, started_at: nowIso(), finished_at: null, folders_scanned: 0, images_scanned: 0, assets_upserted: 0, linked: 0, unmapped: 0, error: null };
    try {
      if (!force) {
        const existing = await db("ai_assets?select=id&is_active=eq.true&limit=1");
        if (existing?.length) { scanState.running = false; scanState.finished_at = nowIso(); return scanState; }
      }
      const catalogs = await db("ai_catalog_nodes?select=catalog_key,display_name,aliases,is_active&is_active=eq.true&order=display_name.asc");
      const scan = await scanTree(); scanState.folders_scanned = scan.folders.length; scanState.images_scanned = scan.images.length;
      await saveDriveConnectionMeta(scan, null);
      let order = 0;
      for (const item of scan.images) {
        const asset = await upsertAsset(item); if (!asset?.id) continue; scanState.assets_upserted += 1;
        const key = catalogForPath(`${item.folder_path} / ${item.name}`, catalogs || []);
        if (key) { await linkAsset(key, asset.id, ++order, { source: "drive_auto_path_v10", folder_id: item.folder_id, folder_path: item.folder_path }); scanState.linked += 1; }
        else scanState.unmapped += 1;
      }
      scanState.running = false; scanState.finished_at = nowIso();
      console.log(`[AIGUKA V10 media] Drive sync complete folders=${scanState.folders_scanned} images=${scanState.images_scanned} linked=${scanState.linked} unmapped=${scanState.unmapped}`);
    } catch (error) {
      scanState.running = false; scanState.finished_at = nowIso(); scanState.error = error.message;
      await saveDriveConnectionMeta(null, error);
      console.error(`[AIGUKA V10 media] Drive sync failed: ${error.message}`);
    }
    return scanState;
  };

  const deriveFolders = async () => {
    const assets = await db("ai_assets?select=folder_id,file_name,metadata,is_active&is_active=eq.true&limit=10000");
    const map = new Map();
    for (const a of assets || []) {
      const id = clean(a.folder_id); if (!id) continue;
      const path = clean(a.metadata?.folder_path || a.metadata?.folder_name || id); const name = clean(a.metadata?.folder_name || path.split("/").pop() || id);
      const row = map.get(id) || { folder_id: id, folder_name: name, folder_path: path, parent_folder_id: null, direct_images: 0, images: 0, catalogs: [] };
      row.direct_images += 1; row.images += 1; map.set(id, row);
    }
    return [...map.values()].sort((a,b) => a.folder_path.localeCompare(b.folder_path,"vi"));
  };

  const catalogRows = async () => (await db("ai_catalog_nodes?select=*&order=display_name.asc")) || [];
  const legacyCatalog = (r) => ({ catalog_key: r.catalog_key, catalog_name: r.display_name, parent_key: r.parent_key, root_product_key: r.root_key || r.catalog_key, drive_folder_id: r.asset_policy?.drive_folder_id || null, drive_folder_url: r.asset_policy?.drive_folder_url || null, folder_path: r.asset_policy?.folder_path || null, level_no: r.parent_key ? 2 : 1, is_sendable: r.node_type !== "root", is_active: r.is_active !== false, metadata: r.metadata || {} });

  const mappingRows = async () => {
    const rows = await db("ai_ad_mappings?select=*&order=updated_at.desc&limit=3000");
    return (rows || []).map(r => ({
      id: r.id, page_id: r.page_id, ad_account_id: r.ad_account_id, campaign_id: r.campaign_id, adset_id: r.adset_id, ad_id: r.ad_id,
      product_group: r.catalog_keys?.[0] || "", product_item_key: r.catalog_keys?.[0] || "", is_active: r.is_active !== false, enabled: r.is_active !== false,
      selected_folders: r.metadata?.selected_folders || [], resolved_folder_ids: r.metadata?.selected_folders || [], drive_folders: r.metadata?.selected_folders || [],
      ad_name: r.metadata?.ad_name || "", ad_account_name: r.metadata?.ad_account_name || "", campaign_name: r.metadata?.campaign_name || "", adset_name: r.metadata?.adset_name || "", notes: r.metadata?.notes || "", updated_at: r.updated_at,
    }));
  };

  const slideRows = async () => {
    const catalogs = await catalogRows(); const links = await db("ai_catalog_assets?select=catalog_key,asset_id,sort_order,metadata&asset_role=eq.slide&order=sort_order.asc&limit=10000");
    const count = new Map(); for (const l of links || []) count.set(l.catalog_key, (count.get(l.catalog_key) || 0) + 1);
    return catalogs.filter(c => c.is_active !== false).map(c => ({
      id: c.catalog_key, product_key: c.catalog_key, product_name: c.display_name, page_id: c.asset_policy?.page_id || null,
      drive_folder_id: c.asset_policy?.drive_folder_id || null, drive_folder_ids: c.asset_policy?.drive_folder_ids || [],
      drive_folder_url: c.asset_policy?.drive_folder_url || null, priority: Number(c.asset_policy?.priority || 100), is_active: c.is_active !== false,
      note: c.asset_policy?.note || null, sync_status: (count.get(c.catalog_key) || 0) ? "success" : "idle", last_synced_at: c.asset_policy?.last_synced_at || null, asset_count: count.get(c.catalog_key) || 0,
    }));
  };

  const router = express.Router(); router.use(express.json({ limit: "4mb" }));

  app.get("/api/v10-media/image/:id", async (req, res) => {
    try {
      const id = clean(req.params.id); const known = await db(`ai_assets?external_id=eq.${encodeURIComponent(id)}&provider=eq.google_drive&is_active=eq.true&select=id,mime_type&limit=1`);
      if (!known?.length) return res.status(404).end();
      const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&key=${encodeURIComponent(driveKey)}`, { signal: AbortSignal.timeout(25000) });
      if (!response.ok) return res.status(response.status).end();
      const buf = Buffer.from(await response.arrayBuffer()); res.set({ "content-type": response.headers.get("content-type") || known[0].mime_type || "image/jpeg", "cache-control": "public,max-age=3600", "content-length": String(buf.length) }); res.send(buf);
    } catch { res.status(404).end(); }
  });

  app.get("/api/slide-manager/data", async (_req,res) => {
    try { const [mappings, assets, pages, connection] = await Promise.all([slideRows(), db("ai_assets?select=*&is_active=eq.true&order=file_name.asc&limit=10000"), db("v9_pages?select=page_id,page_name,is_active,operating_mode&is_active=eq.true&order=page_name.asc"), db("ai_drive_connections?connection_key=eq.google_drive&select=*&limit=1")]); res.json({ ok:true,mappings,assets,pages,drive_connection: connection?.[0] || null,meta_connected:Boolean(process.env.META_ACCESS_TOKEN) }); } catch(e){ res.status(500).json({ok:false,error:e.message}); }
  });
  app.get("/api/slide-manager/drive/tree", async (_req,res) => { try { const scan = await scanTree(8,800,1); res.json({ok:true,root_folder_id:rootFolderId,folders:scan.folders}); } catch(e){ res.status(400).json({ok:false,error:e.message}); } });
  app.get("/api/slide-manager/drive/list", async (req,res) => { try { const folderId=idFromUrl(req.query.folder_id||rootFolderId); res.json({ok:true,folder_id:folderId,items:await listFolder(folderId)}); } catch(e){res.status(400).json({ok:false,error:e.message});} });
  app.post("/api/slide-manager/drive/sync-all", async (req,res) => { res.status(202).json({ok:true,started:true,...await syncAll({force:req.body?.force===true})}); });
  app.get("/api/slide-manager/drive/sync-all/status", (_req,res)=>res.json({ok:true,...scanState}));
  app.post("/api/slide-manager/drive/sync", async (req,res) => {
    try {
      const key=clean(req.body?.mapping_id).replace(/^catalog:/,""); if(!key) throw new Error("MAPPING_ID_REQUIRED");
      const catalog=(await db(`ai_catalog_nodes?catalog_key=eq.${encodeURIComponent(key)}&select=*&limit=1`))?.[0]; if(!catalog) throw new Error("CATALOG_NOT_FOUND");
      const ids=(catalog.asset_policy?.drive_folder_ids||[]).map(x=>idFromUrl(x?.id||x)).filter(Boolean); if(!ids.length) throw new Error("CATALOG_DRIVE_FOLDER_MISSING");
      let synced=0,foldersScanned=0,order=0;
      for(const fid of ids){ const rootName=(await drive(`files/${encodeURIComponent(fid)}`,{fields:"id,name,mimeType"})).name||catalog.display_name; const q=[{id:fid,path:rootName,depth:0}]; const seen=new Set(); while(q.length&&seen.size<300){const f=q.shift();if(seen.has(f.id))continue;seen.add(f.id);const children=await listFolder(f.id);for(const item of children){if(folderMime(item.mimeType)&&f.depth<7)q.push({id:item.id,path:`${f.path} / ${item.name}`,depth:f.depth+1});else if(imageMime(item.mimeType)){const asset=await upsertAsset({...item,folder_id:f.id,folder_name:f.path.split("/").pop().trim(),folder_path:f.path});if(asset?.id){await linkAsset(key,asset.id,++order,{source:"drive_manual_catalog_v10",folder_id:f.id,folder_path:f.path});synced++;}}}foldersScanned+=seen.size;} }
      await db(`ai_catalog_nodes?catalog_key=eq.${encodeURIComponent(key)}`,{method:"PATCH",body:{asset_policy:{...(catalog.asset_policy||{}),last_synced_at:nowIso()},updated_at:nowIso()}});
      res.json({ok:true,mapping_id:key,product_key:key,synced,folders_scanned:foldersScanned,total_items:synced});
    } catch(e){res.status(400).json({ok:false,error:e.message});}
  });

  app.get("/api/v8-mapping-center/bootstrap", async (_req,res) => {
    try {
      const [pages,cats,mappings,slides,folders,scope,assetCount] = await Promise.all([db("v9_pages?select=page_id,page_name,is_active,operating_mode,settings&is_active=eq.true&order=page_name.asc"),catalogRows(),mappingRows(),slideRows(),deriveFolders(),db("v10_report_scope?select=*&is_active=eq.true"),db("ai_assets?select=id&is_active=eq.true")]);
      const catalogs=cats.map(legacyCatalog); const groups=catalogs.filter(c=>!c.parent_key).map(c=>({group_key:c.catalog_key,group_name:c.catalog_name,priority:100,is_active:c.is_active}));
      res.json({ok:true,version:"v10_core_media_mapping_v1",generated_at:nowIso(),pages,runtime:(pages||[]).map(p=>({page_id:p.page_id,mode:p.operating_mode==="OFF"?"OFF":"ACTIVE",minimum_apply_confidence:0.78,recent_context_minutes:60,use_ad_mapping:true,use_recent_context:true,use_slide_mapping:true})),groups,catalogs:catalogs.filter(c=>c.is_active),all_catalogs:catalogs,mappings,slide_mappings:slides,current_ads:[],ad_accounts:(scope||[]).map(s=>({ad_account_id:s.ad_account_id,ad_account_name:s.ad_account_name||s.ad_account_id,source:"v10_report_scope"})),businesses:[],asset_summary:{folders,by_catalog:[]},change_log:[],summary:{current_ads:0,mapped_current_ads:0,unmapped_current_ads:0,total_mappings:mappings.length,active_images:assetCount?.length||0},warnings:[]});
    } catch(e){res.status(500).json({ok:false,error:e.message});}
  });

  app.post("/api/v8-mapping-center/ad-mapping", async (req,res) => {
    try {
      const b=req.body||{}; const adId=clean(b.ad_id); if(!adId) throw new Error("AD_ID_REQUIRED");
      let pageId=clean(b.page_id); if(!pageId){const p=await db("v9_pages?select=page_id,operating_mode&is_active=eq.true&operating_mode=neq.OFF&order=updated_at.desc&limit=1");pageId=clean(p?.[0]?.page_id);} if(!pageId) throw new Error("ACTIVE_PAGE_NOT_FOUND");
      const keys=[clean(b.product_item_key||b.product_group)].filter(Boolean); const metadata={ad_name:clean(b.ad_name),ad_account_name:clean(b.ad_account_name),campaign_name:clean(b.campaign_name),adset_name:clean(b.adset_name),notes:clean(b.notes),selected_folders:Array.isArray(b.selected_folders)?b.selected_folders:[]};
      const row={page_id:pageId,ad_account_id:clean(b.ad_account_id)||null,campaign_id:clean(b.campaign_id)||null,adset_id:clean(b.adset_id)||null,ad_id:adId,catalog_keys:keys,confidence:1,source:"manual_admin_v10",is_active:b.is_active!==false&&b.enabled!==false,metadata,updated_at:nowIso()};
      const saved=(await db("ai_ad_mappings?on_conflict=page_id,ad_id",{method:"POST",prefer:"resolution=merge-duplicates,return=representation",body:row}))?.[0]; res.json({ok:true,saved});
    }catch(e){res.status(400).json({ok:false,error:e.message});}
  });
  app.post("/api/v8-mapping-center/ad-mapping/disable", async (req,res)=>{try{const ad=clean(req.body?.ad_id);await db(`ai_ad_mappings?ad_id=eq.${encodeURIComponent(ad)}`,{method:"PATCH",body:{is_active:false,updated_at:nowIso()}});res.json({ok:true});}catch(e){res.status(400).json({ok:false,error:e.message});}});
  app.post("/api/v8-mapping-center/slide-mapping", async (req,res)=>{
    try{const b=req.body||{};const key=clean(b.product_key);if(!key)throw new Error("PRODUCT_KEY_REQUIRED");const cat=(await db(`ai_catalog_nodes?catalog_key=eq.${encodeURIComponent(key)}&select=*&limit=1`))?.[0];if(!cat)throw new Error("CATALOG_NOT_FOUND");const refs=(Array.isArray(b.drive_folder_ids)?b.drive_folder_ids:[]).map(x=>typeof x==="string"?{id:idFromUrl(x)}:{...x,id:idFromUrl(x?.id||x?.folder_id||x?.drive_folder_id)}).filter(x=>x.id);const first=refs[0]||null;const policy={...(cat.asset_policy||{}),page_id:clean(b.page_id)||null,drive_folder_ids:refs,drive_folder_id:first?.id||null,drive_folder_url:first?.id?`https://drive.google.com/drive/folders/${first.id}`:null,folder_path:first?.path||first?.name||null,priority:Number(b.priority||100),note:clean(b.note)||null,last_synced_at:cat.asset_policy?.last_synced_at||null};const saved=(await db(`ai_catalog_nodes?catalog_key=eq.${encodeURIComponent(key)}`,{method:"PATCH",body:{asset_policy:policy,is_active:b.is_active!==false,updated_at:nowIso()}}))?.[0]||{catalog_key:key};res.json({ok:true,saved:{id:key,product_key:key,product_name:cat.display_name,page_id:policy.page_id,drive_folder_ids:refs,drive_folder_id:policy.drive_folder_id,priority:policy.priority,is_active:b.is_active!==false,note:policy.note}});}catch(e){res.status(400).json({ok:false,error:e.message});}
  });

  const previewForCatalog = async (key,limit=10) => {
    const links=await db(`ai_catalog_assets?catalog_key=eq.${encodeURIComponent(key)}&asset_role=eq.slide&select=asset_id,sort_order&order=sort_order.asc&limit=${limit}`); if(!links?.length)return[]; const ids=links.map(x=>x.asset_id).join(","); return db(`ai_assets?id=in.(${ids})&is_active=eq.true&select=*&limit=${limit}`);
  };
  app.post("/api/v8-mapping-center/test", async (req,res)=>{
    try{const b=req.body||{};let key="";const ad=clean(b.ad_id);if(ad){const m=(await db(`ai_ad_mappings?ad_id=eq.${encodeURIComponent(ad)}&is_active=eq.true&select=*&order=updated_at.desc&limit=1`))?.[0];key=clean(m?.catalog_keys?.[0]);}if(!key){const cats=await catalogRows();key=catalogForPath(clean(b.message_text),cats)||"";}const assets=key?await previewForCatalog(key,10):[];res.json({ok:true,result:{status:key?"matched":"unmatched",source:ad?"ad_mapping_or_text":"text",confidence:key?1:0,group_key:key||null,catalog_key:key||null,apply_to_runtime:Boolean(key),conflict:false,needs_clarification:!key,slide_asset_count:assets.length},preview_assets:assets.map(a=>({...a,delivery_url:a.source_url,file_url:a.source_url,catalog_key:key}))});}catch(e){res.status(400).json({ok:false,error:e.message});}
  });

  app.get("/api/slide-manager/recipients", async (req,res)=>{try{const page=clean(req.query.page_id);const since=new Date(Date.now()-24*3600000).toISOString();const events=await db(`v9_events?page_id=eq.${encodeURIComponent(page)}&actor_type=eq.customer&event_type=eq.customer_message&occurred_at=gte.${encodeURIComponent(since)}&select=page_id,sender_id,message_text,occurred_at&order=occurred_at.desc&limit=500`);const seen=new Set(),recipients=[];for(const e of events||[]){const id=clean(e.sender_id);if(!id||seen.has(id))continue;seen.add(id);recipients.push({page_id:page,sender_id:id,label:`Khách …${id.slice(-6)}`,last_message:e.message_text,last_message_at:e.occurred_at,source:"V10 Core"});}res.json({ok:true,page_id:page,window_hours:24,recipients});}catch(e){res.status(400).json({ok:false,error:e.message});}});
  app.get("/api/slide-manager/meta-status", async (req,res)=>{res.json({ok:true,data:{ok:Boolean(process.env.META_ACCESS_TOKEN),page_id:clean(req.query.page_id),has_page_token:Boolean(process.env.META_ACCESS_TOKEN),has_pages_messaging:true,action_url:"/facebook-connect",message:"Meta connection available"}});});
  app.post("/api/slide-manager/test-slide", async (req,res)=>{
    try{const b=req.body||{};const page=clean(b.page_id),recipient=clean(b.recipient_id),key=clean(b.mapping_id).replace(/^catalog:/,"");if(!page||!recipient||!key)throw new Error("PAGE_RECIPIENT_MAPPING_REQUIRED");const since=new Date(Date.now()-24*3600000).toISOString();const recent=await db(`v9_events?page_id=eq.${encodeURIComponent(page)}&sender_id=eq.${encodeURIComponent(recipient)}&actor_type=eq.customer&event_type=eq.customer_message&occurred_at=gte.${encodeURIComponent(since)}&select=id&limit=1`);if(!recent?.length)throw new Error("CUSTOMER_OUTSIDE_24H_OR_WRONG_PAGE");const assets=await previewForCatalog(key,10);if(!assets.length)throw new Error("CATALOG_HAS_NO_MEDIA");const rootToken=clean(process.env.META_ACCESS_TOKEN||process.env.PAGE_ACCESS_TOKEN);if(!rootToken)throw new Error("META_TOKEN_MISSING");let pageToken=rootToken;try{const r=await fetch(`https://graph.facebook.com/v23.0/me/accounts?fields=id,access_token&limit=200&access_token=${encodeURIComponent(rootToken)}`,{signal:AbortSignal.timeout(15000)});const j=await r.json();pageToken=(j.data||[]).find(x=>String(x.id)===page)?.access_token||rootToken;}catch{}const cat=(await db(`ai_catalog_nodes?catalog_key=eq.${encodeURIComponent(key)}&select=display_name&limit=1`))?.[0];const elements=assets.map((a,i)=>({title:`${cat?.display_name||"Mẫu sản phẩm"} — Mẫu ${String(i+1).padStart(2,"0")}`.slice(0,80),image_url:a.source_url,subtitle:clean(a.file_name||"Mẫu").slice(0,80),default_action:{type:"web_url",url:a.source_url,webview_height_ratio:"full"}}));const response=await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(page)}/messages?access_token=${encodeURIComponent(pageToken)}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({recipient:{id:recipient},messaging_type:"RESPONSE",message:{attachment:{type:"template",payload:{template_type:"generic",image_aspect_ratio:"square",elements}}}}),signal:AbortSignal.timeout(30000)});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error?.message||`META_${response.status}`);res.json({ok:true,all_sent:true,delivery_type:"generic_template",message_count:1,slide_count:elements.length,message_id:data.message_id||null,recipient_id:data.recipient_id||recipient});}catch(e){res.status(400).json({ok:false,error:e.message});}
  });

  console.log(`[AIGUKA V10 media] Core Mapping/Drive/Test Slide routes installed; root=${rootFolderId ? "configured" : "missing"}`);
  setTimeout(async()=>{try{const count=await db("ai_assets?select=id&is_active=eq.true&limit=1");if(!count?.length&&driveKey&&rootFolderId){console.log("[AIGUKA V10 media] empty media Core detected; starting Drive bootstrap");await syncAll({force:true});}else await saveDriveConnectionMeta(null,null);}catch(e){console.error(`[AIGUKA V10 media] bootstrap check failed: ${e.message}`);}},2500).unref?.();
}
