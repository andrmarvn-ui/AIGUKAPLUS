import fs from "node:fs";

const file = "ai-provider-manager.js";
const marker = "AIGUKA_AI_PROVIDER_RESILIENCE_UI_V1";

function replaceOrThrow(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`PROVIDER_UI_RESILIENCE_TARGET_MISSING:${label}`);
  return source.replace(before, after);
}

if (!fs.existsSync(file)) {
  throw new Error("AI_PROVIDER_MANAGER_MISSING");
}

let source = fs.readFileSync(file, "utf8");
if (!source.includes(marker)) {
  source = replaceOrThrow(
    source,
    '.provider-summary{display:grid;grid-template-columns:minmax(180px,1fr) minmax(180px,1.1fr) auto 34px;',
    '.provider-summary{display:grid;grid-template-columns:minmax(150px,.85fr) minmax(160px,1fr) minmax(190px,1.1fr) auto 34px;',
    "summary_columns",
  );

  source = replaceOrThrow(
    source,
    '.provider-endpoint{font-size:13px;color:#475467;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.provider-endpoint b{font-size:11px;color:#98a2b3;margin-right:6px;text-transform:uppercase;letter-spacing:.02em}',
    '.provider-model,.provider-endpoint{font-size:13px;color:#475467;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.provider-model b,.provider-endpoint b{font-size:11px;color:#98a2b3;margin-right:6px;text-transform:uppercase;letter-spacing:.02em}',
    "model_style",
  );

  source = replaceOrThrow(
    source,
    '.provider-tab[data-state="test"]{color:#b54708}',
    '.provider-tab[data-state="test"]{color:#b54708}.provider-tab[data-state="cooldown"]{color:#175cd3}',
    "cooldown_tab",
  );

  source = replaceOrThrow(
    source,
    '.provider-section-head.test{color:#b54708}.provider-section-head.error{color:#b42318}',
    '.provider-section-head.test{color:#b54708}.provider-section-head.cooldown{color:#175cd3}.provider-section-head.error{color:#b42318}',
    "cooldown_section",
  );

  source = replaceOrThrow(
    source,
    '.provider-status.test{background:#fef0c7;color:#b54708}.provider-status.error{background:#fee4e2;color:#b42318}',
    '.provider-status.test{background:#fef0c7;color:#b54708}.provider-status.cooldown{background:#dbeafe;color:#175cd3}.provider-status.error{background:#fee4e2;color:#b42318}',
    "cooldown_status",
  );

  source = replaceOrThrow(
    source,
    '@media(max-width:980px){.provider-toolbar{grid-template-columns:1fr 1fr}.provider-tabs{grid-column:1/-1;justify-content:flex-start}.provider-summary{grid-template-columns:minmax(160px,1fr) minmax(160px,1fr) auto 34px}',
    '@media(max-width:980px){.provider-toolbar{grid-template-columns:1fr 1fr}.provider-tabs{grid-column:1/-1;justify-content:flex-start}.provider-summary{grid-template-columns:minmax(140px,.8fr) minmax(150px,1fr) minmax(170px,1fr) auto 34px}',
    "tablet_columns",
  );

  source = replaceOrThrow(
    source,
    '.provider-endpoint{grid-column:1/2;grid-row:2;font-size:12px}.provider-status{grid-column:2;grid-row:1/3}.provider-toggle{grid-column:3;grid-row:1/3}',
    '.provider-model{grid-column:1/2;grid-row:2;font-size:12px}.provider-endpoint{grid-column:1/2;grid-row:3;font-size:12px}.provider-status{grid-column:2;grid-row:1/4}.provider-toggle{grid-column:3;grid-row:1/4}',
    "mobile_rows",
  );

  source = replaceOrThrow(
    source,
    "const states={ready:{label:'Production Ready',icon:'✓'},test:{label:'Test',icon:'◷'},error:{label:'Error',icon:'!'},off:{label:'Off',icon:'○'}};",
    "const states={ready:{label:'Production Ready',icon:'✓'},cooldown:{label:'Cooldown',icon:'↻'},test:{label:'Test',icon:'◷'},error:{label:'Error',icon:'!'},off:{label:'Off',icon:'○'}};",
    "states",
  );

  source = replaceOrThrow(
    source,
    "function stateOf(x){if(x.production_ready)return'ready';if(x.connection_status==='error')return'error';if(String(x.mode||'').toUpperCase()==='TEST'||x.connection_status==='needs_test')return'test';return'off'}",
    "function stateOf(x){if(x.connection_status==='cooldown')return'cooldown';if(x.production_ready)return'ready';if(x.connection_status==='error')return'error';if(String(x.mode||'').toUpperCase()==='TEST'||x.connection_status==='needs_test')return'test';return'off'}",
    "state_of",
  );

  source = replaceOrThrow(
    source,
    "function counts(){const c={all:rows.length,ready:0,test:0,error:0,off:0};rows.forEach(x=>c[stateOf(x)]++);return c}",
    "function counts(){const c={all:rows.length,ready:0,cooldown:0,test:0,error:0,off:0};rows.forEach(x=>c[stateOf(x)]++);return c}",
    "counts",
  );

  source = replaceOrThrow(
    source,
    "<div class=\"provider-name\" title=\"'+safe(x.provider_name||x.provider_key)+'\">'+safe(x.provider_name||x.provider_key)+'</div><div class=\"provider-endpoint\"",
    "<div class=\"provider-name\" title=\"'+safe(x.provider_name||x.provider_key)+'\">'+safe(x.provider_name||x.provider_key)+'</div><div class=\"provider-model\" title=\"'+safe(x.model_name||'-')+'\"><b>Model</b>'+safe(x.model_name||'-')+'</div><div class=\"provider-endpoint\"",
    "model_summary",
  );

  source = replaceOrThrow(
    source,
    "const order={ready:0,test:1,error:2,off:3};",
    "const order={ready:0,cooldown:1,test:2,error:3,off:4};",
    "sort_order",
  );

  source = replaceOrThrow(
    source,
    "[['all','Tất cả'],['ready','Production Ready'],['test','Test'],['error','Error'],['off','Off']]",
    "[['all','Tất cả'],['ready','Production Ready'],['cooldown','Cooldown'],['test','Test'],['error','Error'],['off','Off']]",
    "tabs",
  );

  source = replaceOrThrow(
    source,
    "const groups=sortMode==='status'?['ready','test','error','off']:['all'];",
    "const groups=sortMode==='status'?['ready','cooldown','test','error','off']:['all'];",
    "groups",
  );

  source += `\n// ${marker}\n`;
  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA] compact provider UI now shows model and cooldown status");
}
