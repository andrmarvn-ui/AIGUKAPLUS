import fs from "node:fs";

const file = "v10-outbound-worker.js";
const MARK = "AIGUKA_V10_HIERARCHICAL_CATALOG_RESOLVER_V1";
if (!fs.existsSync(file)) throw new Error("V10_HIERARCHICAL_RESOLVER_WORKER_MISSING");
let source = fs.readFileSync(file, "utf8");

if (!source.includes(MARK)) {
  const start = source.indexOf("  const knownKeys = new Set(nodes.map");
  const end = source.indexOf("  const seen = new Set();", start);
  if (start < 0 || end < 0) throw new Error("V10_HIERARCHICAL_RESOLVER_TARGET_MISSING");

  const replacement = String.raw`  const nodeByKey = new Map(nodes
    .map((node) => [String(node?.catalog_key || "").trim(), node])
    .filter(([key]) => Boolean(key)));
  const knownKeys = new Set(nodeByKey.keys());
  const selectedCatalogKeys = new Set((output.selected_catalog_keys || [])
    .map((value) => String(value || "").trim().replace(/^[\s\[\]\x60'\"]+|[\s\[\]\x60'\".,;:]+$/g, ""))
    .filter((value) => knownKeys.has(value)));

  // A selected parent catalog represents its complete product scope. Walk the
  // parent chain so every active descendant with verified assets participates.
  // Selecting a specific child does not pull in siblings. Empty branches are
  // naturally ignored when their asset list is empty.
  function belongsToSelectedScope(node) {
    let currentKey = String(node?.catalog_key || "").trim();
    const visited = new Set();
    while (currentKey && !visited.has(currentKey)) {
      if (selectedCatalogKeys.has(currentKey)) return true;
      visited.add(currentKey);
      currentKey = String(nodeByKey.get(currentKey)?.parent_key || "").trim();
    }
    return false;
  }

  const candidates = nodes.filter(belongsToSelectedScope);

`;

  source = source.slice(0, start) + replacement + source.slice(end);
  source = source.replace(
    'const VERSION = "v10_outbound_safety_only_v1";',
    'const VERSION = "v10_outbound_hierarchical_catalog_v2";',
  );
  source += `\n// ${MARK}\n`;
  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA V10] hierarchical catalog resolver enabled: parent scopes inherit all non-empty descendants");
}
