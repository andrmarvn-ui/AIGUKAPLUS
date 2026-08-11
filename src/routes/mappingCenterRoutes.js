import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, '..', '..');
const publicDirectory = path.join(projectRoot, 'public');

export function installMappingCenter(app, options = {}) {
    const SUPABASE_URL = String(
        options.supabaseUrl ||
        process.env.SUPABASE_URL ||
        process.env.SUPABASE_PROJECT_URL ||
        process.env.NEXT_PUBLIC_SUPABASE_URL ||
        ''
    ).replace(/\/$/, '');
    const SUPABASE_KEY = String(
        options.serviceRoleKey ||
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.SUPABASE_KEY ||
        options.publishableKey ||
        process.env.SUPABASE_ANON_KEY ||
        ''
    );
    const MAPPING_ADMIN_KEY = String(
        options.mappingAdminKey ||
        process.env.MAPPING_ADMIN_KEY ||
        process.env.ADMIN_KEY ||
        process.env.ADMIN_API_KEY ||
        ''
    );
    const META_GRAPH_VERSION = String(process.env.META_GRAPH_VERSION || 'v23.0');
    const jsonBody = express.json({ limit: '2mb' });
    const metaAdsCache = { rows: [], adAccounts: [], businesses: [], loadedAt: 0 };

    function mappingApiReady() {
        return Boolean(SUPABASE_URL && SUPABASE_KEY);
    }

    function mappingHeaders(extra = {}) {
        return {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            ...extra
        };
    }

    async function supabaseRest(resource, options = {}) {
        if (!mappingApiReady()) {
            const error = new Error('Railway chưa có SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY.');
            error.status = 503;
            throw error;
        }
        const response = await fetch(`${SUPABASE_URL}/rest/v1/${resource}`, {
            ...options,
            headers: mappingHeaders(options.headers || {})
        });
        const raw = await response.text();
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = raw; }
        if (!response.ok) {
            const message = data?.message || data?.error || data?.hint || raw || `Supabase HTTP ${response.status}`;
            const error = new Error(message);
            error.status = response.status;
            error.details = data;
            throw error;
        }
        return data;
    }

    async function safeSupabaseRest(resource, fallback = [], options = {}) {
        try {
            return { data: await supabaseRest(resource, options), error: null };
        } catch (error) {
            console.warn(`[MAPPING_CENTER] ${resource}:`, error.message);
            return { data: fallback, error: error.message };
        }
    }

    function requireMappingWrite(req, res, next) {
        if (!MAPPING_ADMIN_KEY) {
            const origin = String(req.get('origin') || '');
            const referer = String(req.get('referer') || '');
            const host = String(req.get('host') || '');
            const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
            let sameOrigin = fetchSite === 'same-origin';
            for (const candidate of [origin, referer]) {
                if (!candidate || !host) continue;
                try {
                    sameOrigin ||= new URL(candidate).host === host;
                } catch (_) { /* Ignore malformed optional headers. */ }
            }
            if (!sameOrigin) {
                return res.status(403).json({ ok: false, error: 'Chỉ cho phép cập nhật Mapping từ trang quản trị AIGUKA.' });
            }
            return next();
        }
        const provided = String(req.get('x-admin-key') || req.query.admin_key || '');
        if (provided !== MAPPING_ADMIN_KEY) {
            return res.status(401).json({ ok: false, error: 'Sai khóa quản trị Mapping.', requires_admin_key: true });
        }
        return next();
    }

    function detachExactRoute(routePath) {
        const router = app._router;
        if (!router || !Array.isArray(router.stack)) return [];
        const removed = [];
        router.stack = router.stack.filter(layer => {
            if (layer?.route?.path === routePath) {
                removed.push(layer);
                return false;
            }
            return true;
        });
        return removed;
    }

    // Preserve the working Google Drive/OAuth page under a legacy URL, then replace
    // /drive-slides with the unified Mapping Center.
    const legacyDriveSlideLayers = detachExactRoute('/drive-slides');
    if (legacyDriveSlideLayers.length) {
        const handlers = legacyDriveSlideLayers.flatMap(layer =>
            Array.isArray(layer?.route?.stack) ? layer.route.stack.map(item => item.handle).filter(Boolean) : []
        );
        if (handlers.length) app.get('/drive-slides-legacy', ...handlers);
    }

    for (const fileName of ['drive-slides-v8.css', 'drive-slides-v8-core.js', 'drive-slides-v8-render.js']) {
        app.get(`/admin/${fileName}`, (_req, res) => { res.set('Cache-Control', 'no-store, max-age=0'); res.sendFile(path.join(publicDirectory, fileName)); });
    }
    app.get('/drive-slides', (_req, res) => { res.set('Cache-Control', 'no-store, max-age=0'); res.sendFile(path.join(publicDirectory, 'drive-slides-v8.html')); });

    function mappingFolderValues(mapping) {
        const preferred = Array.isArray(mapping?.resolved_folder_ids) && mapping.resolved_folder_ids.length
            ? mapping.resolved_folder_ids
            : (Array.isArray(mapping?.selected_folders) && mapping.selected_folders.length
                ? mapping.selected_folders
                : (Array.isArray(mapping?.drive_folders) ? mapping.drive_folders : []));
        return preferred.map(folderToken).filter(Boolean);
    }

    function mappingHasScope(mapping) {
        if (!mapping || mapping.is_active === false || mapping.enabled === false) return false;
        const productItemKey = String(mapping.product_item_key || '').trim();
        const productGroup = String(mapping.product_group || '').trim();
        return Boolean(productItemKey || (productGroup && productGroup !== 'general') || mappingFolderValues(mapping).length);
    }

    function aggregateCurrentAds(referrals = [], mappings = []) {
        const mappingByAd = new Map((Array.isArray(mappings) ? mappings : []).map(row => [String(row.ad_id || ''), row]));
        const byKey = new Map();
        for (const row of Array.isArray(referrals) ? referrals : []) {
            const adId = String(row.ad_id || '').trim();
            if (!adId) continue;
            const pageId = String(row.page_id || '').trim();
            const key = `${pageId}:${adId}`;
            const current = byKey.get(key) || {
                page_id: pageId,
                page_name: row.page_name || '',
                ad_id: adId,
                ad_title: row.ad_title || '',
                post_id: row.post_id || '',
                referral_source: row.referral_source || '',
                referrals: 0,
                customers: new Set(),
                contacts: new Set(),
                first_referral: row.referral_at || null,
                last_referral: row.referral_at || null
            };
            current.referrals += 1;
            if (row.sender_id) current.customers.add(String(row.sender_id));
            if ((row.has_phone || row.has_zalo) && row.sender_id) current.contacts.add(String(row.sender_id));
            if (row.ad_title && !current.ad_title) current.ad_title = row.ad_title;
            if (row.page_name && !current.page_name) current.page_name = row.page_name;
            if (row.post_id && !current.post_id) current.post_id = row.post_id;
            const time = row.referral_at ? new Date(row.referral_at).getTime() : 0;
            if (!current.last_referral || time > new Date(current.last_referral).getTime()) current.last_referral = row.referral_at;
            if (!current.first_referral || time < new Date(current.first_referral).getTime()) current.first_referral = row.referral_at;
            byKey.set(key, current);
        }
        return [...byKey.values()].map(row => {
            const mapping = mappingByAd.get(row.ad_id) || null;
            return {
                ...row,
                ad_title: row.ad_title || mapping?.ad_name || '',
                customers: row.customers.size,
                contacts: row.contacts.size,
                ad_account_id: mapping?.ad_account_id || '',
                ad_account_name: mapping?.ad_account_name || '',
                campaign_id: mapping?.campaign_id || '',
                campaign_name: mapping?.campaign_name || '',
                adset_id: mapping?.adset_id || '',
                adset_name: mapping?.adset_name || '',
                mapped: mappingHasScope(mapping),
                mapping
            };
        }).sort((a, b) => new Date(b.last_referral || 0) - new Date(a.last_referral || 0));
    }

    function aggregateAssets(assets = []) {
        const byCatalog = new Map();
        const folders = new Map();
        for (const row of Array.isArray(assets) ? assets : []) {
            const catalogKey = String(row.catalog_key || row.product_key || '').trim();
            let metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
            if (typeof row.metadata === 'string') {
                try { metadata = JSON.parse(row.metadata); } catch (_) { metadata = {}; }
            }
            if (catalogKey) {
                const current = byCatalog.get(catalogKey) || { catalog_key: catalogKey, product_key: row.product_key || '', images: 0, verified: 0, errors: 0, folders: new Set() };
                current.images += 1;
                if (row.delivery_status === 'verified') current.verified += 1;
                if (row.delivery_status === 'error') current.errors += 1;
                if (row.parent_folder_id) current.folders.add(String(row.parent_folder_id));
                byCatalog.set(catalogKey, current);
            }
            const folderId = String(row.parent_folder_id || '').trim();
            if (folderId) {
                const folderPath = String(metadata.folder_path || metadata.parent_folder_path || row.parent_folder_name || folderId).trim();
                const folder = folders.get(folderId) || {
                    folder_id: folderId,
                    folder_name: row.parent_folder_name || folderId,
                    folder_path: folderPath,
                    folder_url: row.parent_folder_url || '',
                    parent_folder_id: String(metadata.folder_parent_id || metadata.parent_folder_parent_id || '').trim() || null,
                    direct_images: 0,
                    catalogs: new Set()
                };
                if ((!folder.folder_path || folder.folder_path === folder.folder_name) && folderPath) folder.folder_path = folderPath;
                if (!folder.parent_folder_id && (metadata.folder_parent_id || metadata.parent_folder_parent_id)) {
                    folder.parent_folder_id = String(metadata.folder_parent_id || metadata.parent_folder_parent_id);
                }
                folder.direct_images += 1;
                if (catalogKey) folder.catalogs.add(catalogKey);
                folders.set(folderId, folder);
            }
        }
        return {
            by_catalog: [...byCatalog.values()].map(row => ({ ...row, folders: [...row.folders] })),
            folders: [...folders.values()].map(row => ({ ...row, catalogs: [...row.catalogs] })).sort((a, b) => a.folder_name.localeCompare(b.folder_name, 'vi'))
        };
    }

    function finalizeFolderHierarchy(rows = []) {
        const folders = (Array.isArray(rows) ? rows : []).map(row => ({
            ...row,
            folder_id: String(row.folder_id || '').trim(),
            folder_name: String(row.folder_name || row.folder_id || '').trim(),
            folder_path: String(row.folder_path || row.folder_name || row.folder_id || '').trim().replace(/\s*\/\s*/g, '/'),
            parent_folder_id: String(row.parent_folder_id || row.parent_id || '').trim() || null,
            direct_images: Number(row.direct_images ?? row.images ?? 0) || 0,
            catalogs: [...new Set(Array.isArray(row.catalogs) ? row.catalogs.map(String).filter(Boolean) : [])]
        })).filter(row => row.folder_id);
        const byId = new Map(folders.map(row => [row.folder_id, row]));
        const byPath = new Map();
        for (const row of folders) {
            const normalized = normalizedFolderPath(row.folder_path);
            if (!normalized) continue;
            const ids = byPath.get(normalized) || [];
            ids.push(row.folder_id);
            byPath.set(normalized, ids);
        }
        for (const row of folders) {
            if (row.parent_folder_id && byId.has(row.parent_folder_id) && row.parent_folder_id !== row.folder_id) continue;
            row.parent_folder_id = null;
            const segments = normalizedFolderPath(row.folder_path).split('/').filter(Boolean);
            while (segments.length > 1 && !row.parent_folder_id) {
                segments.pop();
                const candidates = (byPath.get(segments.join('/')) || []).filter(id => id !== row.folder_id);
                if (candidates.length === 1) row.parent_folder_id = candidates[0];
            }
        }
        const children = new Map();
        for (const row of folders) {
            if (!row.parent_folder_id || !byId.has(row.parent_folder_id)) continue;
            const list = children.get(row.parent_folder_id) || [];
            list.push(row.folder_id);
            children.set(row.parent_folder_id, list);
        }
        const memo = new Map();
        const summarize = (id, visiting = new Set()) => {
            if (memo.has(id)) return memo.get(id);
            const row = byId.get(id);
            if (!row || visiting.has(id)) return { images: 0, descendants: 0 };
            const nextVisiting = new Set(visiting).add(id);
            let images = row.direct_images;
            let descendants = 0;
            for (const childId of children.get(id) || []) {
                const child = summarize(childId, nextVisiting);
                images += child.images;
                descendants += 1 + child.descendants;
            }
            const result = { images, descendants };
            memo.set(id, result);
            return result;
        };
        for (const row of folders) {
            const summary = summarize(row.folder_id);
            row.images = summary.images;
            row.total_images = summary.images;
            row.direct_child_count = (children.get(row.folder_id) || []).length;
            row.child_count = summary.descendants;
        }
        return folders;
    }

    function mergeConfiguredFolders(assetSummary, catalogs = [], slideMappings = []) {
        const folders = new Map((assetSummary.folders || []).map(row => [String(row.folder_id || ''), row]));
        const addFolder = (value, fallback = {}) => {
            const id = String(typeof value === 'string' ? value : (value?.id || value?.folder_id || value?.drive_folder_id || '')).trim();
            if (!id) return;
            const current = folders.get(id) || {
                folder_id: id,
                folder_name: fallback.folder_name || value?.name || value?.path || id,
                folder_path: fallback.folder_path || value?.path || value?.name || id,
                folder_url: fallback.folder_url || value?.url || `https://drive.google.com/drive/folders/${id}`,
                parent_folder_id: fallback.parent_folder_id || value?.parent_id || value?.parent_folder_id || null,
                direct_images: 0,
                catalogs: []
            };
            if ((!current.folder_path || current.folder_path === current.folder_name) && fallback.folder_path) {
                current.folder_path = fallback.folder_path;
            }
            if (!current.parent_folder_id && (fallback.parent_folder_id || value?.parent_id || value?.parent_folder_id)) {
                current.parent_folder_id = String(fallback.parent_folder_id || value?.parent_id || value?.parent_folder_id);
            }
            const catalogKey = String(fallback.catalog_key || '').trim();
            current.catalogs = [...new Set([...(current.catalogs || []), ...(catalogKey ? [catalogKey] : [])])];
            folders.set(id, current);
        };
        const catalogByKey = new Map((Array.isArray(catalogs) ? catalogs : []).map(row => [String(row.catalog_key || ''), row]));
        for (const catalog of Array.isArray(catalogs) ? catalogs : []) {
            const parentCatalog = catalogByKey.get(String(catalog.parent_key || ''));
            addFolder(catalog.drive_folder_id, {
                folder_name: catalog.catalog_name,
                folder_path: catalog.folder_path || catalog.catalog_name,
                folder_url: catalog.drive_folder_url,
                parent_folder_id: parentCatalog?.drive_folder_id || null,
                catalog_key: catalog.catalog_key
            });
        }
        for (const mapping of Array.isArray(slideMappings) ? slideMappings : []) {
            const configured = Array.isArray(mapping.drive_folder_ids) ? mapping.drive_folder_ids : [];
            for (const folder of configured) addFolder(folder, { catalog_key: mapping.product_key });
            addFolder(mapping.drive_folder_id, {
                folder_name: mapping.product_name,
                folder_url: mapping.drive_folder_url,
                catalog_key: mapping.product_key
            });
        }
        assetSummary.folders = finalizeFolderHierarchy([...folders.values()]);
        return assetSummary;
    }

    function folderToken(value) {
        if (typeof value === 'string') return value.trim();
        if (!value || typeof value !== 'object') return '';
        return String(value.id || value.folder_id || value.drive_folder_id || value.path || value.name || '').trim();
    }

    function normalizedFolderPath(value) {
        return String(value || '')
            .trim()
            .replace(/^https?:\/\/drive\.google\.com\/drive\/folders\//i, '')
            .replace(/[?#].*$/, '')
            .replace(/^bathroom(?=\/|$)/i, 'PHÒNG TẮM')
            .replace(/^kitchen(?=\/|$)/i, 'PHÒNG BẾP')
            .replace(/^phòng tắm\/sen vòi 01$/i, 'PHÒNG TẮM/SEN CÂY/Sen vòi')
            .replace(/^phòng tắm\/tủ chậu gương$/i, 'PHÒNG TẮM/GƯƠNG-TỦ')
            .replace(/\s*[-–—]\s*/g, '-')
            .replace(/\s*\/\s*/g, '/')
            .toLocaleLowerCase('vi-VN');
    }

    function buildFolderLookup(folders = [], catalogs = []) {
        const byId = new Map();
        const byPath = new Map();
        const byLeaf = new Map();
        const remember = (map, key, id) => {
            if (!key || !id) return;
            const current = map.get(key) || new Set();
            current.add(id);
            map.set(key, current);
        };
        for (const folder of Array.isArray(folders) ? folders : []) {
            const id = String(folder.folder_id || '').trim();
            if (!id) continue;
            byId.set(id, id);
            for (const value of [folder.folder_name, folder.folder_path]) {
                const normalized = normalizedFolderPath(value);
                remember(byPath, normalized, id);
                remember(byLeaf, normalized.split('/').pop(), id);
            }
        }
        for (const catalog of Array.isArray(catalogs) ? catalogs : []) {
            const id = String(catalog.drive_folder_id || '').trim();
            if (!id) continue;
            byId.set(id, id);
            const normalized = normalizedFolderPath(catalog.folder_path || catalog.catalog_name);
            remember(byPath, normalized, id);
            remember(byLeaf, normalized.split('/').pop(), id);
        }
        return { byId, byPath, byLeaf };
    }

    function canonicalFolderIds(values, lookup) {
        const ids = [];
        for (const value of Array.isArray(values) ? values : []) {
            const token = folderToken(value);
            if (!token) continue;
            const urlId = token.match(/\/folders\/([a-z0-9_-]+)/i)?.[1] || token.match(/[?&]id=([a-z0-9_-]+)/i)?.[1] || '';
            const direct = lookup.byId.get(token) || lookup.byId.get(urlId);
            if (direct) {
                ids.push(direct);
                continue;
            }
            const normalized = normalizedFolderPath(token);
            let candidates = lookup.byPath.get(normalized);
            if (!candidates || candidates.size !== 1) candidates = lookup.byLeaf.get(normalized.split('/').pop());
            if (candidates?.size === 1) ids.push([...candidates][0]);
        }
        return [...new Set(ids)];
    }

    function normalizeStoredMappings(mappings, folders, catalogs) {
        const lookup = buildFolderLookup(folders, catalogs);
        return (Array.isArray(mappings) ? mappings : []).map(mapping => {
            const stored = Array.isArray(mapping.selected_folders) && mapping.selected_folders.length
                ? mapping.selected_folders
                : (Array.isArray(mapping.drive_folders) ? mapping.drive_folders : []);
            const resolvedFolderIds = canonicalFolderIds(stored, lookup);
            const normalized = {
                ...mapping,
                resolved_folder_ids: resolvedFolderIds,
                folder_sync_status: !stored.length ? 'empty' : (resolvedFolderIds.length === stored.length ? 'synced' : 'partial')
            };
            return { ...normalized, scope_status: mappingHasScope(normalized) ? 'ready' : 'missing_scope' };
        });
    }

    function normalizeAccountRows(...sources) {
        const accounts = new Map();
        for (const source of sources) {
            for (const row of Array.isArray(source) ? source : []) {
                const id = String(row.ad_account_id || row.account_id || row.id || '').replace(/^act_/, '').trim();
                if (!id || row.is_active === false) continue;
                const current = accounts.get(id) || { ad_account_id: id };
                accounts.set(id, {
                    ...current,
                    ad_account_name: row.ad_account_name || row.account_name || row.name || current.ad_account_name || id,
                    business_id: String(row.business_id || row.business?.id || current.business_id || '').trim(),
                    business_name: row.business_name || row.business?.name || current.business_name || '',
                    account_status: row.account_status || current.account_status || '',
                    timezone_name: row.timezone_name || current.timezone_name || '',
                    timezone_offset_hours_utc: row.timezone_offset_hours_utc ?? current.timezone_offset_hours_utc ?? null,
                    source: row.source || current.source || 'supabase'
                });
            }
        }
        return [...accounts.values()].sort((a, b) => String(a.ad_account_name).localeCompare(String(b.ad_account_name), 'vi'));
    }

    function normalizedMetaStatus(value) {
        return String(value ?? '').trim().toUpperCase();
    }

    function adAccountDeliveryStatus(value) {
        const status = normalizedMetaStatus(value);
        if (!status || status === '1' || status === 'ACTIVE') return '';
        const labels = {
            '2': 'ACCOUNT_DISABLED',
            DISABLED: 'ACCOUNT_DISABLED',
            '3': 'ACCOUNT_UNSETTLED',
            UNSETTLED: 'ACCOUNT_UNSETTLED',
            '7': 'ACCOUNT_PENDING_RISK_REVIEW',
            PENDING_RISK_REVIEW: 'ACCOUNT_PENDING_RISK_REVIEW',
            '8': 'ACCOUNT_PENDING_SETTLEMENT',
            PENDING_SETTLEMENT: 'ACCOUNT_PENDING_SETTLEMENT',
            '9': 'ACCOUNT_IN_GRACE_PERIOD',
            IN_GRACE_PERIOD: 'ACCOUNT_IN_GRACE_PERIOD',
            '100': 'ACCOUNT_PENDING_CLOSURE',
            PENDING_CLOSURE: 'ACCOUNT_PENDING_CLOSURE',
            '101': 'ACCOUNT_CLOSED',
            CLOSED: 'ACCOUNT_CLOSED'
        };
        return labels[status] || 'ACCOUNT_INACTIVE';
    }

    function hierarchyDeliveryStatus(ad, account = {}) {
        const accountStatus = adAccountDeliveryStatus(account.account_status);
        if (accountStatus) return accountStatus;

        const campaignStatus = normalizedMetaStatus(ad.campaign?.effective_status || ad.campaign?.status);
        if (campaignStatus && campaignStatus !== 'ACTIVE') {
            return campaignStatus === 'PAUSED' ? 'CAMPAIGN_PAUSED' : campaignStatus;
        }

        const adsetStatus = normalizedMetaStatus(ad.adset?.effective_status || ad.adset?.status);
        if (adsetStatus && adsetStatus !== 'ACTIVE') {
            return adsetStatus === 'PAUSED' ? 'ADSET_PAUSED' : adsetStatus;
        }

        return normalizedMetaStatus(ad.effective_status || ad.status) || 'UNKNOWN';
    }

    function metaMetricNumber(value) {
        const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function metaAccountLocalHour(account = {}) {
        const timezoneName = String(account.timezone_name || '').trim();
        if (timezoneName) {
            try {
                const formatted = new Intl.DateTimeFormat('en-GB', {
                    timeZone: timezoneName,
                    hour: '2-digit',
                    hourCycle: 'h23'
                }).format(new Date());
                const hour = Number(formatted);
                if (Number.isFinite(hour)) return hour;
            } catch (_) { /* Fall back to the numeric Meta offset. */ }
        }
        const offset = Number(account.timezone_offset_hours_utc);
        if (Number.isFinite(offset)) return new Date(Date.now() + offset * 3600000).getUTCHours();
        return new Date().getUTCHours();
    }

    function metaRootToken() {
        return String(
            process.env.META_ACCESS_TOKEN ||
            process.env.META_USER_ACCESS_TOKEN ||
            process.env.FACEBOOK_USER_ACCESS_TOKEN ||
            process.env.USER_ACCESS_TOKEN ||
            ''
        ).trim();
    }

    async function metaJson(url) {
        const response = await fetch(url, { signal: AbortSignal.timeout(30000), cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data?.error) {
            const error = new Error(data?.error?.message || `Meta HTTP ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return data;
    }

    async function metaPages(url, maxPages = 20) {
        const rows = [];
        let next = url;
        let page = 0;
        while (next && page < maxPages) {
            const data = await metaJson(next);
            rows.push(...(Array.isArray(data?.data) ? data.data : []));
            next = data?.paging?.next || '';
            page += 1;
        }
        return rows;
    }

    function configuredAdAccountIds() {
        return [...new Set(String(
            process.env.META_AD_ACCOUNT_IDS ||
            process.env.META_AD_ACCOUNTS ||
            process.env.META_AD_ACCOUNT_ID ||
            ''
        ).split(/[;,\s]+/).map(value => value.replace(/^act_/, '').trim()).filter(Boolean))];
    }

    async function fetchCurrentMetaAds(force = false) {
        if (!force && metaAdsCache.loadedAt && Date.now() - metaAdsCache.loadedAt < 180000) {
            return {
                rows: metaAdsCache.rows,
                ad_accounts: metaAdsCache.adAccounts,
                businesses: metaAdsCache.businesses
            };
        }
        const token = metaRootToken();
        if (!token) {
            const error = new Error('Chưa có kết nối Meta để đồng bộ danh sách quảng cáo.');
            error.status = 503;
            throw error;
        }
        let visibleAccounts = [];
        let visibleBusinesses = [];
        try {
            const fields = 'id,account_id,name,account_status,timezone_name,timezone_offset_hours_utc,business{id,name}';
            const accountUrl = `https://graph.facebook.com/${META_GRAPH_VERSION}/me/adaccounts?fields=${encodeURIComponent(fields)}&limit=200&access_token=${encodeURIComponent(token)}`;
            visibleAccounts = await metaPages(accountUrl, 5);
        } catch (error) {
            console.warn('[MAPPING_CENTER] Meta visible ad accounts:', error.message);
        }
        try {
            const businessUrl = `https://graph.facebook.com/${META_GRAPH_VERSION}/me/businesses?fields=id,name&limit=200&access_token=${encodeURIComponent(token)}`;
            visibleBusinesses = await metaPages(businessUrl, 5);
        } catch (error) {
            console.warn('[MAPPING_CENTER] Meta visible businesses:', error.message);
        }
        const adAccounts = normalizeAccountRows(visibleAccounts, configuredAdAccountIds().map(id => ({ ad_account_id: id, source: 'railway_config' })));
        const accountIds = adAccounts.map(row => row.ad_account_id);
        const accountById = new Map(adAccounts.map(row => [row.ad_account_id, row]));
        const businesses = new Map();
        for (const row of visibleBusinesses) {
            const id = String(row.id || '').trim();
            if (id) businesses.set(id, { business_id: id, business_name: row.name || id });
        }
        for (const row of adAccounts) {
            if (row.business_id && !businesses.has(row.business_id)) {
                businesses.set(row.business_id, { business_id: row.business_id, business_name: row.business_name || row.business_id });
            }
        }
        const batches = await Promise.all(accountIds.map(async accountId => {
            const fields = 'id,name,status,effective_status,configured_status,account_id,campaign{id,name,status,effective_status},adset{id,name,status,effective_status,promoted_object}';
            const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/act_${encodeURIComponent(accountId)}/ads?fields=${encodeURIComponent(fields)}&limit=500&access_token=${encodeURIComponent(token)}`;
            const insightFields = 'spend,impressions,reach,date_start,date_stop';
            const todayInsightUrl = `https://graph.facebook.com/${META_GRAPH_VERSION}/act_${encodeURIComponent(accountId)}/insights?fields=${encodeURIComponent(insightFields)}&date_preset=today&level=account&limit=1&access_token=${encodeURIComponent(token)}`;
            const yesterdayInsightUrl = `https://graph.facebook.com/${META_GRAPH_VERSION}/act_${encodeURIComponent(accountId)}/insights?fields=${encodeURIComponent(insightFields)}&date_preset=yesterday&level=account&limit=1&access_token=${encodeURIComponent(token)}`;
            const account = accountById.get(accountId) || {};
            const localHour = metaAccountLocalHour(account);
            const midnightGraceHours = Math.min(Math.max(Number(process.env.META_MIDNIGHT_GRACE_HOURS || 4), 0), 8);
            const shouldCheckYesterday = localHour < midnightGraceHours;
            const readInsight = async (insightUrl, label) => metaPages(insightUrl, 2)
                .then(rows => ({ rows, verified: true }))
                .catch(error => {
                    console.warn(`[MAPPING_CENTER] Meta account ${label} insights ${accountId}:`, error.message);
                    return { rows: [], verified: false };
                });
            try {
                const [ads, todayResult, yesterdayResult] = await Promise.all([
                    metaPages(url, 10),
                    readInsight(todayInsightUrl, 'today'),
                    shouldCheckYesterday ? readInsight(yesterdayInsightUrl, 'yesterday') : Promise.resolve({ rows: [], verified: false })
                ]);
                const todayInsight = todayResult.rows[0] || {};
                const yesterdayInsight = yesterdayResult.rows[0] || {};
                const todaySpend = metaMetricNumber(todayInsight.spend);
                const todayImpressions = metaMetricNumber(todayInsight.impressions);
                const yesterdaySpend = metaMetricNumber(yesterdayInsight.spend);
                const yesterdayImpressions = metaMetricNumber(yesterdayInsight.impressions);
                const accountHasDeliveryToday = todayResult.verified && (todaySpend > 0 || todayImpressions > 0);
                const accountHasDeliveryYesterday = shouldCheckYesterday && yesterdayResult.verified && (yesterdaySpend > 0 || yesterdayImpressions > 0);
                const accountHasRecentDelivery = accountHasDeliveryToday || accountHasDeliveryYesterday;
                const deliveryVerified = todayResult.verified || (shouldCheckYesterday && yesterdayResult.verified);
                Object.assign(account, {
                    account_delivery_verified: deliveryVerified,
                    account_has_delivery_today: accountHasDeliveryToday,
                    account_has_recent_delivery: accountHasRecentDelivery,
                    delivery_basis: accountHasDeliveryToday ? 'today' : (accountHasDeliveryYesterday ? 'previous_day_midnight_grace' : 'none'),
                    account_local_hour: localHour,
                    today_spend: todaySpend,
                    today_impressions: todayImpressions,
                    today_reach: metaMetricNumber(todayInsight.reach),
                    previous_day_spend: yesterdaySpend,
                    previous_day_impressions: yesterdayImpressions,
                    insights_date_start: todayInsight.date_start || yesterdayInsight.date_start || '',
                    insights_date_stop: todayInsight.date_stop || yesterdayInsight.date_stop || ''
                });
                return ads.map(ad => {
                    const resolvedAccountId = String(ad.account_id || accountId).replace(/^act_/, '');
                    const resolvedAccount = accountById.get(resolvedAccountId) || account;
                    const hierarchyStatus = hierarchyDeliveryStatus(ad, resolvedAccount);
                    const deliveryStatus = hierarchyStatus === 'ACTIVE'
                        ? (resolvedAccount.account_delivery_verified
                            ? (resolvedAccount.account_has_recent_delivery ? 'ACTIVE' : 'ACCOUNT_NO_DELIVERY')
                            : 'DELIVERY_UNVERIFIED')
                        : hierarchyStatus;
                    return {
                        ad_id: String(ad.id || ''),
                        ad_name: ad.name || '',
                        ad_account_id: resolvedAccountId,
                        ad_account_name: resolvedAccount.ad_account_name || '',
                        account_status: resolvedAccount.account_status ?? '',
                        account_delivery_verified: Boolean(resolvedAccount.account_delivery_verified),
                        account_has_delivery_today: Boolean(resolvedAccount.account_has_delivery_today),
                        account_has_recent_delivery: Boolean(resolvedAccount.account_has_recent_delivery),
                        delivery_basis: resolvedAccount.delivery_basis || 'none',
                        account_local_hour: resolvedAccount.account_local_hour ?? null,
                        timezone_name: resolvedAccount.timezone_name || '',
                        today_spend: resolvedAccount.today_spend || 0,
                        previous_day_spend: resolvedAccount.previous_day_spend || 0,
                        today_impressions: resolvedAccount.today_impressions || 0,
                        insights_date_start: resolvedAccount.insights_date_start || '',
                        insights_date_stop: resolvedAccount.insights_date_stop || '',
                        business_id: resolvedAccount.business_id || '',
                        business_name: resolvedAccount.business_name || '',
                        campaign_id: String(ad.campaign?.id || ''),
                        campaign_name: ad.campaign?.name || '',
                        campaign_status: ad.campaign?.status || '',
                        campaign_effective_status: ad.campaign?.effective_status || '',
                        adset_id: String(ad.adset?.id || ''),
                        adset_name: ad.adset?.name || '',
                        adset_status: ad.adset?.status || '',
                        adset_effective_status: ad.adset?.effective_status || '',
                        page_id: String(ad.adset?.promoted_object?.page_id || ''),
                        status: ad.status || '',
                        effective_status: ad.effective_status || '',
                        configured_status: ad.configured_status || '',
                        hierarchy_status: hierarchyStatus,
                        delivery_status: deliveryStatus
                    };
                });
            } catch (error) {
                console.warn(`[MAPPING_CENTER] Meta account ${accountId}:`, error.message);
                return [];
            }
        }));
        const visibleStatuses = new Set([
            'ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED',
            'PENDING_REVIEW', 'IN_PROCESS', 'WITH_ISSUES', 'PREAPPROVED', 'DISAPPROVED'
        ]);
        const rows = batches.flat().filter(row => row.ad_id && visibleStatuses.has(String(row.effective_status || row.status || '').toUpperCase()));
        metaAdsCache.rows = rows;
        metaAdsCache.adAccounts = adAccounts;
        metaAdsCache.businesses = [...businesses.values()].sort((a, b) => String(a.business_name).localeCompare(String(b.business_name), 'vi'));
        metaAdsCache.loadedAt = Date.now();
        return { rows, ad_accounts: metaAdsCache.adAccounts, businesses: metaAdsCache.businesses };
    }

    app.get('/api/v8-mapping-center/bootstrap', async (req, res) => {
        try {
            const days = Math.min(Math.max(Number(req.query.days || 45), 7), 180);
            const since = new Date(Date.now() - days * 86400000).toISOString();
            const queries = await Promise.all([
                safeSupabaseRest('v8_pages?select=page_id,page_name,is_active&order=page_name.asc'),
                safeSupabaseRest('v8_mapping_runtime?select=*&order=page_id.asc'),
                safeSupabaseRest('v8_business_product_groups?select=group_key,group_name,priority,is_active&is_active=eq.true&order=priority.asc'),
                safeSupabaseRest('v8_product_catalog?select=catalog_key,catalog_name,parent_key,root_product_key,drive_folder_id,drive_folder_url,folder_path,level_no,is_sendable,is_active,metadata,created_at,updated_at&order=level_no.asc,catalog_name.asc'),
                safeSupabaseRest('ad_mappings?select=*&order=updated_at.desc&limit=2000'),
                safeSupabaseRest('v8_slide_mapping?select=*&order=priority.asc,product_name.asc&limit=1000'),
                safeSupabaseRest(`v8_meta_ad_referral_entries?select=page_id,page_name,sender_id,ad_id,ad_title,post_id,referral_source,referral_at,has_phone,has_zalo&is_ad_referral=eq.true&referral_at=gte.${encodeURIComponent(since)}&order=referral_at.desc&limit=10000`),
                safeSupabaseRest('v8_drive_assets?select=product_key,catalog_key,parent_folder_id,parent_folder_name,parent_folder_url,is_image,is_active,delivery_status,metadata&is_active=eq.true&is_image=eq.true&limit=10000'),
                safeSupabaseRest("v8_admin_change_log?select=*&or=(asset_type.ilike.*mapping*,action.ilike.*mapping*)&order=created_at.desc&limit=50"),
                safeSupabaseRest('v8_meta_ad_account_registry?select=ad_account_id,ad_account_name,business_id,account_status,is_active,source,last_verified_at&is_active=eq.true&order=ad_account_name.asc'),
                safeSupabaseRest('v8_meta_ad_accounts?select=ad_account_id,ad_account_name,business_id,account_status,is_active,source,last_verified_at&is_active=eq.true&order=ad_account_name.asc')
            ]);
            const [pages, runtime, groups, catalogs, mappings, slideMappings, referrals, assets, changeLog, accountRegistry, metaAccounts] = queries;
            const activeCatalogs = (Array.isArray(catalogs.data) ? catalogs.data : []).filter(row => row.is_active !== false);
            const assetSummary = mergeConfiguredFolders(aggregateAssets(assets.data), activeCatalogs, slideMappings.data);
            const normalizedMappings = normalizeStoredMappings(mappings.data, assetSummary.folders, activeCatalogs);
            const currentAds = aggregateCurrentAds(referrals.data, normalizedMappings);
            const mappingAccounts = normalizedMappings.map(row => ({
                ad_account_id: row.ad_account_id,
                ad_account_name: row.ad_account_name,
                account_status: row.account_status,
                source: 'ad_mapping'
            }));
            const adAccounts = normalizeAccountRows(accountRegistry.data, metaAccounts.data, metaAdsCache.adAccounts, mappingAccounts);
            const businesses = new Map(metaAdsCache.businesses.map(row => [String(row.business_id || ''), row]));
            for (const account of adAccounts) {
                if (account.business_id && !businesses.has(account.business_id)) {
                    businesses.set(account.business_id, { business_id: account.business_id, business_name: account.business_name || account.business_id });
                }
            }
            const mappedCurrent = currentAds.filter(row => row.mapped).length;
            res.json({
                ok: true,
                version: 'railway_unified_mapping_center_v2',
                generated_at: new Date().toISOString(),
                days,
                requires_admin_key: Boolean(MAPPING_ADMIN_KEY),
                pages: pages.data,
                runtime: runtime.data,
                groups: groups.data,
                catalogs: activeCatalogs,
                all_catalogs: catalogs.data,
                mappings: normalizedMappings,
                slide_mappings: slideMappings.data,
                current_ads: currentAds,
                ad_accounts: adAccounts,
                businesses: [...businesses.values()].filter(row => row.business_id).sort((a, b) => String(a.business_name).localeCompare(String(b.business_name), 'vi')),
                asset_summary: assetSummary,
                change_log: changeLog.data,
                summary: {
                    current_ads: currentAds.length,
                    mapped_current_ads: mappedCurrent,
                    unmapped_current_ads: currentAds.length - mappedCurrent,
                    total_mappings: normalizedMappings.length,
                    active_images: Array.isArray(assets.data) ? assets.data.length : 0
                },
                warnings: queries.map(item => item.error).filter(Boolean)
            });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: error.message, details: error.details || null });
        }
    });

    app.get('/api/ad-mapping/meta', async (req, res) => {
        try {
            const force = String(req.query.sync || '') === '1';
            const snapshot = await fetchCurrentMetaAds(force);
            res.json({ ok: true, ...snapshot, synced_at: new Date(metaAdsCache.loadedAt).toISOString(), source: 'meta_graph' });
        } catch (error) {
            res.status(error.status || 502).json({ ok: false, error: error.message });
        }
    });

    function catalogMetadata(value) {
        if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
        if (typeof value === 'string') {
            try {
                const parsed = JSON.parse(value);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
            } catch (_) { /* Ignore malformed legacy metadata. */ }
        }
        return {};
    }

    function catalogAdminOrder(row) {
        const metadata = catalogMetadata(row?.metadata);
        const value = Number(metadata.admin_order ?? metadata.sort_order);
        return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
    }

    function sortCatalogSiblings(rows = []) {
        return [...rows].sort((a, b) =>
            catalogAdminOrder(a) - catalogAdminOrder(b) ||
            String(a.catalog_name || a.catalog_key).localeCompare(String(b.catalog_name || b.catalog_key), 'vi', { numeric: true, sensitivity: 'base' })
        );
    }

    async function loadCatalogAdminRows() {
        const rows = await supabaseRest('v8_product_catalog?select=catalog_key,catalog_name,parent_key,root_product_key,drive_folder_id,drive_folder_url,folder_path,level_no,is_sendable,is_active,metadata,created_at,updated_at&order=level_no.asc,catalog_name.asc&limit=5000');
        return Array.isArray(rows) ? rows : [];
    }

    function computeCatalogHierarchy(rows = []) {
        const byKey = new Map(rows.map(row => [String(row.catalog_key || ''), row]));
        const memo = new Map();
        const visiting = new Set();
        const compute = key => {
            if (memo.has(key)) return memo.get(key);
            const row = byKey.get(key);
            if (!row) {
                const error = new Error(`Không tìm thấy catalog ${key}.`);
                error.status = 400;
                throw error;
            }
            if (visiting.has(key)) {
                const error = new Error('Cấu trúc catalog tạo thành vòng lặp cha — con.');
                error.status = 400;
                throw error;
            }
            visiting.add(key);
            const parentKey = String(row.parent_key || '').trim();
            let levelNo = 1;
            let rootProductKey = key;
            if (parentKey) {
                const parent = byKey.get(parentKey);
                if (!parent) {
                    const error = new Error(`Catalog cha ${parentKey} không tồn tại.`);
                    error.status = 400;
                    throw error;
                }
                const parentHierarchy = compute(parentKey);
                levelNo = parentHierarchy.level_no + 1;
                rootProductKey = row.is_sendable !== false && parent.is_sendable === false
                    ? key
                    : (parentHierarchy.root_product_key || parentKey);
            }
            visiting.delete(key);
            const result = { level_no: levelNo, root_product_key: rootProductKey };
            memo.set(key, result);
            return result;
        };
        for (const key of byKey.keys()) compute(key);
        return memo;
    }

    async function catalogDisableBlockers(rows, catalogKey) {
        const activeChildren = rows.filter(row => String(row.parent_key || '') === catalogKey && row.is_active !== false);
        const [adMappings, slideMappings] = await Promise.all([
            supabaseRest(`ad_mappings?select=id,ad_id,ad_name,product_item_key,is_active,enabled&product_item_key=eq.${encodeURIComponent(catalogKey)}&limit=50`),
            supabaseRest(`v8_slide_mapping?select=id,product_key,product_name,is_active&product_key=eq.${encodeURIComponent(catalogKey)}&limit=50`)
        ]);
        return {
            children: activeChildren.map(row => ({ catalog_key: row.catalog_key, catalog_name: row.catalog_name })),
            ad_mappings: (Array.isArray(adMappings) ? adMappings : []).filter(row =>
                String(row.product_item_key || '') === catalogKey && row.is_active !== false && row.enabled !== false
            ),
            slide_mappings: (Array.isArray(slideMappings) ? slideMappings : []).filter(row =>
                String(row.product_key || '') === catalogKey && row.is_active !== false
            )
        };
    }

    function hasCatalogBlockers(blockers) {
        return blockers.children.length || blockers.ad_mappings.length || blockers.slide_mappings.length;
    }

    async function logCatalogChange(action, catalogKey, beforeData, afterData) {
        await safeSupabaseRest('v8_admin_change_log', [], {
            method: 'POST',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
                actor: 'railway_mapping_center',
                action,
                asset_type: 'catalog_mapping',
                asset_id: catalogKey,
                before_data: beforeData || null,
                after_data: afterData || null
            })
        });
    }

    // AIGUKA_CATALOG_KEY_RENAME_V2
    app.post('/api/v8-mapping-center/catalog/rename', jsonBody, requireMappingWrite, async (req, res) => {
        try {
            const oldCatalogKey = String(req.body?.old_catalog_key || '').trim().toLowerCase();
            const newCatalogKey = String(req.body?.new_catalog_key || '').trim().toLowerCase();
            const validKey = value => /^[a-z0-9][a-z0-9_]{0,79}$/.test(value);
            if (!validKey(oldCatalogKey) || !validKey(newCatalogKey)) {
                return res.status(400).json({ ok: false, error: 'Mã catalog chỉ gồm chữ thường không dấu, số và dấu gạch dưới.' });
            }
            if (oldCatalogKey === newCatalogKey) return res.json({ ok: true, unchanged: true });

            const rows = await loadCatalogAdminRows();
            const existing = rows.find(row => String(row.catalog_key) === oldCatalogKey) || null;
            if (!existing) return res.status(404).json({ ok: false, error: `Không tìm thấy catalog ${oldCatalogKey}.` });
            if (rows.some(row => String(row.catalog_key) === newCatalogKey)) {
                return res.status(409).json({ ok: false, error: `Mã catalog ${newCatalogKey} đã tồn tại.` });
            }

            const result = await supabaseRest('rpc/v8_admin_rename_catalog_key', {
                method: 'POST',
                headers: { Prefer: 'return=representation' },
                body: JSON.stringify({
                    p_old_catalog_key: oldCatalogKey,
                    p_new_catalog_key: newCatalogKey
                })
            });
            const afterRows = await loadCatalogAdminRows();
            const saved = afterRows.find(row => String(row.catalog_key) === newCatalogKey) || null;
            await logCatalogChange('rename_catalog_mapping', newCatalogKey, existing, saved || { catalog_key: newCatalogKey, rename_result: result });
            return res.json({ ok: true, result, saved });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: error.message, details: error.details || null });
        }
    });

    app.post('/api/v8-mapping-center/catalog', jsonBody, requireMappingWrite, async (req, res) => {
        try {
            const input = req.body || {};
            const catalogKey = String(input.catalog_key || '').trim().toLowerCase();
            const catalogName = String(input.catalog_name || '').trim();
            const parentKey = String(input.parent_key || '').trim() || null;
            const isNew = input.is_new === true;
            if (!/^[a-z0-9][a-z0-9_]{0,79}$/.test(catalogKey)) {
                return res.status(400).json({ ok: false, error: 'Mã catalog chỉ gồm chữ thường không dấu, số và dấu gạch dưới.' });
            }
            if (!catalogName || catalogName.length > 160) {
                return res.status(400).json({ ok: false, error: 'Tên catalog phải có từ 1 đến 160 ký tự.' });
            }

            const rows = await loadCatalogAdminRows();
            const existing = rows.find(row => String(row.catalog_key) === catalogKey) || null;
            if (isNew && existing) return res.status(409).json({ ok: false, error: `Mã catalog ${catalogKey} đã tồn tại.` });
            if (!isNew && !existing) return res.status(404).json({ ok: false, error: `Không tìm thấy catalog ${catalogKey}.` });
            if (parentKey === catalogKey) return res.status(400).json({ ok: false, error: 'Catalog không thể là cha của chính nó.' });

            const parent = parentKey ? rows.find(row => String(row.catalog_key) === parentKey) : null;
            if (parentKey && !parent) return res.status(400).json({ ok: false, error: 'Catalog cha không tồn tại.' });
            const desiredActive = input.is_active !== false;
            if (desiredActive && parent?.is_active === false) {
                return res.status(409).json({ ok: false, error: 'Hãy bật catalog cha trước khi bật hoặc chuyển catalog con vào đó.' });
            }
            if (existing && parentKey && catalogDescendants(rows, catalogKey).has(parentKey)) {
                return res.status(400).json({ ok: false, error: 'Không thể chuyển catalog vào bên trong một catalog con của chính nó.' });
            }
            if (existing?.is_active !== false && !desiredActive) {
                const blockers = await catalogDisableBlockers(rows, catalogKey);
                if (hasCatalogBlockers(blockers)) {
                    return res.status(409).json({
                        ok: false,
                        error: 'Catalog vẫn còn catalog con hoặc Mapping đang sử dụng. Hãy chuyển/tắt các mục liên quan trước.',
                        blockers
                    });
                }
            }

            const parentChanged = Boolean(existing) && String(existing.parent_key || '') !== String(parentKey || '');
            const siblingRows = rows.filter(row => String(row.parent_key || '') === String(parentKey || '') && String(row.catalog_key) !== catalogKey);
            const nextOrder = sortCatalogSiblings(siblingRows).reduce((max, row, index) => {
                const value = catalogAdminOrder(row);
                return Math.max(max, Number.isFinite(value) && value < Number.MAX_SAFE_INTEGER ? value : (index + 1) * 10);
            }, 0) + 10;
            const metadata = catalogMetadata(existing?.metadata);
            if (isNew || parentChanged || !Number.isFinite(Number(metadata.admin_order))) metadata.admin_order = nextOrder;
            const proposed = {
                ...(existing || {}),
                catalog_key: catalogKey,
                catalog_name: catalogName,
                parent_key: parentKey,
                is_sendable: input.is_sendable !== false,
                is_active: desiredActive,
                metadata
            };
            const proposedRows = existing
                ? rows.map(row => String(row.catalog_key) === catalogKey ? proposed : row)
                : [...rows, proposed];
            const hierarchy = computeCatalogHierarchy(proposedRows);
            const now = new Date().toISOString();
            let saved;
            if (!existing) {
                const computed = hierarchy.get(catalogKey);
                const row = {
                    catalog_key: catalogKey,
                    catalog_name: catalogName,
                    parent_key: parentKey,
                    root_product_key: computed.root_product_key,
                    drive_folder_id: null,
                    drive_folder_url: null,
                    folder_path: null,
                    level_no: computed.level_no,
                    is_sendable: proposed.is_sendable,
                    is_active: desiredActive,
                    metadata,
                    updated_at: now
                };
                const response = await supabaseRest('v8_product_catalog', {
                    method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row)
                });
                saved = Array.isArray(response) ? response[0] : response;
            } else {
                const affectedKeys = catalogDescendants(proposedRows, catalogKey);
                for (const row of proposedRows.filter(item => affectedKeys.has(String(item.catalog_key)))) {
                    const computed = hierarchy.get(String(row.catalog_key));
                    const update = String(row.catalog_key) === catalogKey
                        ? {
                            catalog_name: catalogName,
                            parent_key: parentKey,
                            root_product_key: computed.root_product_key,
                            level_no: computed.level_no,
                            is_sendable: proposed.is_sendable,
                            is_active: desiredActive,
                            metadata,
                            updated_at: now
                        }
                        : { root_product_key: computed.root_product_key, level_no: computed.level_no, updated_at: now };
                    const response = await supabaseRest(`v8_product_catalog?catalog_key=eq.${encodeURIComponent(String(row.catalog_key))}`, {
                        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(update)
                    });
                    if (String(row.catalog_key) === catalogKey) saved = Array.isArray(response) ? response[0] : response;
                }
            }
            await logCatalogChange(existing ? 'update_catalog_mapping' : 'create_catalog_mapping', catalogKey, existing, saved || proposed);
            res.json({ ok: true, saved: saved || proposed });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: error.message, details: error.details || null });
        }
    });

    app.post('/api/v8-mapping-center/catalog/reorder', jsonBody, requireMappingWrite, async (req, res) => {
        try {
            const catalogKey = String(req.body?.catalog_key || '').trim();
            const direction = String(req.body?.direction || '').trim().toLowerCase();
            if (!catalogKey || !['up', 'down'].includes(direction)) {
                return res.status(400).json({ ok: false, error: 'Thiếu catalog hoặc hướng sắp xếp không hợp lệ.' });
            }
            const rows = await loadCatalogAdminRows();
            const current = rows.find(row => String(row.catalog_key) === catalogKey);
            if (!current) return res.status(404).json({ ok: false, error: 'Không tìm thấy catalog.' });
            const siblings = sortCatalogSiblings(rows.filter(row => String(row.parent_key || '') === String(current.parent_key || '')));
            const index = siblings.findIndex(row => String(row.catalog_key) === catalogKey);
            const targetIndex = direction === 'up' ? index - 1 : index + 1;
            if (targetIndex < 0 || targetIndex >= siblings.length) return res.json({ ok: true, unchanged: true });
            [siblings[index], siblings[targetIndex]] = [siblings[targetIndex], siblings[index]];
            const now = new Date().toISOString();
            for (let orderIndex = 0; orderIndex < siblings.length; orderIndex += 1) {
                const row = siblings[orderIndex];
                const metadata = { ...catalogMetadata(row.metadata), admin_order: (orderIndex + 1) * 10 };
                await supabaseRest(`v8_product_catalog?catalog_key=eq.${encodeURIComponent(String(row.catalog_key))}`, {
                    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ metadata, updated_at: now })
                });
            }
            await logCatalogChange('reorder_catalog_mapping', catalogKey, current, { direction, parent_key: current.parent_key });
            res.json({ ok: true, ordered_keys: siblings.map(row => row.catalog_key) });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: error.message, details: error.details || null });
        }
    });

    app.post('/api/v8-mapping-center/ad-mapping', jsonBody, requireMappingWrite, async (req, res) => {
        try {
            const input = req.body || {};
            const adId = String(input.ad_id || '').trim();
            if (!adId) return res.status(400).json({ ok: false, error: 'Thiếu Ad ID.' });
            const folders = [...new Set((Array.isArray(input.selected_folders) ? input.selected_folders : []).map(folderToken).filter(Boolean))];
            const productGroup = String(input.product_group || '').trim();
            const productItemKey = String(input.product_item_key || '').trim();
            if (!productGroup && !productItemKey && !folders.length) {
                return res.status(400).json({ ok: false, error: 'Hãy chọn nhóm, sản phẩm hoặc ít nhất một thư mục Drive.' });
            }
            const targetType = productItemKey ? 'product' : (productGroup ? 'group' : 'scope');
            const row = {
                ad_account_id: String(input.ad_account_id || '').trim(),
                ad_account_name: String(input.ad_account_name || '').trim(),
                campaign_id: String(input.campaign_id || '').trim(),
                campaign_name: String(input.campaign_name || '').trim(),
                adset_id: String(input.adset_id || '').trim(),
                adset_name: String(input.adset_name || '').trim(),
                ad_id: adId,
                ad_name: String(input.ad_name || input.ad_title || '').trim(),
                product_type: String(input.product_type || '').trim(),
                product_name: String(input.product_name || '').trim(),
                product_group: productGroup,
                product_item_key: productItemKey,
                recognition_name: String(input.recognition_name || input.ad_name || input.ad_title || '').trim(),
                mapping_target_type: targetType,
                mapping_mode: String(input.mapping_mode || 'manual_v8').trim(),
                carousel_key: String(input.carousel_key || '').trim(),
                slide_key: String(input.slide_key || productItemKey || '').trim(),
                drive_folder: String(input.drive_folder || '').trim(),
                main_folder: String(input.main_folder || '').trim(),
                product_drive_path: String(input.product_drive_path || '').trim(),
                drive_folders: folders,
                selected_folders: folders,
                image_urls: Array.isArray(input.image_urls) ? input.image_urls : [],
                price_range: String(input.price_range || '').trim(),
                zalo_url: String(input.zalo_url || '').trim(),
                notes: String(input.notes || '').trim(),
                effective_status: String(input.effective_status || 'ACTIVE').trim(),
                account_status: String(input.account_status || '').trim(),
                enabled: input.enabled !== false,
                is_active: input.is_active !== false,
                updated_at: new Date().toISOString()
            };
            const existing = await supabaseRest(`ad_mappings?select=id,ad_id&ad_id=eq.${encodeURIComponent(adId)}&limit=1`);
            let saved;
            if (Array.isArray(existing) && existing.length) {
                saved = await supabaseRest(`ad_mappings?ad_id=eq.${encodeURIComponent(adId)}`, {
                    method: 'PATCH',
                    headers: { Prefer: 'return=representation' },
                    body: JSON.stringify(row)
                });
            } else {
                saved = await supabaseRest('ad_mappings', {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body: JSON.stringify(row)
                });
            }
            res.json({ ok: true, saved: Array.isArray(saved) ? saved[0] : saved });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: error.message, details: error.details || null });
        }
    });

    app.post('/api/v8-mapping-center/ad-mapping/disable', jsonBody, requireMappingWrite, async (req, res) => {
        try {
            const adId = String(req.body?.ad_id || '').trim();
            if (!adId) return res.status(400).json({ ok: false, error: 'Thiếu Ad ID.' });
            const saved = await supabaseRest(`ad_mappings?ad_id=eq.${encodeURIComponent(adId)}`, {
                method: 'PATCH',
                headers: { Prefer: 'return=representation' },
                body: JSON.stringify({ enabled: false, is_active: false, updated_at: new Date().toISOString() })
            });
            res.json({ ok: true, saved });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/v8-mapping-center/runtime', jsonBody, requireMappingWrite, async (req, res) => {
        try {
            const pageId = String(req.body?.page_id || '').trim();
            const mode = String(req.body?.mode || 'OBSERVE').toUpperCase();
            if (!pageId) return res.status(400).json({ ok: false, error: 'Thiếu Page ID.' });
            if (!['OFF', 'OBSERVE', 'ACTIVE'].includes(mode)) return res.status(400).json({ ok: false, error: 'Chế độ Mapping không hợp lệ.' });
            const row = {
                page_id: pageId,
                mode,
                use_ad_mapping: req.body?.use_ad_mapping !== false,
                use_recent_context: req.body?.use_recent_context !== false,
                use_slide_mapping: req.body?.use_slide_mapping !== false,
                minimum_apply_confidence: Math.min(Math.max(Number(req.body?.minimum_apply_confidence ?? 0.78), 0), 1),
                recent_context_minutes: Math.min(Math.max(Number(req.body?.recent_context_minutes ?? 60), 5), 1440),
                updated_by: 'railway_mapping_center',
                updated_at: new Date().toISOString()
            };
            const existing = await supabaseRest(`v8_mapping_runtime?select=page_id&page_id=eq.${encodeURIComponent(pageId)}&limit=1`);
            const saved = Array.isArray(existing) && existing.length
                ? await supabaseRest(`v8_mapping_runtime?page_id=eq.${encodeURIComponent(pageId)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) })
                : await supabaseRest('v8_mapping_runtime', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
            res.json({ ok: true, saved: Array.isArray(saved) ? saved[0] : saved });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/v8-mapping-center/slide-mapping', jsonBody, requireMappingWrite, async (req, res) => {
        try {
            const input = req.body || {};
            const productKey = String(input.product_key || '').trim();
            if (!productKey) return res.status(400).json({ ok: false, error: 'Thiếu mã catalog/sản phẩm.' });
            const folderIds = Array.isArray(input.drive_folder_ids) ? input.drive_folder_ids.filter(value => folderToken(value)) : [];
            const primaryFolderId = folderToken(input.drive_folder_id || folderIds[0]);
            if (!folderIds.length || !primaryFolderId) {
                return res.status(400).json({ ok: false, error: 'Hãy chọn ít nhất một thư mục Drive.' });
            }
            const existingRows = input.id
                ? await supabaseRest(`v8_slide_mapping?select=sync_status,sync_requested_at&id=eq.${encodeURIComponent(String(input.id))}&limit=1`)
                : [];
            const existing = Array.isArray(existingRows) ? existingRows[0] : null;
            const row = {
                page_id: input.page_id ? String(input.page_id).trim() : null,
                product_key: productKey,
                product_name: String(input.product_name || productKey).trim(),
                slide_url: String(input.slide_url || '').trim(),
                slide_title: String(input.slide_title || input.product_name || productKey).trim(),
                priority: Number(input.priority || 100),
                is_active: input.is_active !== false,
                note: String(input.note || '').trim(),
                drive_folder_url: String(input.drive_folder_url || '').trim(),
                drive_folder_id: primaryFolderId,
                drive_folder_ids: folderIds,
                sync_mode: String(input.sync_mode || 'drive').trim(),
                sync_status: input.request_sync ? 'requested' : String(input.sync_status || existing?.sync_status || 'idle').trim(),
                sync_requested_at: input.request_sync ? new Date().toISOString() : (input.sync_requested_at || existing?.sync_requested_at || null),
                updated_at: new Date().toISOString()
            };
            let saved;
            if (input.id) {
                saved = await supabaseRest(`v8_slide_mapping?id=eq.${encodeURIComponent(String(input.id))}`, {
                    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row)
                });
            } else {
                saved = await supabaseRest('v8_slide_mapping', {
                    method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row)
                });
            }
            res.json({ ok: true, saved: Array.isArray(saved) ? saved[0] : saved });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: error.message, details: error.details || null });
        }
    });

    function catalogDescendants(catalogs, rootKey) {
        const children = new Map();
        for (const row of catalogs) {
            const parent = String(row.parent_key || '');
            if (!children.has(parent)) children.set(parent, []);
            children.get(parent).push(String(row.catalog_key || ''));
        }
        const result = new Set();
        const queue = [rootKey];
        while (queue.length) {
            const key = queue.shift();
            if (!key || result.has(key)) continue;
            result.add(key);
            for (const child of children.get(key) || []) queue.push(child);
        }
        return result;
    }

    app.post('/api/v8-mapping-center/test', jsonBody, async (req, res) => {
        try {
            const body = req.body || {};
            const pageId = String(body.page_id || '').trim();
            const messageText = String(body.message_text || '').trim();
            const adId = String(body.ad_id || '').trim();
            const adTitle = String(body.ad_title || '').trim();
            if (!pageId) return res.status(400).json({ ok: false, error: 'Hãy chọn Page.' });
            const referral = {
                ...(adId ? { ad_id: adId } : {}),
                ...(adTitle ? { ads_context_data: { ad_title: adTitle } } : {})
            };
            const rpc = await supabaseRest('rpc/v8_resolve_unified_mapping', {
                method: 'POST',
                body: JSON.stringify({
                    p_page_id: pageId,
                    p_sender_id: 'mapping_center_test',
                    p_message_text: messageText,
                    p_referral: referral,
                    p_before: new Date().toISOString()
                })
            });
            const result = Array.isArray(rpc) ? rpc[0] : rpc;
            const [catalogRows, assetRows] = await Promise.all([
                supabaseRest('v8_product_catalog?select=catalog_key,parent_key&is_active=eq.true&limit=5000'),
                supabaseRest('v8_drive_assets?select=id,catalog_key,product_key,parent_folder_id,parent_folder_name,file_name,file_url,delivery_url,delivery_status,sort_order&is_active=eq.true&is_image=eq.true&limit=10000')
            ]);
            const descendants = result?.catalog_key ? catalogDescendants(catalogRows || [], String(result.catalog_key)) : new Set();
            const folderIds = new Set(Array.isArray(result?.slide_folder_ids) ? result.slide_folder_ids.map(String) : []);
            const assets = (Array.isArray(assetRows) ? assetRows : []).filter(row =>
                (row.catalog_key && descendants.has(String(row.catalog_key))) ||
                (row.parent_folder_id && folderIds.has(String(row.parent_folder_id)))
            ).sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0)).slice(0, 12);
            res.json({ ok: true, result, preview_assets: assets });
        } catch (error) {
            res.status(error.status || 500).json({ ok: false, error: error.message, details: error.details || null });
        }
    });

    app.get('/api/v8-mapping-center/health', (req, res) => {
        res.json({
            ok: mappingApiReady(),
            version: 'railway_unified_mapping_center_v2',
            supabase_configured: mappingApiReady(),
            requires_admin_key: Boolean(MAPPING_ADMIN_KEY),
            legacy_drive_route_preserved: legacyDriveSlideLayers.length > 0
        });
    });

}

export default installMappingCenter;
