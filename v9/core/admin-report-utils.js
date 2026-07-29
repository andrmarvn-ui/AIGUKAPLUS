const DEFAULT_MAX_DAYS = 93;

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateOnly(value, fallback) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : fallback;
}

export function parseReportRange(query = {}, now = new Date(), maxDays = DEFAULT_MAX_DAYS) {
  const today = now.toISOString().slice(0, 10);
  const fallbackFrom = new Date(now.getTime() - 6 * 86_400_000).toISOString().slice(0, 10);
  const from = dateOnly(query.from, fallbackFrom);
  const to = dateOnly(query.to, today);
  const days = Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (!Number.isFinite(days) || days < 1 || days > maxDays) {
    throw Object.assign(new Error("REPORT_RANGE_INVALID"), { status: 400, details: { from, to, max_days: maxDays } });
  }
  return { from, to, days };
}

export function aggregatePerformance(rows = []) {
  const result = { spend: 0, impressions: 0, reach: 0, clicks: 0, conversations: 0, customers: 0, contacts: 0, deliveries: 0 };
  for (const row of rows) for (const key of Object.keys(result)) result[key] += number(row[key]);
  result.contact_rate = result.conversations ? Math.round(result.contacts * 10_000 / result.conversations) / 100 : 0;
  result.cost_per_conversation = result.conversations ? Math.round(result.spend * 100 / result.conversations) / 100 : 0;
  result.cost_per_contact = result.contacts ? Math.round(result.spend * 100 / result.contacts) / 100 : 0;
  return result;
}

export function groupPerformance(rows, keyOf, fields) {
  const map = new Map();
  for (const row of rows || []) {
    const key = keyOf(row);
    if (!map.has(key)) map.set(key, { dimensions: Object.fromEntries(fields.map((field) => [field, row[field] ?? null])), rows: [] });
    map.get(key).rows.push(row);
  }
  return [...map.values()].map(({ dimensions, rows: groupRows }) => ({ ...dimensions, ...aggregatePerformance(groupRows) }));
}

export function pageMode(value) {
  const mode = String(value || "").toUpperCase();
  if (!["OFF", "SUPPORT", "SHADOW", "CANARY"].includes(mode)) throw Object.assign(new Error("PAGE_MODE_NOT_ALLOWED"), { status: 400 });
  return mode;
}

export function runtimeMode(value) {
  const mode = String(value || "").toUpperCase();
  if (!["OFF", "SHADOW", "CANARY"].includes(mode)) throw Object.assign(new Error("RUNTIME_MODE_NOT_ALLOWED"), { status: 400 });
  return mode;
}
