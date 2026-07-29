const MARK = Symbol.for("aiguka.v9.postgrest.uniform.batch");

function inputUrl(input) {
  if (typeof input === "string" || input instanceof URL) return new URL(String(input));
  if (typeof Request !== "undefined" && input instanceof Request) return new URL(input.url);
  return null;
}

function keySignature(row) {
  return Object.keys(row || {}).sort().join("\u001f");
}

export function splitUniformBatches(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const signature = keySignature(row);
    const values = groups.get(signature) || [];
    values.push(row);
    groups.set(signature, values);
  }
  return [...groups.values()];
}

export function installV9PostgrestUniformBatch() {
  if (globalThis[MARK]) return globalThis[MARK];
  const originalFetch = globalThis.fetch?.bind(globalThis);
  if (!originalFetch) throw new Error("V9_UNIFORM_BATCH_FETCH_UNAVAILABLE");

  globalThis.fetch = async function v9PostgrestUniformBatchFetch(input, init = {}) {
    const url = inputUrl(input);
    const method = String(init.method || (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")).toUpperCase();
    const isDimAdsUpsert = Boolean(
      url
      && method === "POST"
      && /\/rest\/v1\/dim_ads$/i.test(url.pathname)
      && url.searchParams.has("on_conflict")
    );
    if (!isDimAdsUpsert || typeof init.body !== "string") return originalFetch(input, init);

    let rows;
    try { rows = JSON.parse(init.body); } catch { return originalFetch(input, init); }
    if (!Array.isArray(rows) || rows.length < 2) return originalFetch(input, init);
    const batches = splitUniformBatches(rows);
    if (batches.length < 2) return originalFetch(input, init);

    let lastResponse = null;
    for (const batch of batches) {
      lastResponse = await originalFetch(input, { ...init, body: JSON.stringify(batch) });
      if (!lastResponse.ok) return lastResponse;
    }
    return lastResponse;
  };

  const state = { enabled: true, originalFetch };
  globalThis[MARK] = state;
  return state;
}

export const v9UniformBatchState = installV9PostgrestUniformBatch();
