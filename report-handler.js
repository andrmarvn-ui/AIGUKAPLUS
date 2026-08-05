import * as XLSX from "xlsx";
import { createMetaDirectReporting } from "./meta-direct-reporting.js";

export function installReportRoutes(app, { supabaseUrl, publishableKey }) {
  const meta = createMetaDirectReporting();
  const headers = () => ({
    apikey: publishableKey,
    authorization: `Bearer ${publishableKey}`,
    "content-type": "application/json",
    "x-aiguka-railway-test": "enabled",
  });
  const coreBase = () => String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
  const coreKey = () => String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");

  async function rpc(name, rpcArgs = {}) {
    if (!publishableKey) throw Error("MISSING_SUPABASE_PUBLISHABLE_KEY");
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(rpcArgs),
      signal: AbortSignal.timeout(60_000),
      cache: "no-store",
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; }
    catch { data = { raw: raw.slice(0, 500) }; }
    if (!response.ok) throw Error(data?.message || data?.error || `RPC_HTTP_${response.status}`);
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

  function args(query, limit = null) {
    const value = (name) => {
      const text = String(query[name] ?? "").trim();
      return text || null;
    };
    return {
      p_from: value("from"),
      p_to: value("to"),
      p_page_id: value("page_id"),
      p_ad_account_id: value("ad_account_id"),
      p_campaign_id: value("campaign_id"),
      p_adset_id: value("adset_id"),
      p_ad_id: value("ad_id"),
      p_search: value("search"),
      p_limit: limit ?? Math.min(Math.max(Number(query.limit || 100), 1), 10_000),
      p_offset: Math.max(Number(query.offset || 0), 0),
    };
  }

  const queryShape = (query) => ({
    page_id: query.page_id,
    ad_account_id: query.ad_account_id,
    campaign_id: query.campaign_id,
    adset_id: query.adset_id,
    ad_id: query.ad_id,
    search: query.search,
  });

  async function filters() {
    const result = await rpc("v8_report_filters_test");
    return result?.data || {};
  }

  function accountIds(filterData, query) {
    const selected = String(query.ad_account_id || "").trim().replace(/^act_/, "");
    if (selected) return [selected];
    return [...new Set((filterData.ad_accounts || []).map((row) => String(row.ad_account_id || "").replace(/^act_/, "")).filter(Boolean))];
  }

  async function stored(type, query, limit = null) {
    const name = type === "ads" ? "v8_report_ads_test" : type === "daily" ? "v8_report_daily_test" : "v8_report_leads_test";
    return rpc(name, args(query, limit));
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
      return {
        ...report,
        source: report?.source || "supabase_customer_history",
        customer_data_source: "reporting_history",
        accounts: [],
      };
    }
    const ids = [...new Set(rows.map((row) => String(row.customer_id || row.sender_id || "").trim()).filter(Boolean))];
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
      return {
        ...report,
        source: report?.source || "supabase_customer_history",
        customer_data_source: "reporting_history",
        warnings,
        accounts: [],
      };
    }

    const customerMap = new Map();
    for (const row of customers) customerMap.set(`${row.page_id}:${row.customer_id}`, row);
    const contactMap = new Map();
    for (const row of contacts) {
      const key = `${row.page_id}:${row.customer_id}`;
      const current = contactMap.get(key) || {};
      const type = String(row.contact_type || "").toLowerCase();
      const value = String(row.contact_value || row.normalized_value || "").trim();
      if (!value) continue;
      if (type === "phone" && !current.phone) current.phone = value;
      if (type === "zalo" && !current.zalo) current.zalo = value;
      contactMap.set(key, current);
    }

    let enrichedCount = 0;
    const data = rows.map((row) => {
      const customerId = String(row.customer_id || row.sender_id || "").trim();
      const key = `${row.page_id}:${customerId}`;
      const customer = customerMap.get(key) || {};
      const contact = contactMap.get(key) || {};
      const name = String(customer.display_name || "").trim();
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

  async function liveAds(query) {
    const [filterData, fallback] = await Promise.all([filters(), stored("ads", query, 10_000)]);
    if (!meta.ready()) return { ...fallback, source: "supabase_fallback", warnings: ["META_ACCESS_TOKEN_MISSING"], accounts: [] };
    try {
      const live = await meta.ads({
        from: query.from,
        to: query.to,
        accountIds: accountIds(filterData, query),
        filters: filterData,
        fallbackRows: fallback.data || [],
        query: queryShape(query),
      });
      return {
        ok: true,
        data: live.rows,
        count: live.rows.length,
        accounts: live.accounts,
        warnings: live.warnings,
        source: "meta_live_plus_customer_facts",
        range: live.range,
      };
    } catch (error) {
      return { ...fallback, source: "supabase_fallback", accounts: [], warnings: [error.message] };
    }
  }

  async function liveDaily(query) {
    const [filterData, fallbackAds, fallbackDaily] = await Promise.all([
      filters(),
      stored("ads", query, 10_000),
      stored("daily", query, 10_000),
    ]);
    if (!meta.ready()) return { ...fallbackDaily, source: "supabase_fallback", warnings: ["META_ACCESS_TOKEN_MISSING"], accounts: [] };
    try {
      const live = await meta.daily({
        from: query.from,
        to: query.to,
        accountIds: accountIds(filterData, query),
        filters: filterData,
        fallbackAds: fallbackAds.data || [],
        fallbackDaily: fallbackDaily.data || [],
        query: queryShape(query),
      });
      return {
        ok: true,
        data: live.rows,
        count: live.rows.length,
        accounts: live.accounts,
        warnings: live.warnings,
        source: "meta_live_plus_customer_facts",
        range: live.range,
      };
    } catch (error) {
      return { ...fallbackDaily, source: "supabase_fallback", accounts: [], warnings: [error.message] };
    }
  }

  async function loadReport(type, query, limit = null) {
    if (type === "ads") return liveAds(query);
    if (type === "daily") return liveDaily(query);
    const defaultLimit = limit ?? (!String(query.limit || "").trim() ? 250 : null);
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
      "Tài khoản QC": row.ad_account_name || "",
      "ID tài khoản": row.ad_account_id || "",
      "Thẻ/nguồn tiền": row.payment_method_last4 ? `•••• ${row.payment_method_last4}` : row.funding_source_display || "",
      "Chiến dịch": row.campaign_name || "",
      "ID chiến dịch": row.campaign_id || "",
      "Nhóm quảng cáo": row.adset_name || "",
      "ID nhóm quảng cáo": row.adset_id || "",
      "Quảng cáo": row.ad_name || "",
      "ID quảng cáo": row.ad_id || "",
      "Trạng thái": row.effective_status || row.ad_status || "",
      "Nguồn ngân sách": row.data_source || "",
      "Chi tiêu chưa VAT": +row.spend || 0,
      "VAT": +row.tax_amount || 0,
      "Chi tiêu có VAT": +row.spend_with_tax || 0,
      "Hiển thị": +row.impressions || 0,
      "Tiếp cận": +row.reach || 0,
      "Click": +row.clicks || 0,
      "Click liên kết": +row.link_clicks || 0,
      "Hội thoại Meta": +row.meta_conversations || 0,
      "Khách đối chiếu": +row.conversations || 0,
      "Có SĐT/Zalo": +row.contacts || 0,
      "Tỷ lệ lấy số (%)": +row.contact_rate || 0,
      "Khách nóng": +row.hot_leads || 0,
      "Cost/Hội thoại": +row.cost_per_conversation || 0,
      "Cost/SĐT": +row.cost_per_contact || 0,
    }));
    if (type === "daily") return rows.map((row) => ({
      "Ngày": row.report_date || "",
      "Page": row.page_name || "",
      "Tài khoản QC": row.ad_account_name || "Tự nhiên / chưa xác định",
      "Thẻ/nguồn tiền": row.payment_method_last4 ? `•••• ${row.payment_method_last4}` : row.funding_source_display || "",
      "Trạng thái dữ liệu": row.data_status || "",
      "Chi tiêu chưa VAT": +row.spend || 0,
      "VAT": +row.tax_amount || 0,
      "Chi tiêu có VAT": +row.spend_with_tax || 0,
      "Hội thoại Meta": +row.meta_conversations || 0,
      "Khách đối chiếu": +row.conversations || 0,
      "Có SĐT/Zalo": +row.contacts || 0,
      "Tỷ lệ lấy số (%)": +row.contact_rate || 0,
      "Khách nóng": +row.hot_leads || 0,
      "Số tin khách": +row.message_count || 0,
      "Cost/Hội thoại": +row.cost_per_conversation || 0,
      "Cost/SĐT": +row.cost_per_contact || 0,
    }));
    return rows.map((row) => ({
      "Ngày": row.report_date || "",
      "Khách hàng": row.customer_name || "",
      "ID khách": row.customer_id || row.sender_id || "",
      "Loại khách": row.customer_source_type === "comment" ? "Khách comment" : "Khách nhắn tin",
      "SĐT": row.phone || "",
      "Zalo": row.zalo || "",
      "Đã có liên hệ": row.has_contact ? "Có" : "Không",
      "Page": row.page_name || "",
      "ID Page": row.page_id || "",
      "Tài khoản QC": row.ad_account_name || "",
      "Chiến dịch": row.campaign_name || "",
      "Nhóm quảng cáo": row.adset_name || "",
      "Quảng cáo": row.ad_name || "",
      "Trạng thái QC": row.ad_status || row.effective_status || "",
      "Sản phẩm": row.product_label || row.product_group || "",
      "Nguồn": sourceLabel(row),
      "Tag Pancake": Array.isArray(row.pancake_tags) ? row.pancake_tags.map((tag) => tag?.text || tag?.name || String(tag || "")).filter(Boolean).join(", ") : "",
      "Nhân viên": row.pancake_employee || "",
      "Tin cuối": row.last_snippet || "",
      "Số tin/bình luận": +row.message_count || 0,
      "Thời gian": row.last_customer_at || row.conversation_started_at || "",
    }));
  }

  app.get("/functions/v1/aiguka-v8-report-api", async (req, res) => {
    const action = String(req.query.action || "health").toLowerCase();
    try {
      if (action === "health") return res.json({
        ok: true,
        service: "aiguka-v10-direct-meta-report",
        version: 5,
        meta_direct_ready: meta.ready(),
        customer_history_source: coreBase() && coreKey() ? "core_live_plus_reporting_history" : "reporting_history",
        raw_contact_replication: false,
      });
      if (action === "filters") return res.json(await rpc("v8_report_filters_test"));
      if (action === "summary") {
        const report = await liveAds(req.query);
        const rows = report.data || [];
        const summary = rows.reduce((sum, row) => {
          for (const key of ["spend", "tax_amount", "spend_with_tax", "impressions", "reach", "clicks", "meta_conversations", "conversations", "contacts", "hot_leads", "message_count"]) sum[key] += Number(row[key] || 0);
          return sum;
        }, { spend: 0, tax_amount: 0, spend_with_tax: 0, impressions: 0, reach: 0, clicks: 0, meta_conversations: 0, conversations: 0, contacts: 0, hot_leads: 0, message_count: 0 });
        summary.contact_rate = summary.conversations ? Math.round((summary.contacts / summary.conversations) * 10_000) / 100 : 0;
        return res.json({ ...report, data: summary, count: rows.length });
      }
      if (["ads", "daily", "leads"].includes(action)) return res.json(await loadReport(action, req.query));
      if (action === "system") {
        const data = await rpc("v8_admin_control_overview");
        return res.json({ ok: true, data: { pages: data.pages || [], ad_accounts: data.ad_accounts || [], workers: [], server: data.health || null } });
      }
      if (action === "export") {
        const type = ["ads", "daily", "leads"].includes(String(req.query.report)) ? String(req.query.report) : "ads";
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
      console.error("[AIGUKA report]", error);
      return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  return { rpc, liveAds, liveDaily, enrichLeadsFromCore };
}
