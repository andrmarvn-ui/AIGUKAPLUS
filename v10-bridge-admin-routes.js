import crypto from "node:crypto";
import express from "node:express";

const clean = (value) => String(value ?? "").trim();
const nowIso = () => new Date().toISOString();
const safeError = (error) => clean(error?.message || error?.error || error || "UNKNOWN_ERROR")
  .replace(/(?:sk-|AIza|hf_)[A-Za-z0-9_.-]+/g, "[redacted]")
  .slice(0, 900);

export function installV10BridgeAdminRoutes(app, options = {}) {
  const base = clean(process.env.AIGUKA_V9_CORE_URL || options.supabaseUrl || process.env.SUPABASE_URL).replace(/\/$/, "");
  const publicKey = clean(
    process.env.AIGUKA_V9_CORE_PUBLISHABLE_KEY
    || process.env.SUPABASE_PUBLISHABLE_KEY
    || process.env.SUPABASE_ANON_KEY
    || options.publishableKey,
  );
  const bridgeKey = clean(process.env.AIGUKA_V9_CORE_BRIDGE_KEY);
  const knowledgeBase = clean(process.env.AIGUKA_V9_KNOWLEDGE_URL || options.supabaseUrl || process.env.SUPABASE_URL).replace(/\/$/, "");
  const knowledgeKey = clean(
    process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY
    || process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  if (!base || !publicKey || !bridgeKey) {
    console.error("[AIGUKA V10 bridge admin] Core bridge configuration unavailable");
    return;
  }

  const json = express.json({ limit: "6mb" });
  app.use("/api/ai-providers", json);
  app.use("/learning-reviewed/api", json);
  app.use("/__aiguka/provider-migration", json);

  async function rpc(name, args = {}, timeoutMs = 45_000) {
    const response = await fetch(`${base}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: publicKey,
        authorization: `Bearer ${publicKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ p_bridge_key: bridgeKey, ...args }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; }
    catch { data = { raw: raw.slice(0, 800) }; }
    if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `BRIDGE_RPC_${response.status}:${name}`);
    return data;
  }

  const encryptionKey = knowledgeKey && knowledgeBase
    ? crypto.createHash("sha256").update(`${knowledgeKey}|${knowledgeBase}|AIGUKA_AI_PROVIDER_KEYS_V1`).digest()
    : null;

  function encryptProviderKey(value) {
    if (!encryptionKey) throw new Error("AI_PROVIDER_ENCRYPTION_KEY_UNAVAILABLE");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
  }

  function decryptProviderKey(value) {
    if (!encryptionKey) throw new Error("AI_PROVIDER_ENCRYPTION_KEY_UNAVAILABLE");
    const [iv, tag, encrypted] = String(value || "").split(".");
    if (!iv || !tag || !encrypted) throw new Error("AI_PROVIDER_KEY_FORMAT_INVALID");
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
  }

  function providerMode(row = {}) {
    const mode = clean(row?.settings?.mode).toUpperCase();
    if (["OFF", "TEST", "PRODUCTION"].includes(mode)) return mode;
    return row.is_enabled ? "PRODUCTION" : "TEST";
  }

  function publicProvider(row = {}) {
    const settings = row.settings && typeof row.settings === "object" ? row.settings : {};
    return {
      provider_key: row.provider_key,
      provider_name: row.provider_name,
      provider_type: row.provider_type || "openai_compatible",
      base_url: row.base_url || "",
      model_name: row.model_name || "",
      mode: providerMode(row),
      is_enabled: row.is_enabled === true,
      connection_status: row.connection_status || "unknown",
      last_checked_at: row.last_verified_at || null,
      last_success_at: settings.last_success_at || null,
      last_error: row.last_error || null,
      available_models: Array.isArray(settings.available_models) ? settings.available_models : (row.model_name ? [row.model_name] : []),
      settings,
      runtime_order: Math.max(1, Number(settings.runtime_order || 100)),
      endpoint_style: settings.endpoint_style || (row.provider_type === "gemini" ? "gemini_openai_chat" : "chat_completions"),
      smoke_test: settings.smoke_test || null,
      production_ready: row.connection_status === "production_ready" && settings.smoke_test?.ok === true,
      has_api_key: Boolean(row.api_key_ciphertext),
      api_key_hint: row.api_key_hint || "",
    };
  }

  async function getProvider(providerKey) {
    const result = await rpc("v10_bridge_ai_provider_get", { p_provider_key: providerKey });
    return result?.data || null;
  }

  async function patchProvider(providerKey, patch) {
    const result = await rpc("v10_bridge_ai_provider_patch", { p_provider_key: providerKey, p_patch: patch });
    return result?.data || null;
  }

  function providerTool() {
    return {
      type: "function",
      function: {
        name: "aiguka_provider_probe",
        description: "Return provider readiness",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { ok: { type: "boolean" }, reply: { type: "string" } },
          required: ["ok", "reply"],
        },
      },
    };
  }

  async function testProvider(row) {
    if (!row?.api_key_ciphertext) throw new Error("Chưa nhập API key");
    const apiKey = decryptProviderKey(row.api_key_ciphertext);
    const settings = row.settings || {};
    const baseUrl = clean(row.base_url).replace(/\/$/, "");
    const model = clean(row.model_name);
    if (!baseUrl || !model) throw new Error("BASE_URL_OR_MODEL_MISSING");
    const endpoint = row.provider_type === "gemini" || settings.endpoint_style === "gemini_openai_chat"
      ? `${/\/openai$/i.test(baseUrl) ? baseUrl : `${baseUrl}/openai`}/chat/completions`
      : `${baseUrl}/chat/completions`;
    const started = Date.now();
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...(settings.extra_headers || {}) },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "You are an API readiness probe. Call aiguka_provider_probe." },
            { role: "user", content: "Call the readiness function now with ok=true and reply='ready'." },
          ],
          tools: [providerTool()],
          tool_choice: "required",
          max_tokens: 220,
          stream: false,
        }),
        signal: AbortSignal.timeout(45_000),
      });
      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
      if (!response.ok || data?.error) throw new Error(data?.error?.message || data?.message || `PROVIDER_HTTP_${response.status}`);
      const calls = data?.choices?.[0]?.message?.tool_calls || [];
      if (!calls.some((item) => item?.function?.name === "aiguka_provider_probe")) throw new Error("TOOL_CALL_NOT_RETURNED");
      const checkedAt = nowIso();
      const nextSettings = {
        ...settings,
        last_success_at: checkedAt,
        smoke_test: { ok: true, tested_at: checkedAt, latency_ms: Date.now() - started, endpoint, model, tool_call: true },
      };
      return patchProvider(row.provider_key, {
        connection_status: "production_ready",
        last_verified_at: checkedAt,
        last_error: null,
        settings: nextSettings,
        is_enabled: providerMode(row) === "PRODUCTION",
        updated_at: checkedAt,
      });
    } catch (error) {
      const checkedAt = nowIso();
      const message = safeError(error);
      const temporary = /429|quota|rate|capacity|timeout|temporar|unavailable|overloaded|502|503|504|credits|balance/i.test(message);
      const saved = await patchProvider(row.provider_key, {
        connection_status: temporary ? "cooldown" : "error",
        last_verified_at: checkedAt,
        last_error: message,
        settings: { ...settings, smoke_test: { ok: false, tested_at: checkedAt, error: message, temporary } },
        is_enabled: temporary ? row.is_enabled === true : false,
        updated_at: checkedAt,
      });
      const failure = new Error(message);
      failure.row = saved;
      throw failure;
    }
  }

  app.get("/api/ai-providers", async (_req, res) => {
    try {
      const result = await rpc("v10_bridge_ai_provider_list");
      const data = (Array.isArray(result?.data) ? result.data : []).map(publicProvider)
        .sort((a, b) => a.runtime_order - b.runtime_order || String(a.provider_name).localeCompare(String(b.provider_name)));
      res.json({ ok: true, data, source: "v10_core_bridge" });
    } catch (error) { res.status(500).json({ ok: false, error: safeError(error) }); }
  });

  app.post("/api/ai-providers", async (req, res) => {
    try {
      const input = req.body || {};
      const providerKey = clean(input.provider_key).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      const providerName = clean(input.provider_name);
      if (!providerKey || !providerName) throw new Error("Thiếu mã hoặc tên nhà cung cấp");
      const existing = await getProvider(providerKey);
      const mode = ["OFF", "TEST", "PRODUCTION"].includes(clean(input.mode).toUpperCase()) ? clean(input.mode).toUpperCase() : providerMode(existing || {});
      const settings = {
        ...(existing?.settings || {}),
        ...(input.settings && typeof input.settings === "object" ? input.settings : {}),
        mode,
        runtime_order: Math.max(1, Number(input.runtime_order || existing?.settings?.runtime_order || 100)),
        endpoint_style: clean(input.endpoint_style || existing?.settings?.endpoint_style || "") || undefined,
      };
      const row = {
        provider_name: providerName,
        provider_type: clean(input.provider_type || existing?.provider_type || "openai_compatible"),
        base_url: clean(input.base_url || existing?.base_url || ""),
        model_name: clean(input.model_name || existing?.model_name || ""),
        is_enabled: mode === "PRODUCTION",
        connection_status: "configured",
        settings,
        last_error: null,
        updated_at: nowIso(),
        api_key_ciphertext: existing?.api_key_ciphertext || null,
        api_key_hint: existing?.api_key_hint || null,
      };
      if (clean(input.api_key)) {
        row.api_key_ciphertext = encryptProviderKey(clean(input.api_key));
        row.api_key_hint = `••••${clean(input.api_key).slice(-4)}`;
      }
      if (!row.api_key_ciphertext) throw new Error("Chưa nhập API key");
      const result = await rpc("v10_bridge_ai_provider_upsert", { p_provider_key: providerKey, p_row: row });
      res.json({ ok: true, created: !existing, data: publicProvider(result?.data || {}), source: "v10_core_bridge" });
    } catch (error) { res.status(422).json({ ok: false, error: safeError(error) }); }
  });

  app.post("/__aiguka/provider-migration", async (req, res) => {
    const expected = clean(process.env.AIGUKA_PROVIDER_MIGRATION_TOKEN);
    const supplied = clean(req.headers["x-aiguka-provider-migration"]);
    if (!expected || !supplied || expected.length !== supplied.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) {
      res.status(401).json({ ok: false, error: "MIGRATION_UNAUTHORIZED" });
      return;
    }
    try {
      const rows = Array.isArray(req.body?.providers) ? req.body.providers : [];
      let restored = 0;
      let kept = 0;
      let invalid = 0;
      for (const input of rows.slice(0, 100)) {
        const providerKey = clean(input?.provider_key).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
        const secret = clean(input?.api_key);
        if (!providerKey || !secret || !clean(input?.provider_name)) { invalid += 1; continue; }
        const existing = await getProvider(providerKey);
        if (existing?.api_key_ciphertext) { kept += 1; continue; }
        const settings = {
          ...(input.settings && typeof input.settings === "object" ? input.settings : {}),
          restored_from_legacy: true,
          restored_at: nowIso(),
          smoke_test: null,
          cooldown_until: null,
          runtime_cooldown_until: null,
          runtime_state: "configured",
          runtime_error_class: null,
        };
        const row = {
          provider_name: clean(input.provider_name),
          provider_type: clean(input.provider_type) || "openai_compatible",
          base_url: clean(input.base_url),
          model_name: clean(input.model_name),
          api_key_ciphertext: encryptProviderKey(secret),
          api_key_hint: clean(input.api_key_hint) || `••••${secret.slice(-4)}`,
          is_enabled: input.is_enabled === true,
          connection_status: "configured",
          settings,
          last_verified_at: null,
          last_error: null,
          updated_at: nowIso(),
        };
        await rpc("v10_bridge_ai_provider_upsert", { p_provider_key: providerKey, p_row: row });
        restored += 1;
      }
      console.log(`[AIGUKA provider migration intake] restored=${restored}, kept_existing=${kept}, invalid=${invalid}`);
      res.json({ ok: true, restored, kept_existing: kept, invalid });
    } catch (error) {
      res.status(500).json({ ok: false, error: safeError(error) });
    }
  });

  app.post("/api/ai-providers/:providerKey/test", async (req, res) => {
    try {
      const row = await getProvider(req.params.providerKey);
      if (!row) throw new Error("Không tìm thấy nhà cung cấp AI");
      const saved = await testProvider(row);
      res.json({ ok: true, data: publicProvider(saved), smoke_test: saved?.settings?.smoke_test || null });
    } catch (error) {
      res.status(422).json({ ok: false, error: safeError(error), data: error.row ? publicProvider(error.row) : null });
    }
  });

  app.delete("/api/ai-providers/:providerKey", async (req, res) => {
    try {
      await rpc("v10_bridge_ai_provider_delete", { p_provider_key: clean(req.params.providerKey) });
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ ok: false, error: safeError(error) }); }
  });

  app.get("/learning-reviewed/api/conversations", async (req, res) => {
    try {
      const result = await rpc("v10_bridge_learning_conversation_list", {
        p_search: clean(req.query.search) || null,
        p_limit: Math.min(500, Math.max(1, Number(req.query.limit || 50))),
        p_offset: Math.max(0, Number(req.query.offset || 0)),
      });
      res.json({ ok: true, ...(result || {}), data_source: "v10_core_bridge" });
    } catch (error) { res.status(500).json({ ok: false, error: safeError(error) }); }
  });

  app.get("/learning-reviewed/api/conversation", async (req, res) => {
    try {
      const pageId = clean(req.query.page_id);
      const senderId = clean(req.query.sender_id);
      if (!pageId || !senderId) throw new Error("PAGE_ID_AND_SENDER_ID_REQUIRED");
      const result = await rpc("v10_bridge_learning_conversation_detail", { p_page_id: pageId, p_sender_id: senderId });
      res.json({ ok: true, data: { ...(result || {}), page_id: pageId, sender_id: senderId, data_source: "v10_core_bridge" } });
    } catch (error) { res.status(500).json({ ok: false, error: safeError(error) }); }
  });

  app.get("/learning-reviewed/api/prompts", async (_req, res) => {
    try {
      const result = await rpc("v10_bridge_learning_prompts");
      res.json({ ok: true, groups: result?.groups || [], branches: result?.branches || [], source: result?.source || "v10_ai_documents" });
    } catch (error) { res.status(500).json({ ok: false, error: safeError(error) }); }
  });

  app.post("/learning-reviewed/api/prompts", async (req, res) => {
    try {
      const result = await rpc("v10_bridge_learning_prompt_save", { p_id: null, p_payload: req.body || {} });
      res.json({ ok: true, data: result?.data || null });
    } catch (error) { res.status(400).json({ ok: false, error: safeError(error) }); }
  });

  app.patch("/learning-reviewed/api/prompts", async (req, res) => {
    try {
      const id = clean(req.body?.id);
      if (!id) throw new Error("PROMPT_ID_REQUIRED");
      const result = await rpc("v10_bridge_learning_prompt_save", { p_id: id, p_payload: req.body || {} });
      res.json({ ok: true, data: result?.data || null });
    } catch (error) { res.status(400).json({ ok: false, error: safeError(error) }); }
  });

  app.delete("/learning-reviewed/api/prompts", async (req, res) => {
    try {
      const id = clean(req.query.id);
      if (!id) throw new Error("PROMPT_ID_REQUIRED");
      await rpc("v10_bridge_learning_prompt_delete", { p_id: id });
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ ok: false, error: safeError(error) }); }
  });

  app.post("/learning-reviewed/api/save", async (req, res) => {
    try {
      const result = await rpc("v10_bridge_learning_save_case", { p_payload: req.body || {} });
      res.json({ ok: true, data: result?.data || null, source: "v10_ai_documents" });
    } catch (error) { res.status(400).json({ ok: false, error: safeError(error) }); }
  });

  app.post("/learning-reviewed/api/sync", async (_req, res) => {
    res.json({
      ok: true,
      requested: false,
      data_source: "core_v10_live",
      message: "Core V10 nhận hội thoại trực tiếp từ webhook; không cần chạy đồng bộ V8 thủ công.",
    });
  });

  console.log("[AIGUKA V10 bridge admin] provider + learning routes installed");
}
