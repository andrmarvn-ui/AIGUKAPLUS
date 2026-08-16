import fs from "node:fs";

const patchFile = "patch-dashboard-ui-filter-metrics.js";
let source = fs.readFileSync(patchFile, "utf8");

const replacement = `  const filterAnchor = \`function emptyRow(body,colspan){body.innerHTML='<tr><td class="empty" colspan="'+colspan+'">Không có dữ liệu phù hợp bộ lọc.</td></tr>'}\`;`;
const pattern = /^\s*const filterAnchor\s*=.*$/m;
if (!pattern.test(source)) throw new Error("REPORT_FILTER_ANCHOR_DECLARATION_NOT_FOUND");
source = source.replace(pattern, replacement);
fs.writeFileSync(patchFile, source, "utf8");

await import("./patch-dashboard-ui-filter-metrics.js");
