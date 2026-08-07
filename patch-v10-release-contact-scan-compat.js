import fs from "node:fs";

const file = "v10-live-release.js";
const before = 'const VERSION = "v10_pancake_contact_guard_v2";';
const after = 'const VERSION = "v10_pancake_contact_guard_v3_scan_phone";';

if (fs.existsSync(file)) {
  let source = fs.readFileSync(file, "utf8");
  if (source.includes(before) && !source.includes(after)) {
    source = source.replace(before, after);
    fs.writeFileSync(file, source, "utf8");
    console.log("[AIGUKA V10] release contract aligned with Pancake scanned-phone guard v3");
  }
}
