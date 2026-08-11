import * as XLSX from "xlsx";
import { createMetaDirectReporting } from "./meta-direct-reporting.js";
import { createMetaDirectInventory } from "./meta-direct-inventory.js";
import { createV10ReportSources } from "./v10-report-sources.js";

const clean = (value) => String(value ?? "").trim();
const num = (value) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const normalizeAccountId = (value) => clean(value).replace(/^act_/, "");

export function installReportRoutes(app, { supabaseUrl, publishableKey }) {
  const meta = createMetaDirectReporting();
  const inventory = createMetaDirectInventory();
  const coreBase = () => clean(process.env.AIGUKA_V9_CORE_URL).replace(/\/$/, "");
  const coreKey = () => clean(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY);
  const reportingKey = clean(process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || publishableKey);
  const sources = createV10ReportSources({
    reportingBase: supabaseUrl,
    reportingKey,
    coreBase: coreBase(),
    coreKey: coreKey(),
    publishableKey,
  });

  const legacyHeaders = () => ({
    apikey: publishableKey,
    authorization: `Bearer ${publishableKey}`,
    "content-type": "application/json",
    "x-aiguka-railway-test": "enabled",
  });

  async function legacyRpc(name, rpcArgs = {}) {
    if (!publishableKey) throw new Error("MISSING_SUPABASE_PUBLISHABLE_KEY");
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: legacyHeaders(),
      body: JSON.stringify(rpcArgs),
      signal: AbortSignal.timeout(60_000),
      cache: "no-store",
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; }
    catch { data = { raw: raw.slice(0, 500) }; }
    if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `RPC_HTTP_${response.status}:${name}`);
    return data;
  }

  async function coreGet(path) {
    if (!coreBase() || !coreKey()) throw new Error("CORE_REPORT_ENRICHMENT_NOT_CONFIGURED");
    const response = await fetch(`${coreBase()}/rest/v1/${path}`, {
      headers: {
        apikey: coreKey(),
        authorization: `Bearer ${coreKey()}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(25_000),
      cache: "no-store",
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; }
    catch { data = { raw: raw.slice(0, 500) }; }
    if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `CORE_HTTP_${response.status}`);
    return Array.isArray(data) ? data : [];
  }

  function queryValue(query, name) {
    const value = clean(query?.[name]);
    return value || null;
  }

  function legacyArgs(query, limit = null) {
    return {
      p_from: queryValue(query, "from"),
      p_to: queryValue(query, "to"),
      p_page_id: queryValue(query, "page_id"),
      p_ad_account_id: queryValue(query, "ad_account_id"),
      p_campaign_id: queryValue(query, "campaign_id"),
      p_adset_id: queryValue(query, "adset_id"),
      p_ad_id: queryValue(query, "ad_id"),
      p_search: queryValue(query, "search"),
      p_limit: limit ?? Math.min(Math.max(Number(query?.limit || 100), 1), 10_000),
      p_offset: Math.max(Number(query?.offset || 0), 0),
    };
  }

  const queryShape = (query) => ({
    page_id: query?.page_id,
    ad_account_id: query?.ad_account_id,
    campaign_id: query?.campaign_id,
    adset_id: query?.adset_id,
    ad_id: query?.ad_id,
    search: query?.search,
  });

  async function stored(type, query, limit = null) {
    const name = type === "ads" ? "v8_report_ads_test" : type === "daily" ? "v8_report_daily_test" : "v8_report_leads_test";
    return legacyRpc(name, legacyArgs(query, limit));
  }

  async function filters() {
    const registry = await sources.staticFilters();
    const baseWarnings = Array.isArray(registry.warnings) ? registry.warnings : [];
    if (!inventory.ready()) {
      return {
        ok: true,
        data: registry.data || {},
        source: registry.source,
        warnings: [...baseWarnings, "META_ACCESS_TOKEN_MISSING"],
      };
    }
    try {
      const live = await inventory.filters(registry.data || {});
      return {
        ...live,
        warnings: [...baseWarnings, ...(Array.isArray(live.warnings) ? live.warnings : [])],
      };
    } catch (error) {
      return {
        ok: true,
        data: registry.data || {},
        source: registry.source,
        warnings: [...baseWarnings, `META_INVENTORY:${error.message}`],
      };
    }
  }

  function accountIds(filterData, query) {
    const selected = normalizeAccountId(queryValue(query, "ad_account_id"));
    if (selected) return [selected];
    return [...new Set((filterData.ad_accounts || [])
      .map((row) => normalizeAccountId(row.ad_account_id))
      .filter(Boolean))];
  }

  async function safeCustomerMetrics(query, filterData) {
    try {
      const result = await sources.customerMetrics(query, filterData);
      return { ...result, warnings: [] };
    } catch (error) {
      return {
        ok: false,
        rows: [],
        ads: [],
        daily: [],
        source: "core_customer_metrics_unavailable",
        warnings: [`CORE_CUSTOMER_METRICS:${error.message}`],
      };
    }
  }

  function appendCustomerOnlyAds(liveRows, metricRows) {
    const output = [...liveRows];
    const seen = new Set(output.map((row) => clean(row.ad_id)).filter(Boolean));
    for (const row of metricRows || []) {
      const adId = clean(row.ad_id);
      if (!adId || seen.has(adId)) continue;
      const conversations = Math.max(0, Math.round(num(row.conversations)));
      const contacts = Math.max(0, Math.round(num(row.contacts)));
      output.push({
        ...row,
        spend: 0,
        tax_amount: 0,
        spend_with_tax: 0,
        impressions: 0,
        reach: 0,
        clicks: 0,
        link_clicks: 0,
        meta_conversations: 0,
        contact_rate: conversations ? Math.round((contacts / conversations) * 10_000) / 100 : 0,
        cost_per_conversation: 0,
        cost_per_contact: 0,
        data_source: "core_customer_metrics_only",
        data_match_status: "core_customer_only",
      });
      seen.add(adId);
    }
    return output;
  }

  function isoDates(from, to) {
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
    const dates = [];
    for (let cursor = start; cursor <= end && dates.length < 732; cursor = new Date(cursor.getTime() + 86_400_000)) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    return dates;
  }

  function ensureConfiguredDailyRows(rows, filterData, query) {
    if (queryValue(query, "campaign_id") || queryValue(query, "adset_id") || queryValue(query, "ad_id")) return rows;
    const dates = isoDates(queryValue(query, "from"), queryValue(query, "to"));
    if (!dates.length) return rows;
    const selectedAccount = normalizeAccountId(queryValue(query, "ad_account_id"));
    const selectedPage = queryValue(query, "page_id");
    const accounts = (filterData.ad_accounts || []).filter((row) => !selectedAccount || normalizeAccountId(row.ad_account_id) === selectedAccount);
    const pagesByAccount = new Map();
    for (const ad of filterData.ads || []) {
      const accountId = normalizeAccountId(ad.ad_account_id);
      const pageId = clean(ad.page_id);
      if (!accountId || !pageId || (selectedPage && pageId !== selectedPage)) continue;
      const set = pagesByAccount.get(accountId) || new Set();
      set.add(pageId);
      pagesByAccount.set(accountId, set);
    }
    const pageNames = new Map((filterData.pages || []).map((row) => [clean(row.page_id), row.page_name]));
    const seen = new Set(rows.map((row) => [clean(row.report_date), normalizeAccountId(row.ad_account_id), clean(row.page_id)].join("|")));
    const output = [...rows];
    for (const date of dates) {
      for (const account of accounts) {
        const accountId = normalizeAccountId(account.ad_account_id);
        const pageIds = [...(pagesByAccount.get(accountId) || new Set(selectedPage ? [selectedPage] : [""]))];
        for (const pageId of pageIds) {
          const key = [date, accountId, pageId].join("|");
          if (seen.has(key)) continue;
          output.push({
            report_date: date,
            page_id: pageId || null,
            page_name: pageNames.get(pageId) || null,
            ad_account_id: accountId,
            ad_account_name: account.ad_account_name || accountId,
            payment_method_last4: account.payment_method_last4 || null,
            spend: 0,
            tax_amount: 0,
            spend_with_tax: 0,
            impressions: 0,
            reach: 0,
            clicks: 0,
            meta_conversations: 0,
            conversations: 0,
            contacts: 0,
            scanned_contacts: 0,
            hot_leads: 0,
            message_count: 0,
            contact_rate: 0,
            cost_per_conversation: 0,
            cost_per_contact: 0,
            data_status: "Tài khoản hoạt động; Meta không ghi nhận phân phối trong ngày",
            data_source: "meta_live_zero_delivery",
            has_ads_data: false,
            has_runtime_data: false,
          });
          seen.add(key);
        }
      }
    }
    return output;
  }

  async function liveAds(query) {
    const filterResult = await filters();
    const filterData = filterResult.data || {};
    if (!meta.ready()) {
      const fallback = await stored("ads", query, 10_000);
      return { ...fallback, source: "supabase_fallback", warnings: [...(filterResult.warnings || []), "META_ACCESS_TOKEN_MISSING"], accounts: [] };
    }
    const metrics = await safeCustomerMetrics(query, filterData);
    try {
      const live = await meta.ads({
        from: query.from,
        to: query.to,
        accountIds: accountIds(filterData, query),
        filters: filterData,
        fallbackRows: metrics.ads,
        query: queryShape(query),
      });
      const data = appendCustomerOnlyAds(live.rows, metrics.ads);
      return {
        ok: true,
        data,
        count: data.length,
        accounts: live.accounts,
        warnings: [...(filterResult.warnings || []), ...(metrics.warnings || []), ...(live.warnings || [])],
        source: "meta_live_plus_core_customer_metrics",
        customer_metric_source: metrics.source,
        filter_source: filterResult.source,
        range: live.range,
      };
    } catch (error) {
      const fallback = await stored("ads", query, 10_000);
      return { ...fallback, source: "supabase_fallback", accounts: [], warnings: [...(filterResult.warnings || []), ...(metrics.warnings || []), error.message] };
    }
  }

  async function liveDaily(query) {
    const filterResult = await filters();
    const filterData = filterResult.data || {};
    if (!meta.ready()) {
      const fallback = await stored("daily", query, 10_000);
      return { ...fallback, source: "supabase_fallback", warnings: [...(filterResult.warnings || []), "META_ACCESS_TOKEN_MISSING"], accounts: [] };
    }
    const metrics = await safeCustomerMetrics(query, filterData);
    try {
      const live = await meta.daily({
        from: query.from,
        to: query.to,
        accountIds: accountIds(filterData, query),
        filters: filterData,
        fallbackAds: metrics.ads,
        fallbackDaily: metrics.daily,
        query: queryShape(query),
      });
      const data = ensureConfiguredDailyRows(live.rows, filterData, query);
      data.sort((a, b) => clean(b.report_date).localeCompare(clean(a.report_date)) || clean(a.ad_account_name).localeCompare(clean(b.ad_account_name), "vi"));
      return {
        ok: true,
        data,
        count: data.length,
        accounts: live.accounts,
        warnings: [...(filterResult.warnings || []), ...(metrics.warnings || []), ...(live.warnings || [])],
        source: "meta_live_plus_core_customer_metrics",
        customer_metric_source: metrics.source,
        filter_source: filterResult.source,
        range: live.range,
      };
    } catch (error) {
      const fallback = await stored("daily", query, 10_000);
      return { ...fallback, source: "supabase_fallback", accounts: [], warnings: [...(filterResult.warnings || []), ...(metrics.warnings || []), error.message] };
    }
  }

  function chunks(values, size = 40) {
    const result = [];
    for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
    return result;
  }

  function inFilter(values) {
    const quoted = values.map((value) => `"${String(value).replaceAll('"', '')}"`).join(",");
    return `in.(${encodeURIComponent(quoted)})`;
  }

  async function enrichLeadsFromCore(report) {
    const rows = Array.isArray(report?.data) ? report.data : [];
    if (!rows.length || !coreBase() || !coreKey()) {
      return { ...report, source: report?.source || "supabase_customer_history", customer_data_source: "reporting_history", accounts: [] };
    }
    const ids = [...new Set(rows.map((row) => clean(row.customer_id || row.sender_id)).filter(Boolean))];
    const customers = [];
    const contacts = [];
    const warnings = [...(Array.isArray(report?.warnings) ? report.warnings : [])];
    try {
      for (const batch of chunks(ids)) {
        const filter = inFilter(batch);
        const [customerRows, contactRows] = await Promise.all([
          coreGet(`v9_customers?select=page_id,customer_id,display_name,gender,preferred_salutation,profile&customer_id=${filter}`),
          coreGet(`v9_contacts?select=page_id,customer_id,contact_type,contact_value,normalized_value,captured_at&customer_id=${filter}&order=captured_at.desc`),
        ]);
        customers.push(...customerRows);
        contacts.push(...contactRows);
      }
    } catch (error) {
      warnings.push(`CORE_LEAD_ENRICHMENT:${error.message}`);
      return { ...report, source: report?.source || "supabase_customer_history", customer_data_source: "reporting_history", warnings, accounts: [] };
    }

    const customerMap = new Map(customers.map((row) => [`${row.page_id}:${row.customer_id}`, row]));
    const contactMap = new Map();
    for (const row of contacts) {
      const key = `${row.page_id}:${row.customer_id}`;
      const current = contactMap.get(key) || {};
      const type = clean(row.contact_type).toLowerCase();
      const value = clean(row.contact_value || row.normalized_value);
      if (type === "phone" && value && !current.phone) current.phone = value;
      if (type === "zalo" && value && !current.zalo) current.zalo = value;
      contactMap.set(key, current);
    }

    let enrichedCount = 0;
    const data = rows.map((row) => {
      const customerId = clean(row.customer_id || row.sender_id);
      const key = `${row.page_id}:${customerId}`;
      const customer = customerMap.get(key) || {};
      const contact = contactMap.get(key) || {};
      const name = clean(customer.display_name);
      if (name || contact.phone || contact.zalo) enrichedCount += 1;
      return {
        ...row,
        customer_name: name || row.customer_name,
        phone: contact.phone || row.phone,
        zalo: contact.zalo || row.zalo,
        has_contact: Boolean(contact.phone || contact.zalo || row.has_contact || row.phone || row.zalo),
        is_hot_lead: Boolean(contact.phone || contact.zalo || row.is_hot_lead),
        gender: customer.gender || row.gender || null,
        preferred_salutation: customer.preferred_salutation || row.preferred_salutation || null,
        customer_profile_source: name ? "v10_core_live" : row.customer_profile_source || null,
        contact_value_source: contact.phone || contact.zalo ? "v10_core_live" : row.contact_value_source || null,
      };
    });
    return {
      ...report,
      data,
      source: "core_live_plus_reporting_history",
      customer_data_source: "v10_core_live",
      core_enriched_count: enrichedCount,
      warnings,
      accounts: [],
    };
  }

  async function loadReport(type, query, limit = null) {
    if (type === "ads") return liveAds(query);
    if (type === "daily") return liveDaily(query);
    const defaultLimit = limit ?? (!clean(query.limit) ? 250 : null);
    const result = await stored("leads", query, defaultLimit);
    return enrichLeadsFromCore({ ...result, source: result.source || "supabase_customer_history" });
  }

  function sourceLabel(row = {}) {
    if (row.customer_source_type === "comment") return "Bình luận Facebook";
    if (row.ad_id) return "Quảng cáo Meta";
    if (row.source_channel === "legacy_webhook_inbox" || row.customer_source_type === "message") return "Messenger / tự nhiên";
    return row.source_channel || row.identity_source || "Tự nhiên / chưa xác định";
  }

  function exportRows(rows, type) {
    if (type === "ads") return rows.map((row) => ({
      "Tài khoản QC": row.ad_account_name || "", "ID tài khoản": row.ad_account_id || "",
      "Thẻ/nguồn tiền": row.payment_method_last4 ? `•••• ${row.payment_method_last4}` : row.funding_source_display || "",
      "Chiến dịch": row.campaign_name || "", "ID chiến dịch": row.campaign_id || "",
      "Nhóm quảng cáo": row.adset_name || "", "ID nhóm quảng cáo": row.adset_id || "",
      "Quảng cáo": row.ad_name || "", "ID quảng cáo": row.ad_id || "",
      "Trạng thái": row.effective_status || row.ad_status || "", "Nguồn ngân sách": row.data_source || "",
      "Chi tiêu chưa VAT": +row.spend || 0, "VAT": +row.tax_amount || 0, "Chi tiêu có VAT": +row.spend_with_tax || 0,
      "Hiển thị": +row.impressions || 0, "Tiếp cận": +row.reach || 0, "Click": +row.clicks || 0,
      "Click liên kết": +row.link_clicks || 0, "Hội thoại Meta": +row.meta_conversations || 0,
      "Khách đối chiếu": +row.conversations || 0, "Có SĐT/Zalo": +row.contacts || 0, "SĐT quét": +row.scanned_contacts || 0,
      "Tỷ lệ lấy số (%)": +row.contact_rate || 0, "Khách nóng": +row.hot_leads || 0,
      "Cost/Hội thoại": +row.cost_per_conversation || 0, "Cost/SĐT": +row.cost_per_contact || 0,
    }));
    if (type === "daily") return rows.map((row) => ({
      "Ngày": row.report_date || "", "Page": row.page_name || "",
      "Tài khoản QC": row.ad_account_name || "Tự nhiên / chưa xác định",
      "Thẻ/nguồn tiền": row.payment_method_last4 ? `•••• ${row.payment_method_last4}` : row.funding_source_display || "",
      "Trạng thái dữ liệu": row.data_status || "", "Chi tiêu chưa VAT": +row.spend || 0,
      "VAT": +row.tax_amount || 0, "Chi tiêu có VAT": +row.spend_with_tax || 0,
      "Hội thoại Meta": +row.meta_conversations || 0, "Khách đối chiếu": +row.conversations || 0,
      "Có SĐT/Zalo": +row.contacts || 0, "Tỷ lệ lấy số (%)": +row.contact_rate || 0,
      "Khách nóng": +row.hot_leads || 0, "Số tin khách": +row.message_count || 0,
      "Cost/Hội thoại": +row.cost_per_conversation || 0, "Cost/SĐT": +row.cost_per_contact || 0,
    }));
    return rows.map((row) => ({
      "Ngày": row.report_date || "", "Khách hàng": row.customer_name || "",
      "ID khách": row.customer_id || row.sender_id || "",
      "Loại khách": row.customer_source_type === "comment" ? "Khách comment" : "Khách nhắn tin",
      "SĐT": row.phone || "", "Zalo": row.zalo || "", "Đã có liên hệ": row.has_contact ? "Có" : "Không",
      "Page": row.page_name || "", "ID Page": row.page_id || "", "Tài khoản QC": row.ad_account_name || "",
      "Chiến dịch": row.campaign_name || "", "Nhóm quảng cáo": row.adset_name || "", "Quảng cáo": row.ad_name || "",
      "Trạng thái QC": row.ad_status || row.effective_status || "", "Sản phẩm": row.product_label || row.product_group || "",
      "Nguồn": sourceLabel(row),
      "Tag Pancake": Array.isArray(row.pancake_tags) ? row.pancake_tags.map((tag) => tag?.text || tag?.name || String(tag || "")).filter(Boolean).join(", ") : "",
      "Nhân viên": row.pancake_employee || "", "Tin cuối": row.last_snippet || "",
      "Số tin/bình luận": +row.message_count || 0, "Thời gian": row.last_customer_at || row.conversation_started_at || "",
    }));
  }

  app.get("/functions/v1/aiguka-v8-report-api", async (req, res) => {
    const action = clean(req.query.action || "health").toLowerCase();
    try {
      if (action === "health") return res.json({
        ok: true,
        service: "aiguka-v10-direct-report",
        version: 6,
        meta_direct_ready: meta.ready(),
        filter_source: "meta_live_inventory_plus_static_mapping",
        customer_metric_source: "v10_core_live_customer_metrics",
        customer_history_source: coreBase() && coreKey() ? "core_live_plus_reporting_history" : "reporting_history",
        snapshot_workers_required: false,
        raw_contact_replication: false,
      });
      if (action === "filters") return res.json(await filters());
      if (action === "summary") {
        const report = await liveAds(req.query);
        const rows = report.data || [];
        const summary = rows.reduce((sum, row) => {
          for (const key of ["spend", "tax_amount", "spend_with_tax", "impressions", "reach", "clicks", "meta_conversations", "conversations", "contacts", "scanned_contacts", "hot_leads", "message_count"]) sum[key] += num(row[key]);
          return sum;
        }, { spend: 0, tax_amount: 0, spend_with_tax: 0, impressions: 0, reach: 0, clicks: 0, meta_conversations: 0, conversations: 0, contacts: 0, scanned_contacts: 0, hot_leads: 0, message_count: 0 });
        summary.contact_rate = summary.conversations ? Math.round((summary.contacts / summary.conversations) * 10_000) / 100 : 0;
        return res.json({ ...report, data: summary, count: rows.length });
      }
      if (["ads", "daily", "leads"].includes(action)) return res.json(await loadReport(action, req.query));
      if (action === "system") {
        const data = await legacyRpc("v8_admin_control_overview");
        return res.json({ ok: true, data: { pages: data.pages || [], ad_accounts: data.ad_accounts || [], workers: [], server: data.health || null } });
      }
      if (action === "export") {
        const type = ["ads", "daily", "leads"].includes(clean(req.query.report)) ? clean(req.query.report) : "ads";
        const report = await loadReport(type, req.query, 10_000);
        const sheet = XLSX.utils.json_to_sheet(exportRows(report.data || [], type));
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, sheet, type);
        const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
        res.setHeader("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("content-disposition", `attachment; filename="bao-cao-${type}-${req.query.from || ""}_den_${req.query.to || ""}.xlsx"`);
        return res.send(buffer);
      }
      return res.status(404).json({ ok: false, error: "unknown_route" });
    } catch (error) {
      console.error("[AIGUKA V10 report]", error);
      return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  return { legacyRpc, filters, liveAds, liveDaily, enrichLeadsFromCore };
}

// AIGUKA_V10_REPORT_CONTACT_SCAN_META_METRIC_V1
