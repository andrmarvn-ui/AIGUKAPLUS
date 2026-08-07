import fs from "node:fs";

const MARK = "AIGUKA_V10_REPORT_CONTACT_SCAN_META_METRIC_V1";

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`REPORT_SCAN_PATCH_FILE_MISSING:${file}`);
  return fs.readFileSync(file, "utf8");
}
function write(file, source) {
  fs.writeFileSync(file, source, "utf8");
}
function mustReplace(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`REPORT_SCAN_PATCH_TARGET_MISSING:${label}`);
  return source.replace(before, after);
}

// 1) Meta: do not add overlapping messaging action aliases together.
{
  const file = "meta-direct-reporting.js";
  let source = read(file);
  if (!source.includes(MARK)) {
    const helperAnchor = "function paymentLast4(details) {";
    if (!source.includes(helperAnchor)) throw new Error("REPORT_SCAN_META_HELPER_ANCHOR_MISSING");
    source = source.replace(helperAnchor, `function preferredActionValue(actions, names) {\n  for (const name of names) {\n    const value = actionValue(actions, [name]);\n    if (value > 0) return value;\n  }\n  return 0;\n}\n\n${helperAnchor}`);
    source = source.replace(
      /meta_conversations:\s*actionValue\(actions,\s*\[\s*"onsite_conversion\.messaging_conversation_started_7d",\s*"messaging_conversation_started_7d",\s*"onsite_conversion\.messaging_first_reply",?\s*\]\)/m,
      `meta_conversations: preferredActionValue(actions, [\n      "onsite_conversion.messaging_conversation_started_7d",\n      "messaging_conversation_started_7d",\n      "onsite_conversion.messaging_first_reply",\n    ])`,
    );
    if (!source.includes("meta_conversations: preferredActionValue")) throw new Error("REPORT_SCAN_META_CONVERSATION_REPLACE_FAILED");
    source = source.replaceAll(
      "      contacts,\n      hot_leads: integer(fallback.hot_leads),",
      "      contacts,\n      scanned_contacts: integer(fallback.scanned_contacts),\n      hot_leads: integer(fallback.hot_leads),",
    );
    source += `\n// ${MARK}\n`;
    write(file, source);
  }
}

// 2) Core report adapter: carry scanned_contacts through ad/daily aggregation.
{
  const file = "v10-report-sources.js";
  let source = read(file);
  if (!source.includes(MARK)) {
    source = mustReplace(
      source,
      "      contacts: Math.max(0, Math.round(number(row.contacts))),\n      hot_leads:",
      "      contacts: Math.max(0, Math.round(number(row.contacts))),\n      scanned_contacts: Math.max(0, Math.round(number(row.scanned_contacts))),\n      hot_leads:",
      "source_attach_scanned",
    );
    source = source.replaceAll(
      "      contacts: 0,\n      hot_leads: 0,",
      "      contacts: 0,\n      scanned_contacts: 0,\n      hot_leads: 0,",
    );
    source = source.replaceAll(
      '["conversations", "contacts", "hot_leads", "message_count"]',
      '["conversations", "contacts", "scanned_contacts", "hot_leads", "message_count"]',
    );
    source += `\n// ${MARK}\n`;
    write(file, source);
  }
}

// 3) HTTP report API: summary/export/zero rows expose the scanned-phone subset.
{
  const file = "report-handler-v10.js";
  let source = read(file);
  if (!source.includes(MARK)) {
    source = source.replaceAll(
      "            contacts: 0,\n            hot_leads: 0,",
      "            contacts: 0,\n            scanned_contacts: 0,\n            hot_leads: 0,",
    );
    source = source.replaceAll(
      '["spend", "tax_amount", "spend_with_tax", "impressions", "reach", "clicks", "meta_conversations", "conversations", "contacts", "hot_leads", "message_count"]',
      '["spend", "tax_amount", "spend_with_tax", "impressions", "reach", "clicks", "meta_conversations", "conversations", "contacts", "scanned_contacts", "hot_leads", "message_count"]',
    );
    source = source.replace(
      "{ spend: 0, tax_amount: 0, spend_with_tax: 0, impressions: 0, reach: 0, clicks: 0, meta_conversations: 0, conversations: 0, contacts: 0, hot_leads: 0, message_count: 0 }",
      "{ spend: 0, tax_amount: 0, spend_with_tax: 0, impressions: 0, reach: 0, clicks: 0, meta_conversations: 0, conversations: 0, contacts: 0, scanned_contacts: 0, hot_leads: 0, message_count: 0 }",
    );
    source = source.replaceAll(
      '"Khách đối chiếu": +row.conversations || 0, "Có SĐT/Zalo": +row.contacts || 0,',
      '"Khách đối chiếu": +row.conversations || 0, "Có SĐT/Zalo": +row.contacts || 0, "SĐT quét": +row.scanned_contacts || 0,',
    );
    source += `\n// ${MARK}\n`;
    write(file, source);
  }
}

