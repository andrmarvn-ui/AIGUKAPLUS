export function bridgeFreshCutoff(nowMs = Date.now(), freshWindowMs = 120_000) {
  return new Date(Number(nowMs) - Math.max(30_000, Number(freshWindowMs || 120_000))).toISOString();
}

export function prioritizeBridgeCandidates(freshRows = [], recoveryRows = [], limit = 20) {
  const max = Math.max(1, Number(limit || 20));
  const output = [];
  const seen = new Set();
  for (const [lane, rows] of [["fresh", freshRows], ["recovery", recoveryRows]]) {
    for (const row of Array.isArray(rows) ? rows : []) {
      const key = String(row?.id || "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      output.push({ ...row, bridge_lane: lane });
      if (output.length >= max) return output;
    }
  }
  return output;
}

export const bridgePriorityVersion = "v9_bridge_priority_v1_fresh_lane_first";
