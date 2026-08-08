function rowsFromPayload(payload = {}) {
  if (Array.isArray(payload?.conversations)) return payload.conversations;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

export function createPancakeConversationSnapshotCache(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Math.max(500, Number(options.timeoutMs || 3500));
  const ttlMs = Math.max(250, Number(options.ttlMs || 5000));
  const maxPages = Math.max(1, Math.min(10, Number(options.maxPages || 4)));
  const now = typeof options.now === "function" ? options.now : Date.now;
  const entries = new Map();

  async function fetchSnapshot(pageId, token) {
    const rows = [];
    const attempts = [];
    let lastConversationId = "";
    for (let pageNo = 0; pageNo < maxPages; pageNo += 1) {
      let url = "https://pages.fm/api/public_api/v2/pages/" + encodeURIComponent(pageId)
        + "/conversations?page_access_token=" + encodeURIComponent(token);
      if (lastConversationId) url += "&last_conversation_id=" + encodeURIComponent(lastConversationId);
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
      if (!response.ok) {
        attempts.push({ page: pageNo + 1, status: response.status, count: 0 });
        break;
      }
      const payload = await response.json().catch(() => ({}));
      const pageRows = rowsFromPayload(payload);
      attempts.push({ page: pageNo + 1, status: response.status, count: pageRows.length });
      rows.push(...pageRows);
      const tail = pageRows[pageRows.length - 1];
      const next = String(tail?.id || tail?.conversation_id || "").trim();
      if (!next || next === lastConversationId || pageRows.length === 0) break;
      lastConversationId = next;
    }
    return { rows, attempts, loaded_at: new Date(now()).toISOString() };
  }

  async function load(pageId, token) {
    const key = String(pageId || "") + "|" + String(token || "");
    const existing = entries.get(key);
    if (existing && (existing.pending || existing.expiresAt > now())) return existing.promise;

    const entry = { pending: true, expiresAt: 0, promise: null };
    entry.promise = fetchSnapshot(pageId, token)
      .then((snapshot) => {
        entry.pending = false;
        entry.expiresAt = now() + ttlMs;
        return snapshot;
      })
      .catch((error) => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
    entries.set(key, entry);
    return entry.promise;
  }

  function clear() {
    entries.clear();
  }

  return { load, clear };
}

export const pancakeConversationSnapshotVersion = "v10_pancake_page_snapshot_v1_shared_per_page";
