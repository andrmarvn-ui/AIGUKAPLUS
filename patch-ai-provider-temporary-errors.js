import fs from "node:fs";

const file = "ai-provider-manager.js";
const marker = "AIGUKA_PROVIDER_TEMPORARY_ERROR_RECOVERY_V1";

function replaceOrThrow(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`PROVIDER_MANAGER_RECOVERY_TARGET_MISSING:${label}`);
  return source.replace(before, after);
}

if (!fs.existsSync(file)) {
  throw new Error("AI_PROVIDER_MANAGER_MISSING");
}

let source = fs.readFileSync(file, "utf8");
if (!source.includes(marker)) {
  source = replaceOrThrow(
    source,
`      const settings = { ...(row.settings || {}), endpoint_style: smoke.endpoint_style, runtime_order: Math.max(1, Number(row.settings?.runtime_order || 100)), smoke_test: smoke };`,
`      const settings = {
        ...(row.settings || {}),
        endpoint_style: smoke.endpoint_style,
        runtime_order: Math.max(1, Number(row.settings?.runtime_order || 100)),
        smoke_test: smoke,
        cooldown_until: null,
        runtime_cooldown_until: null,
        runtime_state: "ready",
        runtime_error_class: null,
        runtime_auto_recover: true,
      };`,
    "success_clear_cooldown",
  );

  source = replaceOrThrow(
    source,
`      const settings = { ...(row.settings || {}), runtime_order: Math.max(1, Number(row.settings?.runtime_order || 100)), smoke_test: { ok: false, tested_at: testedAt, error: message } };
      const saved = await patchOne(row.provider_key, {
        connection_status: "error",
        last_checked_at: testedAt,
        last_error: message,
        available_models: models,
        settings,
        mode: "OFF",
        is_enabled: false,
        updated_at: testedAt,
      });
      const failure = new Error(message);
      failure.row = saved;
      throw failure;`,
`      const lower = message.toLowerCase();
      const temporary = /(?:http_429|rate limit|too many requests|quota|resource exhausted|capacity|timeout|temporar|overloaded|unavailable|network|fetch failed|http_408|http_424|http_499|http_500|http_502|http_503|http_504|payment required|insufficient balance|no credits remaining|add credits)/i.test(lower);
      const billing = /payment required|insufficient balance|no credits remaining|add credits/i.test(lower);
      const cooldownMs = billing ? 6 * 60 * 60_000 : /timeout|network|fetch failed|http_5\d\d/i.test(lower) ? 2 * 60_000 : 5 * 60_000;
      const cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
      const settings = {
        ...(row.settings || {}),
        runtime_order: Math.max(1, Number(row.settings?.runtime_order || 100)),
        smoke_test: { ok: false, tested_at: testedAt, error: message, temporary, cooldown_until: temporary ? cooldownUntil : null },
        cooldown_until: temporary ? cooldownUntil : null,
        runtime_cooldown_until: temporary ? cooldownUntil : null,
        runtime_state: temporary ? "cooldown" : "error",
        runtime_error_class: temporary ? (billing ? "no_credit" : "temporary") : "fatal",
        runtime_auto_recover: temporary,
      };
      const saved = await patchOne(row.provider_key, temporary ? {
        connection_status: "cooldown",
        last_checked_at: testedAt,
        last_error: message,
        available_models: models,
        settings,
        is_enabled: row.is_enabled === true || String(row.mode).toUpperCase() === "PRODUCTION",
        updated_at: testedAt,
      } : {
        connection_status: "error",
        last_checked_at: testedAt,
        last_error: message,
        available_models: models,
        settings,
        mode: "OFF",
        is_enabled: false,
        updated_at: testedAt,
      });
      const failure = new Error(message);
      failure.row = saved;
      throw failure;`,
    "temporary_failure_handling",
  );

  source += `\n// ${marker}\n`;
  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA] temporary provider failures now enter cooldown and auto-recover");
}
