import fs from "node:fs";
import vm from "node:vm";

const file = "dashboard-report-v10-patch.js";
const broken = "return /Có SĐT\\/Zalo/i.test(item.querySelector('.cardLabel')?.textContent||'')";
const safe = "return String(item.querySelector('.cardLabel')?.textContent||'').includes('Có SĐT/Zalo')";

let source = fs.readFileSync(file, "utf8");
if (source.includes(broken)) {
  source = source.replace(broken, safe);
  fs.writeFileSync(file, source, "utf8");
}

if (fs.readFileSync(file, "utf8").includes(broken)) {
  throw new Error("V10_REPORT_SCANNED_CONTACT_REGEX_REPAIR_FAILED");
}

const { patchV10ReportTablesUi } = await import("./dashboard-report-v10-patch.js");
const html = patchV10ReportTablesUi("<html><body></body></html>");
const pattern = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
let match;
let index = 0;
while ((match = pattern.exec(html)) !== null) {
  if (/\bsrc\s*=/.test(match[1] || "")) continue;
  index += 1;
  new vm.Script(match[2] || "", { filename: `v10-report-inline-${index}.js` });
}
if (!index) throw new Error("V10_REPORT_INLINE_SCRIPT_MISSING");

console.log("[AIGUKA V10] scanned-contact dashboard regex repaired and inline scripts validated");
