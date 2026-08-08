function clean(value) {
  return String(value || "").trim();
}

function catalogMap(knowledgeAdvisors = {}) {
  const catalog = Array.isArray(knowledgeAdvisors?.catalog) ? knowledgeAdvisors.catalog : [];
  return new Map(catalog.map((node) => [clean(node?.catalog_key), node]).filter(([key]) => Boolean(key)));
}

function broadGroupFor(key, byKey) {
  let cursor = clean(key);
  if (!cursor) return "other";
  const visited = new Set();
  let highest = cursor;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    highest = cursor;
    cursor = clean(byKey.get(cursor)?.parent_key);
  }

  const path = [...visited];
  if (path.includes("phong_tam")) return "phong_tam";
  if (path.includes("phong_bep")) return "phong_bep";
  if (path.includes("gach_ngoi") || path.includes("gach_da_op_lat")) return "gach_op_lat";
  if (path.includes("quat_tran") || path.some((item) => item.startsWith("quat_"))) return "quat_tran";
  return highest;
}

function groupLabel(groupKey, byKey) {
  const explicit = {
    phong_tam: "Thiết bị phòng tắm",
    phong_bep: "Thiết bị nhà bếp",
    gach_op_lat: "Gạch ốp lát",
    quat_tran: "Quạt trần",
  };
  if (explicit[groupKey]) return explicit[groupKey];
  return clean(byKey.get(groupKey)?.display_name) || groupKey;
}

export function deriveProductThreads(unresolvedNeeds = [], knowledgeAdvisors = {}) {
  const byKey = catalogMap(knowledgeAdvisors);
  const groups = new Map();

  for (const need of Array.isArray(unresolvedNeeds) ? unresolvedNeeds : []) {
    const keys = Array.isArray(need?.catalog_keys) ? need.catalog_keys.map(clean).filter(Boolean) : [];
    if (!keys.length) continue;
    for (const key of keys) {
      const groupKey = broadGroupFor(key, byKey);
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          thread_id: `product:${groupKey}`,
          group_key: groupKey,
          label: groupLabel(groupKey, byKey),
          state: "pending_answer",
          catalog_keys: [],
          source_topics: [],
          media_explicit: false,
        });
      }
      const thread = groups.get(groupKey);
      if (!thread.catalog_keys.includes(key)) thread.catalog_keys.push(key);
      if (need?.topic && !thread.source_topics.includes(String(need.topic))) thread.source_topics.push(String(need.topic));
      if (need?.status === "pending_media") thread.state = "pending_media";
      if (need?.media_explicit) thread.media_explicit = true;
    }
  }

  return [...groups.values()];
}

export function planMediaBundles(productThreads = [], selectedCatalogKeys = [], knowledgeAdvisors = {}) {
  const byKey = catalogMap(knowledgeAdvisors);
  const selected = [...new Set((Array.isArray(selectedCatalogKeys) ? selectedCatalogKeys : []).map(clean).filter(Boolean))];
  const groups = new Map();

  for (const key of selected) {
    const groupKey = broadGroupFor(key, byKey);
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        bundle_key: `media:${groupKey}`,
        group_key: groupKey,
        label: groupLabel(groupKey, byKey),
        catalog_keys: [],
        max_assets: 20,
      });
    }
    const bundle = groups.get(groupKey);
    if (!bundle.catalog_keys.includes(key)) bundle.catalog_keys.push(key);
  }

  // If the AI selected a parent/child alias that was omitted from the compact advisor,
  // preserve the thread grouping rather than flattening unrelated products together.
  for (const thread of Array.isArray(productThreads) ? productThreads : []) {
    if (thread?.state !== "pending_media") continue;
    const groupKey = clean(thread.group_key);
    if (!groupKey || groups.has(groupKey)) continue;
    const keys = (thread.catalog_keys || []).map(clean).filter((key) => selected.includes(key));
    if (!keys.length) continue;
    groups.set(groupKey, {
      bundle_key: `media:${groupKey}`,
      group_key: groupKey,
      label: clean(thread.label) || groupLabel(groupKey, byKey),
      catalog_keys: keys,
      max_assets: 20,
    });
  }

  return [...groups.values()];
}

export const productThreadsVersion = "v10_product_threads_v1_grouped_media";
