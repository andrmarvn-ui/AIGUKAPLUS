import fs from "node:fs";
import { spawnSync } from "node:child_process";

const RELEASE = "AIGUKA_V9_LIVE_RELEASE_V8_VERIFIED_FEATURES";

function requireToken(file, token, label) {
  const source = fs.readFileSync(file, "utf8");
  if (!source.includes(token)) throw new Error(`${label}_NOT_INSTALLED`);
  return source;
}

function requireSyntax(file, label) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${label}_SYNTAX_INVALID:${result.stderr || result.stdout}`);
  }
}

async function applyStage(stage, path) {
  const startedAt = Date.now();
  console.log(`[AIGUKA V9 release] START ${stage} ${path}`);
  try {
    await import(path);
    console.log(`[AIGUKA V9 release] OK ${stage} ${Date.now() - startedAt}ms`);
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    throw new Error(`V9_RELEASE_STAGE_FAILED:${stage}:${message}`);
  }
}

async function installLiveRelease() {
  console.log(`[AIGUKA V9 release] BEGIN ${RELEASE} commit=${process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || "unknown"}`);

  const directFile = "v9-direct-core-worker.js";
  let directSource = fs.readFileSync(directFile, "utf8");

  const oldGate = 'if (mode !== "SHADOW") throw new Error(`V9_MODE_NOT_ALLOWED_FOR_DIRECT_CORE_RELEASE:${mode}`);';
  const newGate = 'if (!["SHADOW", "ACTIVE"].includes(mode)) throw new Error(`V9_MODE_NOT_ALLOWED_FOR_DIRECT_CORE_RELEASE:${mode}`);';

  if (!directSource.includes(newGate)) {
    if (!directSource.includes(oldGate)) throw new Error("V9_DIRECT_CORE_MODE_GATE_ANCHOR_NOT_FOUND");
    directSource = directSource.replace(oldGate, newGate);
  }

  directSource = directSource.replace('outbound_enabled: false,', 'outbound_enabled: mode === "ACTIVE",');
  directSource = directSource.replace('[AIGUKA V9 direct Core] started; legacy reads=0; outbound locked', '[AIGUKA V9 direct Core] started; legacy reads=0; ACTIVE handoff supported');
  fs.writeFileSync(directFile, directSource);
  requireToken(directFile, newGate, "V9_DIRECT_CORE_ACTIVE_GATE");

  const aiLiveFile = "v9-ai-live-worker.js";
  const aiTargetFile = "v9-ai-shadow-worker.js";
  if (!fs.existsSync(aiLiveFile)) throw new Error("V9_AI_LIVE_WORKER_NOT_FOUND");
  fs.writeFileSync(aiTargetFile, fs.readFileSync(aiLiveFile, "utf8"));

  const outboundFile = "v9-live-outbound-worker.js";
  let outboundSource = fs.readFileSync(outboundFile, "utf8");
  outboundSource = outboundSource.replace('body: { status: assets.length ? "text_sent" : "sent", updated_at: new Date().toISOString() }', 'body: { status: "sent", updated_at: new Date().toISOString() }');
  fs.writeFileSync(outboundFile, outboundSource);

  const stages = [
    ["support-base", "./v9-support-release-patch.js"],
    ["support-vision", "./v9-support-fast-vision-release-patch.js"],
    ["support-sample", "./v9-support-sample-ai-release-patch.js"],
    ["media-authority", "./v9-media-authority-release-patch.js"],
    ["large-slide", "./v9-support-large-slide-release-patch.js"],
    ["root-conversation", "./v9-root-conversation-architecture-release-patch.js"],
    ["no-drop", "./v9-no-drop-release-patch.js"],
    ["multi-product-plan", "./v9-semantic-product-lock-release-patch.js"],
  ];
  for (const [stage, path] of stages) await applyStage(stage, path);

  // Every stage above already validates its own anchors and generated syntax. The final
  // gate must only verify durable production outcomes, never transient helper names that
  // a later stage can legitimately rewrite. This prevents false post-healthcheck exits.
  requireToken(aiTargetFile, 'const VERSION = "v9_ai_multi_product_plan_v13";', "V9_AI_FINAL_VERSION");
  requireToken(aiTargetFile, "enforceSemanticProductLock", "V9_AI_SEMANTIC_LOCK");
  requireToken(aiTargetFile, "semanticDeterministicDecision", "V9_AI_MULTI_PRODUCT_POLICY");

  requireToken(directFile, 'const VERSION = "v9_direct_multi_product_plan_v5";', "V9_DIRECT_FINAL_VERSION");
  requireToken(directFile, 'semantic-conversation-intelligence-v2.js', "V9_DIRECT_MULTI_PRODUCT_BUILDER");
  requireToken("v9/core/semantic-conversation-intelligence-v2.js", "requestPlan", "V9_MULTI_PRODUCT_CONVERSATION_CORE");
  requireToken("v9/core/semantic-decision-policy.js", "multi_product_plan_restored", "V9_MULTI_PRODUCT_DECISION_POLICY");
  requireToken("v9/core/semantic-decision-policy.js", "GEMINI_FREE_COOLDOWN_ACTIVE", "V9_GEMINI_FREE_CIRCUIT_BREAKER");

  requireToken(outboundFile, 'const VERSION = "v9_live_outbound_no_drop_v5";', "V9_OUTBOUND_FINAL_VERSION");
  requireToken(outboundFile, "selectAuthoritativeMedia", "V9_OUTBOUND_MEDIA_AUTHORITY");
  requireToken(outboundFile, "latestCustomerAt", "V9_OUTBOUND_FRESH_PAGE_GATE");
  requireToken(outboundFile, "truthfulTextFallback", "V9_OUTBOUND_TEXT_FALLBACK");
  requireToken("v9/core/media-authority.js", "const MAX_MEDIA_ASSETS = 30", "V9_MEDIA_LIMIT_30");

  requireSyntax(aiTargetFile, "V9_AI_FINAL");
  requireSyntax(directFile, "V9_DIRECT_FINAL");
  requireSyntax(outboundFile, "V9_OUTBOUND_FINAL");

  await applyStage("mode-sync", "./v8-v9-mode-sync-worker.js");

  try {
    await applyStage("dashboard-best-effort", "./patch-dashboard-ui-filter-metrics.js");
  } catch (error) {
    console.error(`[AIGUKA V9] dashboard hotfix skipped after live release: ${error instanceof Error ? error.message : String(error)}`);
  }

  globalThis.__AIGUKA_V9_LIVE_RELEASE__ = RELEASE;
  console.log(`[AIGUKA V9] ${RELEASE} installed: complete requestPlan, no-drop delivery, balanced catalogs and Gemini Free pacing`);
}

try {
  await installLiveRelease();
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[AIGUKA V9] ${RELEASE} failed; refusing to start Railway with stale workers: ${message}`);
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
  throw error;
}