// 4) Pancake: "Đã quét" means a phone was obtained from the customer profile.
{
  const file = "v10-pancake-contact-guard-worker.js";
  let source = read(file);
  if (!source.includes(MARK)) {
    source = source.replace('const VERSION = "v10_pancake_contact_guard_v2";', 'const VERSION = "v10_pancake_contact_guard_v3_scan_phone";');
    const oldFn = `function hasContactTag(labels = []) {\n  return labels.some((label) => /(^|\\b)(sdt|so dien thoai|dien thoai|zalo)(\\b|$)/i.test(normalize(label)));\n}`;
    const newFn = `function hasDirectContactTag(labels = []) {\n  return labels.some((label) => /(^|\\b)(sdt|so dien thoai|dien thoai|zalo)(\\b|$)/i.test(normalize(label)));\n}\nfunction hasScannedPhoneTag(labels = []) {\n  return labels.some((label) => /(^|\\b)(da quet)(\\b|$)/i.test(normalize(label)));\n}\nfunction hasContactTag(labels = []) {\n  return hasDirectContactTag(labels) || hasScannedPhoneTag(labels);\n}`;
    source = mustReplace(source, oldFn, newFn, "pancake_scan_tag_fn");
    source = mustReplace(
      source,
      "body: { page_id: String(pageId), sender_id: String(senderId), has_contact_tag: hasContactTag(labels), tag_labels: labels,",
      "body: { page_id: String(pageId), sender_id: String(senderId), has_contact_tag: hasContactTag(labels), has_scanned_phone_tag: hasScannedPhoneTag(labels), tag_labels: labels,",
      "pancake_guard_payload",
    );
    source = mustReplace(source, "  let tagged = 0;\n  let pages = 0;", "  let tagged = 0;\n  let scanned = 0;\n  let pages = 0;", "pancake_counter_init");
    source = mustReplace(source, "        if (hasContactTag(labels)) tagged += 1;", "        if (hasContactTag(labels)) tagged += 1;\n        if (hasScannedPhoneTag(labels)) scanned += 1;", "pancake_counter_increment");
    source = source.replaceAll("{ candidates, matched, tagged, pages }", "{ candidates, matched, tagged, scanned, pages }");
    source += `\n// ${MARK}\n`;
    write(file, source);
  }
}

// 5) Dashboard table/card: expose SĐT quét separately without replacing total contacts.
{
  const file = "dashboard-report-v10-patch.js";
  let source = read(file);
  if (!source.includes(MARK)) {
    const installAnchor = "function install(){const current=window.renderLeads;";
    if (!source.includes(installAnchor)) throw new Error("REPORT_SCAN_DASHBOARD_INSTALL_ANCHOR_MISSING");
    const helpers = String.raw`
function rewriteScannedContactMetric(rows){
  if(view!=='dashboard'&&view!=='daily')return;
  const body=document.getElementById('leadRows');if(!body)return;const table=body.closest('table');if(!table)return;
  const head=table.querySelector('thead tr');if(!head)return;
  const labels=[...head.cells].map(function(th){return th.textContent.trim()});
  let contactIndex=labels.indexOf('SĐT/Zalo');if(contactIndex<0)return;
  let scanIndex=labels.indexOf('SĐT quét');
  if(scanIndex<0){
    const th=document.createElement('th');th.textContent='SĐT quét';head.insertBefore(th,head.cells[contactIndex+1]||null);scanIndex=contactIndex+1;
    [...body.rows].forEach(function(tr,index){if(tr.querySelector('.empty')){tr.querySelector('.empty')?.setAttribute('colspan',String(head.cells.length));return}const td=document.createElement('td');td.className='aiguka_num';td.textContent=number(rows[index]?.scanned_contacts||0);tr.insertBefore(td,tr.cells[scanIndex]||null)});
  }else{
    [...body.rows].forEach(function(tr,index){if(!tr.querySelector('.empty')&&tr.cells[scanIndex])tr.cells[scanIndex].textContent=number(rows[index]?.scanned_contacts||0)});
  }
  updateScannedCard(table);
  if(!table.__aigukaScanObserver){
    const observer=new MutationObserver(function(){updateScannedCard(table)});
    observer.observe(body,{subtree:true,attributes:true,attributeFilter:['style']});table.__aigukaScanObserver=observer;
  }
}
function updateScannedCard(table){
  const head=table.querySelector('thead tr');if(!head)return;const labels=[...head.cells].map(function(th){return th.textContent.trim()}),scanIndex=labels.indexOf('SĐT quét');if(scanIndex<0)return;
  let total=0;[...table.tBodies[0].rows].forEach(function(tr){if(tr.style.display==='none'||tr.querySelector('.empty'))return;const text=String(tr.cells[scanIndex]?.textContent||'').replace(/[^0-9-]/g,'');total+=Number(text||0)});
  const cards=document.getElementById('leadCards');if(!cards)return;let card=cards.querySelector('.aiguka_scanned_phone_card');
  if(!card){card=document.createElement('div');card.className='card aiguka_scanned_phone_card';card.innerHTML='<div class="cardLabel">SĐT quét</div><div class="cardNum">0</div><div class="cardHint">Lấy từ profile · tag Đã quét</div>';const all=[...cards.querySelectorAll('.card')],contactCard=all.find(function(item){return /Có SĐT\/Zalo/i.test(item.querySelector('.cardLabel')?.textContent||'')});if(contactCard&&contactCard.nextSibling)cards.insertBefore(card,contactCard.nextSibling);else cards.appendChild(card)}
  const numEl=card.querySelector('.cardNum');if(numEl)numEl.textContent=number(total);
}
// ${MARK}
`;
    source = source.replace(installAnchor, helpers + "\n" + installAnchor);
    source = source.replace(
      "if(view==='leads'){rewriteLeadSources(list);rewriteLeadCards(list,count)}if(view==='daily')labelOrganicDailyRows(list);return result",
      "if(view==='leads'){rewriteLeadSources(list);rewriteLeadCards(list,count)}if(view==='daily')labelOrganicDailyRows(list);if(view==='dashboard'||view==='daily')rewriteScannedContactMetric(list);return result",
    );
    if (!source.includes("rewriteScannedContactMetric(list)")) throw new Error("REPORT_SCAN_DASHBOARD_WRAP_FAILED");
    write(file, source);
  }
}

console.log("[AIGUKA V10] report patch active: canonical Meta conversations + Pancake scanned-phone contact metric");
