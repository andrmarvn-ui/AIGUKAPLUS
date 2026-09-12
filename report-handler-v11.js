import * as XLSX from "xlsx";
import { createMetaDirectReporting } from "./meta-direct-reporting.js";
import { createV10ReportSources } from "./v10-report-sources.js";

const clean = (value) => String(value ?? "").trim();
const num = (value) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const normalizeAccountId = (value) => clean(value).replace(/^act_/, "");

function queryValue(query, name) {
  const value = clean(query?.[name]);
  return value || null;
}

function queryShape(query = {}) {
  return {
    page_id: queryValue(query, "page_id"),
    ad_account_id: queryValue(query, "ad_account_id"),
    campaign_id: queryValue(query, "campaign_id"),
    adset_id: queryValue(query, "adset_id"),
    ad_id: queryValue(query, "ad_id"),
    search: queryValue(query, "search"),
  };
}

function matches(row, query = {}) {
  const eq = (name, value, normalize = clean) => {
    const selected = queryValue(query, name);
    return !selected || normalize(value) === normalize(selected);
  };
  if (!eq("page_id", row.page_id)) return false;
  if (!eq("ad_account_id", row.ad_account_id, normalizeAccountId)) return false;
  if (!eq("campaign_id", row.campaign_id)) return false;
  if (!eq("adset_id", row.adset_id)) return false;
  if (!eq("ad_id", row.ad_id)) return false;
  const search = clean(queryValue(query, "search")).toLocaleLowerCase("vi");
  if (!search) return true;
  return [
    row.customer_name, row.phone, row.zalo, row.sender_id, row.customer_id,
    row.page_name, row.ad_account_name, row.campaign_name, row.adset_name,
    row.ad_name, row.ad_id, row.product_group, row.product_label, row.last_snippet,
    row.pancake_employee, row.source_channel, row.customer_source_type,
  ].map(clean).join(" ").toLocaleLowerCase("vi").includes(search);
}

function accountsFromFilters(filters = {}) {
  return (Array.isArray(filters.ad_accounts) ? filters.ad_accounts : []).map((row) => ({
    ad_account_id: normalizeAccountId(row.ad_account_id),
    ad_account_name: row.ad_account_name || normalizeAccountId(row.ad_account_id),
    currency: row.currency || "VND",
    timezone_name: row.timezone_name || "Asia/Ho_Chi_Minh",
    payment_method_last4: null,
    source: "v10_core_report_scope",
  }));
}

function accountIds(filters = {}, query = {}) {
  const selected = normalizeAccountId(queryValue(query, "ad_account_id"));
  if (selected) return [selected];
  return [...new Set((filters.ad_accounts || []).map((row) => normalizeAccountId(row.ad_account_id)).filter(Boolean))];
}

function zeroMetricRow(row = {}) {
  const conversations = Math.max(0, Math.round(num(row.conversations)));
  const contacts = Math.max(0, Math.round(num(row.contacts)));
  return {
    ...row,
    spend: num(row.spend),
    tax_amount: num(row.tax_amount),
    spend_with_tax: num(row.spend_with_tax),
    impressions: Math.max(0, Math.round(num(row.impressions))),
    reach: Math.max(0, Math.round(num(row.reach))),
    clicks: Math.max(0, Math.round(num(row.clicks))),
    link_clicks: Math.max(0, Math.round(num(row.link_clicks))),
    meta_conversations: Math.max(0, Math.round(num(row.meta_conversations))),
    conversations,
    contacts,
    scanned_contacts: Math.max(0, Math.round(num(row.scanned_contacts))),
    hot_leads: Math.max(0, Math.round(num(row.hot_leads))),
    message_count: Math.max(0, Math.round(num(row.message_count))),
    contact_rate: conversations ? Math.round((contacts / conversations) * 10000) / 100 : 0,
    cost_per_conversation: 0,
    cost_per_contact: 0,
    data_source: row.data_source || "v10_core_live",
  };
}

function exportRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const output = {};
    for (const [key, value] of Object.entries(row || {})) {
      if (value == null) output[key] = "";
      else if (Array.isArray(value) || typeof value === "object") output[key] = JSON.stringify(value);
      else output[key] = value;
    }
    return output;
  });
}

