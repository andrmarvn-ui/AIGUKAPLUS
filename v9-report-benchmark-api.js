const CORE_BASE = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
const CORE_KEY = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");
const REPORT_BASE = String(process.env.AIGUKA_V9_REPORTING_URL || process.env.SUPABASE_URL || "").replace(/\/$/, "");
const REPORT_KEY = String(process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "");

const enc = (value) => encodeURIComponent(String(value ?? ""));
const num = (value) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

async function rest(base, key, path, options = {}) {
  if (!base || !key) throw Object.assign(new Error("DATA_SOURCE_NOT_CONFIGURED"), { status: 503 });
  const response = await fetch(`${base}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      Prefer: options.prefer || "return=representation",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout || 10_000),
    cache: "no-store",
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw: raw.slice(0, 500) }; }
  if (!response.ok) throw Object.assign(new Error(data?.message || data?.error || `HTTP_${response.status}`), { status: response.status });
  return data;
}

function dateOnly(value, fallback) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : fallback;
}

function filter(field, value, normalizeAct = false) {
  let text = String(value || "").trim();
  if (!text) return "";
  if (normalizeAct) text = text.replace(/^act_/, "");
  return `&${field}=eq.${enc(text)}`;
}

async function vatSummary(query) {
  const today = new Date().toISOString().slice(0, 10);
  const fallbackFrom = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  const from = dateOnly(query.from, fallbackFrom);
  const to = dateOnly(query.to, today);
  const path = "fact_daily_ad_performance?select=spend,conversations,contacts,metadata"
    + `&report_date=gte.${from}&report_date=lte.${to}`
    + filter("page_id", query.page_id)
    + filter("ad_account_id", query.ad_account_id, true)
    + filter("campaign_id", query.campaign_id)
    + filter("adset_id", query.adset_id)
    + filter("ad_id", query.ad_id)
    + "&limit=20000";
  const rows = await rest(REPORT_BASE, REPORT_KEY, path);
  let spend = 0;
  let conversations = 0;
  let contacts = 0;
  for (const row of rows || []) {
    const metadata = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const baseSpend = metadata.spend_before_tax == null ? num(row.spend) / 1.05 : num(metadata.spend_before_tax);
    spend += baseSpend;
    conversations += num(row.conversations);
    contacts += num(row.contacts);
  }
  spend = Math.round(spend * 100) / 100;
  const taxAmount = Math.round(spend * 0.05 * 100) / 100;
  const spendWithTax = Math.round((spend + taxAmount) * 100) / 100;
  return {
    ok: true,
    data: {
      spend,
      vat_rate: 5,
      tax_amount: taxAmount,
      spend_with_tax: spendWithTax,
      conversations,
      contacts,
      contact_rate: conversations ? Math.round(contacts * 10_000 / conversations) / 100 : 0,
      cost_per_conversation: conversations ? Math.round(spendWithTax * 100 / conversations) / 100 : 0,
      cost_per_contact: contacts ? Math.round(spendWithTax * 100 / contacts) / 100 : 0,
    },
    range: { from, to },
    source: "v9_reporting_fact_vat_5",
  };
}

async function currentBenchmark() {
  const runs = await rest(CORE_BASE, CORE_KEY, "v9_shadow_benchmark_runs?select=*&order=started_at.desc&limit=1");
  const run = runs?.[0] || null;
  if (!run) return { ok: true, run: null, data: [], progress: { observed: 0, completed: 0, target: 0 } };
  const rows = await rest(
    CORE_BASE,
    CORE_KEY,
    `v9_shadow_benchmark_conversations?select=*&run_id=eq.${enc(run.id)}&order=sequence_no.asc&limit=100`,
  );
  return {
    ok: true,
    run,
    data: rows || [],
    progress: {
      observed: Number(run.observed_conversations || rows?.length || 0),
      completed: Number(run.completed_conversations || 0),
      target: Number(run.target_conversations || 0),
      initial_count: Number(run.baseline_conversations || 0),
      remaining: Math.max(0, Number(run.target_conversations || 0) - Number(run.observed_conversations || rows?.length || 0)),
    },
    transport_locked: run.transport_locked !== false,
    external_bot_mode: run.external_bot_mode,
  };
}

function fail(res, error, fallback) {
  res.status(error.status || 502).json({ ok: false, error: error.message || fallback });
}

export function installV9ReportBenchmarkApi(app) {
  app.get("/api/v9/report/summary-vat", async (req, res) => {
    try {
      res.setHeader("cache-control", "private, max-age=10, stale-while-revalidate=30");
      res.json(await vatSummary(req.query || {}));
    } catch (error) { fail(res, error, "VAT_SUMMARY_FAILED"); }
  });

  app.get("/api/v9/benchmark/current", async (_req, res) => {
    try {
      res.setHeader("cache-control", "no-store");
      res.json(await currentBenchmark());
    } catch (error) { fail(res, error, "BENCHMARK_QUERY_FAILED"); }
  });
}

export const __private__ = { vatSummary, currentBenchmark };