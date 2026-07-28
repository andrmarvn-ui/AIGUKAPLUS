import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "ai-dispatch-worker.js";
let source = fs.readFileSync(file, "utf8");
const marker = "profile_gender_preflight_v7";

if (source.includes(marker)) {
  console.log("[AIGUKA] AI profile gender preflight patch already installed");
} else {
  source = source.replace(
    'const WORKER_VERSION = "profile_preflight_v6_dynamic_follow_up_slide_recovery";',
    'const WORKER_VERSION = "profile_gender_preflight_v7";\nconst PROFILE_FRESH_MS = 24 * 60 * 60 * 1000;',
  );

  source = source.replace(
    'v8_customers?select=id,display_name,gender,gender_source,preferred_salutation,profile_sync_status&page_id=',
    'v8_customers?select=id,display_name,gender,gender_source,preferred_salutation,profile_sync_status,profile_synced_at,gender_synced_at&page_id=',
  );

  const oldEnsure = `async function ensureProfile(item) {
  let customer = await readCustomer(item.page_id, item.sender_id);
  const needsSync = !customer || placeholderName(customer.display_name)
    || ["deferred_on_demand", "error", "empty_profile"].includes(String(customer.profile_sync_status || ""));
  if (!needsSync) return { attempted: false, ready: true, customer };

  await rpc("v8_dispatch_single_customer_profile_sync", {
    p_page_id: item.page_id,
    p_sender_id: item.sender_id,
  });

  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(400);
    customer = await readCustomer(item.page_id, item.sender_id);
    if (customer && !placeholderName(customer.display_name)) break;
  }
  return { attempted: true, ready: Boolean(customer && !placeholderName(customer.display_name)), customer };
}`;

  const newEnsure = `function hasKnownGender(customer) {
  return /^(male|nam|man|female|nữ|nu|woman)$/i.test(String(customer?.gender || "").trim());
}

function hasFreshProfileCheck(customer) {
  const syncedAt = Date.parse(String(customer?.profile_synced_at || ""));
  if (!Number.isFinite(syncedAt)) return false;
  if (Date.now() - syncedAt > PROFILE_FRESH_MS) return false;
  return !["deferred_on_demand", "error", "empty_profile"].includes(String(customer?.profile_sync_status || ""));
}

async function ensureProfile(item) {
  let customer = await readCustomer(item.page_id, item.sender_id);
  const previousProfileSyncedAt = customer?.profile_synced_at || null;
  const needsSync = !customer
    || placeholderName(customer.display_name)
    || !hasFreshProfileCheck(customer)
    || ["deferred_on_demand", "error", "empty_profile"].includes(String(customer.profile_sync_status || ""));

  if (!needsSync) {
    return {
      attempted: false,
      checked: true,
      ready: true,
      genderKnown: hasKnownGender(customer),
      customer,
    };
  }

  await rpc("v8_dispatch_single_customer_profile_sync", {
    p_page_id: item.page_id,
    p_sender_id: item.sender_id,
  });

  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(400);
    customer = await readCustomer(item.page_id, item.sender_id);
    const profileUpdated = Boolean(
      customer?.profile_synced_at
      && customer.profile_synced_at !== previousProfileSyncedAt,
    );
    if (profileUpdated || hasKnownGender(customer)) break;
  }

  return {
    attempted: true,
    checked: hasFreshProfileCheck(customer),
    ready: Boolean(customer && !placeholderName(customer.display_name)),
    genderKnown: hasKnownGender(customer),
    customer,
  };
}`;

  if (!source.includes(oldEnsure)) {
    throw new Error("AI_PROFILE_PREFLIGHT_ENSURE_ANCHOR_NOT_FOUND");
  }
  source = source.replace(oldEnsure, newEnsure);

  source = source.replace(
    "tên mơ hồ dùng bạn/câu trung tính, tuyệt đối không dùng anh/chị",
    "tên mơ hồ dùng mình hoặc lược đại từ; tuyệt đối không dùng bạn và không dùng anh/chị",
  );

  source = source.replace(
    "profile_sync_attempted: profile.attempted,\n        profile_ready: profile.ready,",
    "profile_sync_attempted: profile.attempted,\n        profile_checked: profile.checked,\n        profile_ready: profile.ready,\n        profile_gender_known: profile.genderKnown,",
  );

  source = source.replace(
    "gender: profile.customer?.gender || null,\n        preferred_salutation: profile.customer?.preferred_salutation || null,",
    "gender: profile.customer?.gender || null,\n        gender_source: profile.customer?.gender_source || null,\n        profile_sync_status: profile.customer?.profile_sync_status || null,\n        profile_synced_at: profile.customer?.profile_synced_at || null,\n        preferred_salutation: profile.customer?.preferred_salutation || null,",
  );

  source = `${source}\n// ${marker}\n`;
  fs.writeFileSync(file, source, "utf8");

  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) {
    throw new Error(`AI_PROFILE_PREFLIGHT_SYNTAX:${syntax.stderr || syntax.stdout}`);
  }
  console.log("[AIGUKA] Fresh customer profile and gender preflight installed");
}