export function installReportRoutes(app, { supabaseUrl, publishableKey }) {
  const reportingKey = clean(
    process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    publishableKey,
  );
  const coreBase = clean(process.env.AIGUKA_V9_CORE_URL || supabaseUrl);
  const coreKey = clean(
    process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    reportingKey,
  );
  const sources = createV10ReportSources({
    reportingBase: clean(process.env.AIGUKA_V9_REPORTING_URL || supabaseUrl),
    reportingKey,
    coreBase,
    coreKey,
    publishableKey,
  });
  const meta = createMetaDirectReporting();

  async function filters() {
    const registry = await sources.staticFilters();
    return {
      ok: true,
      data: registry.data || { pages: [], ad_accounts: [], ads: [] },
      source: registry.source || "v10_core_report_scope",
      warnings: Array.isArray(registry.warnings) ? registry.warnings : [],
    };
  }

  async function metrics(query) {
    const filterResult = await filters();
    try {
      const result = await sources.customerMetrics(query, filterResult.data || {});
      return { filterResult, result };
    } catch (error) {
      return {
        filterResult,
        result: {
          ok: false,
          rows: [],
          ads: [],
          daily: [],
          source: "v10_core_customer_metrics_unavailable",
          warnings: [`CORE_CUSTOMER_METRICS:${error.message}`],
        },
      };
    }
  }

  async function ads(query) {
    const { filterResult, result } = await metrics(query);
    const baseWarnings = [
      ...(filterResult.warnings || []),
      ...(result.warnings || []),
    ];
    const fallbackRows = (result.ads || []).map(zeroMetricRow).filter((row) => matches(row, query));

    if (!meta.ready()) {
      return {
        ok: true,
        data: fallbackRows,
        count: fallbackRows.length,
        accounts: accountsFromFilters(filterResult.data || {}),
        source: "v10_core_only",
        filter_source: filterResult.source,
        customer_metric_source: result.source,
        warnings: [...baseWarnings, "META_ACCESS_TOKEN_MISSING"],
      };
    }

    try {
      const live = await meta.ads({
        from: queryValue(query, "from"),
        to: queryValue(query, "to"),
        accountIds: accountIds(filterResult.data || {}, query),
        filters: filterResult.data || {},
        fallbackRows: result.ads || [],
        query: queryShape(query),
      });
      return {
        ok: true,
        data: Array.isArray(live.rows) ? live.rows : [],
        count: Array.isArray(live.rows) ? live.rows.length : 0,
        accounts: Array.isArray(live.accounts) && live.accounts.length ? live.accounts : accountsFromFilters(filterResult.data || {}),
        source: "meta_live_plus_v10_core",
        filter_source: filterResult.source,
        customer_metric_source: result.source,
        warnings: [...baseWarnings, ...(live.warnings || [])],
        range: live.range || null,
      };
    } catch (error) {
      return {
        ok: true,
        data: fallbackRows,
        count: fallbackRows.length,
        accounts: accountsFromFilters(filterResult.data || {}),
        source: "v10_core_fallback",
        filter_source: filterResult.source,
        customer_metric_source: result.source,
        warnings: [...baseWarnings, `META_DIRECT:${error.message}`],
      };
    }
  }

  async function daily(query) {
    const { filterResult, result } = await metrics(query);
    const baseWarnings = [
      ...(filterResult.warnings || []),
      ...(result.warnings || []),
    ];
    const fallbackRows = (result.daily || []).map((row) => ({
      ...zeroMetricRow(row),
      data_status: row.data_status || "Dữ liệu khách từ V10 Core; Meta trực tiếp chưa sẵn sàng",
      has_runtime_data: true,
      has_ads_data: false,
    })).filter((row) => matches(row, query));

    if (!meta.ready()) {
      return {
        ok: true,
        data: fallbackRows,
        count: fallbackRows.length,
        accounts: accountsFromFilters(filterResult.data || {}),
        source: "v10_core_only",
        filter_source: filterResult.source,
        customer_metric_source: result.source,
        warnings: [...baseWarnings, "META_ACCESS_TOKEN_MISSING"],
      };
    }

    try {
      const live = await meta.daily({
        from: queryValue(query, "from"),
        to: queryValue(query, "to"),
        accountIds: accountIds(filterResult.data || {}, query),
        filters: filterResult.data || {},
        fallbackAds: result.ads || [],
        fallbackDaily: result.daily || [],
        query: queryShape(query),
      });
      return {
        ok: true,
        data: Array.isArray(live.rows) ? live.rows : [],
        count: Array.isArray(live.rows) ? live.rows.length : 0,
        accounts: Array.isArray(live.accounts) && live.accounts.length ? live.accounts : accountsFromFilters(filterResult.data || {}),
        source: "meta_live_plus_v10_core",
        filter_source: filterResult.source,
        customer_metric_source: result.source,
        warnings: [...baseWarnings, ...(live.warnings || [])],
        range: live.range || null,
      };
    } catch (error) {
      return {
        ok: true,
        data: fallbackRows,
        count: fallbackRows.length,
        accounts: accountsFromFilters(filterResult.data || {}),
        source: "v10_core_fallback",
        filter_source: filterResult.source,
        customer_metric_source: result.source,
        warnings: [...baseWarnings, `META_DIRECT:${error.message}`],
      };
    }
  }

  async function leads(query) {
    const filterResult = await filters();
    const limit = Math.min(Math.max(Number(query?.limit || 250), 1), 10000);
    const offset = Math.max(Number(query?.offset || 0), 0);
    const raw = await sources.rpc(coreBase, coreKey, "v10_report_customer_leads", {
      p_from: queryValue(query, "from"),
      p_to: queryValue(query, "to"),
      p_page_id: queryValue(query, "page_id"),
      p_ad_id: queryValue(query, "ad_id"),
      p_search: queryValue(query, "search"),
      p_limit: Math.min(10000, Math.max(limit + offset, limit)),
      p_offset: 0,
    }, 25000);
    const allRows = (Array.isArray(raw?.data) ? raw.data : []).filter((row) => matches(row, query));
    return {
      ok: true,
      data: allRows.slice(offset, offset + limit),
      count: Number.isFinite(Number(raw?.count)) && !queryValue(query, "ad_account_id") && !queryValue(query, "campaign_id") && !queryValue(query, "adset_id")
        ? Number(raw.count)
        : allRows.length,
      source: raw?.source || "v10_core_customer_leads",
      filter_source: filterResult.source,
      warnings: filterResult.warnings || [],
      accounts: [],
    };
  }

  async function loadReport(type, query) {
    if (type === "daily") return daily(query);
    if (type === "leads") return leads(query);
    return ads(query);
  }

  app.get("/functions/v1/aiguka-v8-report-api", async (req, res) => {
    const action = clean(req.query.action || "health").toLowerCase();
    try {
      if (action === "health") {
        return res.json({
          ok: true,
          service: "aiguka-v11-v10-only-report",
          version: 11,
          meta_direct_ready: meta.ready(),
          legacy_v8_rpc_enabled: false,
          core_source: "v10",
        });
      }
      if (action === "filters") return res.json(await filters());
      if (["ads", "daily", "leads"].includes(action)) return res.json(await loadReport(action, req.query));
      if (action === "summary") {
        const report = await ads(req.query);
        const rows = report.data || [];
        const summary = rows.reduce((sum, row) => {
          for (const key of ["spend", "tax_amount", "spend_with_tax", "impressions", "reach", "clicks", "meta_conversations", "conversations", "contacts", "scanned_contacts", "hot_leads", "message_count"]) {
            sum[key] += num(row[key]);
          }
          return sum;
        }, { spend: 0, tax_amount: 0, spend_with_tax: 0, impressions: 0, reach: 0, clicks: 0, meta_conversations: 0, conversations: 0, contacts: 0, scanned_contacts: 0, hot_leads: 0, message_count: 0 });
        summary.contact_rate = summary.conversations ? Math.round((summary.contacts / summary.conversations) * 10000) / 100 : 0;
        return res.json({ ...report, data: summary, count: rows.length });
      }
      if (action === "system") {
        const registry = await filters();
        return res.json({ ok: true, data: { pages: registry.data?.pages || [], ad_accounts: registry.data?.ad_accounts || [], workers: [], server: { source: "v10" } } });
      }
      if (action === "export") {
        const type = ["ads", "daily", "leads"].includes(clean(req.query.report)) ? clean(req.query.report) : "ads";
        const report = await loadReport(type, { ...req.query, limit: 10000, offset: 0 });
        const sheet = XLSX.utils.json_to_sheet(exportRows(report.data || []));
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, sheet, type);
        const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
        res.setHeader("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("content-disposition", `attachment; filename="bao-cao-${type}-${req.query.from || ""}_den_${req.query.to || ""}.xlsx"`);
        return res.send(buffer);
      }
      return res.status(404).json({ ok: false, error: "unknown_route" });
    } catch (error) {
      console.error("[AIGUKA V11 report]", error);
      return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  return { filters, ads, daily, leads };
}
