import fs from "node:fs";

const RELEASE = "AIGUKA_V9_LIVE_RELEASE_V3";

function requireToken(file, token, label) {
  const source = fs.readFileSync(file, "utf8");
  if (!source.includes(token)) throw new Error(`${label}_NOT_INSTALLED`);
  return source;
}

async function installLiveRelease() {
  // Apply the customer-facing worker release first. Dashboard UI hotfixes must never
  // be able to block Core ingestion, image understanding or Messenger delivery.
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

  await import("./v9-support-release-patch.js");
  await import("./v9-support-fast-vision-release-patch.js");
  await import("./v9-support-sample-ai-release-patch.js");
  await import("./v9-media-authority-release-patch.js");

  requireToken(aiTargetFile, "AIGUKA_V9_SUPPORT_FAST_VISION_V1", "V9_SUPPORT_FAST_VISION");
  requireToken(aiTargetFile, "AIGUKA_V9_SUPPORT_SAMPLE_AI_V1", "V9_SUPPORT_SAMPLE_AI");
  requireToken(aiTargetFile, "AIGUKA_V9_MEDIA_AUTHORITY_V1", "V9_AI_MEDIA_AUTHORITY");
  requireToken(directFile, "AIGUKA_V9_SUPPORT_SAMPLE_AI_V1", "V9_SUPPORT_REFERRAL_CARRY");
  requireToken(outboundFile, "AIGUKA_V9_SUPPORT_FAST_VISION_V1", "V9_OUTBOUND_IMAGE_PERMISSION");
  requireToken(outboundFile, "AIGUKA_V9_MEDIA_AUTHORITY_V1", "V9_OUTBOUND_MEDIA_AUTHORITY");

  await import("./v8-v9-mode-sync-worker.js");

  // Reporting UI is independent and best-effort. A stale HTML anchor must not leave
  // Railway healthy while silently running the old customer workers.
  try {
    await import("./patch-dashboard-ui-filter-metrics.js");
  } catch (error) {
    console.error(`[AIGUKA V9] dashboard hotfix skipped after live release: ${error instanceof Error ? error.message : String(error)}`);
  }

  globalThis.__AIGUKA_V9_LIVE_RELEASE__ = RELEASE;
  console.log(`[AIGUKA V9] ${RELEASE} installed: SUPPORT sample AI, fast vision, V8→V9 mode sync and authoritative media delivery`);
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
