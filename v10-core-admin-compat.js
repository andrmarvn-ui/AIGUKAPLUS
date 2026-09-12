import crypto from "node:crypto";

const clean = (value) => String(value ?? "").trim();
const nowIso = () => new Date().toISOString();
const clamp = (value, max = 300000) => String(value ?? "").slice(0, max);
const safeError = (error) => clean(error?.message || error?.error || error || "UNKNOWN_ERROR")
  .replace(/(?:sk-|AIza|hf_)[A-Za-z0-9_\-.]+/g, "[redacted]")
  .slice(0, 900);

export function installV10CoreAdminCompat(app, options = {}) {
  const base = clean(
    process.env.AIGUKA_V9_KNOWLEDGE_URL
    || process.env.AIGUKA_V9_REPORTING_URL
    || options.supabaseUrl
    || process.env.SUPABASE_URL,
  ).replace(/\/$/, "");
  const key = clean(
    process.env.AIGUKA_V9_KNOWLEDGE_SERVICE_ROLE_KEY
    || process.env.AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
  if (!base || !key) {
    console.error("[AIGUKA V10 admin compat] server service-role connection unavailable");
    return;
  }

  const headers = (prefer = "return=representation") => ({
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    Prefer: prefer,
  });

  async function body(req) {
    if (req.body && typeof req.body === "object") return req.body;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (!raw) return {};
    try { return JSON.parse(raw); }
    catch { throw new Error("INVALID_JSON_BODY"); }
  }

  async function rest(path, options = {}) {
    const response = await fetch(`${base}/rest/v1/${path}`, {
      method: options.method || "GET",
      headers: headers(options.prefer || "return=representation"),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeout || 45_000),
      cache: "no-store",
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; }
    catch { data = { raw: raw.slice(0, 800) }; }
    if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `REST_HTTP_${response.status}`);
    return data;
  }

  const rpc = (name, args = {}, timeout = 45_000) => rest(`rpc/${name}`, {
    method: "POST",
    body: args,
    timeout,
  });

  const encryptionKey = crypto.createHash("sha256")
    .update(`${key}|${base}|AIGUKA_AI_PROVIDER_KEYS_V1`)
    .digest();

  function encryptProviderKey(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
  }

  function decryptProviderKey(value) {
    const [iv, tag, encrypted] = String(value || "").split(".");
    if (!iv || !tag || !encrypted) throw new Error("AI_PROVIDER_KEY_FORMAT_INVALID");
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
  }

  function providerMode(row = {}) {
    const configured = clean(row?.settings?.mode).toUpperCase();
    if (["OFF", "TEST", "PRODUCTION"].includes(configured)) return configured;
    return row.is_enabled ? "PRODUCTION" : "TEST";
  }

  function publicProvider(row = {}) {
    const settings = row.settings && typeof row.settings === "object" ? row.settings : {};
    const availableModels = Array.isArray(settings.available_models)
      ? settings.available_models
      : (row.model_name ? [row.model_name] : []);
    const smoke = settings.smoke_test || null;
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
      available_models: availableModels,
      settings,
      runtime_order: Math.max(1, Number(settings.runtime_order || 100)),
      endpoint_style: settings.endpoint_style || (row.provider_type === "gemini" ? "gemini_openai_chat" : "chat_completions"),
      smoke_test: smoke,
      production_ready: row.connection_status === "production_ready" && smoke?.ok === true,
      has_api_key: Boolean(row.api_key_ciphertext),
      api_key_hint: row.api_key_hint || "",
    };
  }

  async function providerRow(providerKey) {
    const rows = await rest(`ai_providers?provider_key=eq.${encodeURIComponent(providerKey)}&select=*&limit=1`);
    return rows?.[0] || null;
  }

  async function patchProvider(providerKey, patch) {
    const rows = await rest(`ai_providers?provider_key=eq.${encodeURIComponent(providerKey)}`, {
      method: "PATCH",
      body: patch,
    });
    return rows?.[0] || null;
  }

  async function bootstrapEnvProviders() {
    const existing = await rest("ai_providers?select=provider_key").catch(() => []);
    const seen = new Set((existing || []).map((row) => String(row.provider_key)));
    const specs = [
      { provider_key: "gemini", provider_name: "Gemini", provider_type: "gemini", keyEnv: "GEMINI_API_KEY", baseEnv: "GEMINI_BASE_URL", modelEnv: "GEMINI_MODEL", defaultBase: "https://generativelanguage.googleapis.com/v1beta", order: 10 },
      { provider_key: "deepseek", provider_name: "DeepSeek", provider_type: "openai_compatible", keyEnv: "DEEPSEEK_API_KEY", baseEnv: "DEEPSEEK_BASE_URL", modelEnv: "DEEPSEEK_MODEL", defaultBase: "https://api.deepseek.com", order: 30 },
      { provider_key: "openai", provider_name: "OpenAI", provider_type: "openai_compatible", keyEnv: "OPENAI_API_KEY", baseEnv: "OPENAI_BASE_URL", modelEnv: "OPENAI_MODEL", defaultBase: "https://api.openai.com/v1", order: 90 },
      { provider_key: "tokenrouter", provider_name: "TokenRouter", provider_type: "openai_compatible", keyEnv: "TOKENROUTER_API_KEY", baseEnv: "TOKENROUTER_BASE_URL", modelEnv: "TOKENROUTER_MODEL", defaultBase: "https://api.tokenrouter.com/v1", order: 40 },
      { provider_key: "huggingface", provider_name: "Hugging Face", provider_type: "huggingface", keyEnv: "HUGGINGFACE_ROUTER_API_KEY", baseEnv: "HUGGINGFACE_ROUTER_BASE_URL", modelEnv: "HUGGINGFACE_ROUTER_MODEL", defaultBase: "https://router.huggingface.co/v1", order: 50 },
      { provider_key: "cerebras", provider_name: "Cerebras", provider_type: "cerebras", keyEnv: "CEREBRAS_API_KEY", baseEnv: "CEREBRAS_BASE_URL", modelEnv: "CEREBRAS_MODEL", defaultBase: "https://api.cerebras.ai/v1", order: 55 },
      { provider_key: "mistral", provider_name: "Mistral", provider_type: "mistral", keyEnv: "MISTRAL_API_KEY", baseEnv: "MISTRAL_BASE_URL", modelEnv: "MISTRAL_MODEL", defaultBase: "https://api.mistral.ai/v1", order: 60 },
      { provider_key: "together", provider_name: "Together AI", provider_type: "together", keyEnv: "TOGETHER_API_KEY", baseEnv: "TOGETHER_BASE_URL", modelEnv: "TOGETHER_MODEL", defaultBase: "https://api.together.xyz/v1", order: 65 },
      { provider_key: "sambanova", provider_name: "SambaNova", provider_type: "sambanova", keyEnv: "SAMBANOVA_API_KEY", baseEnv: "SAMBANOVA_BASE_URL", modelEnv: "SAMBANOVA_MODEL", defaultBase: "https://api.sambanova.ai/v1", order: 70 },
      { provider_key: "cohere", provider_name: "Cohere", provider_type: "openai_compatible", keyEnv: "COHERE_API_KEY", baseEnv: "COHERE_BASE_URL", modelEnv: "COHERE_MODEL", defaultBase: "https://api.cohere.ai/v2", order: 75 },
      { provider_key: "groq", provider_name: "Groq", provider_type: "openai_compatible", keyEnv: "GROQ_API_KEY", baseEnv: "GROQ_BASE_URL", modelEnv: "GROQ_MODEL", defaultBase: "https://api.groq.com/openai/v1", order: 80 },
    ];
    for (const spec of specs) {
      if (seen.has(spec.provider_key)) continue;
      const secret = clean(process.env[spec.keyEnv]);
      const model = clean(process.env[spec.modelEnv]);
      if (!secret || !model) continue;
      const baseUrl = clean(process.env[spec.baseEnv]) || spec.defaultBase;
      await rest("ai_providers", {
        method: "POST",
        body: {
          provider_key: spec.provider_key,
          provider_name: spec.provider_name,
          provider_type: spec.provider_type,
          base_url: baseUrl,
          model_name: model,
          api_key_ciphertext: encryptProviderKey(secret),
          api_key_hint: `••••${secret.slice(-4)}`,
          is_enabled: true,
          connection_status: "configured",
          settings: {
            mode: "PRODUCTION",
            runtime_order: spec.order,
            endpoint_style: spec.provider_type === "gemini" ? "gemini_openai_chat" : "chat_completions",
            bootstrap_source: "railway_env_v10",
          },
          last_error: null,
          updated_at: nowIso(),
        },
      });
      seen.add(spec.provider_key);
    }
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

  async function providerFetch(row, apiKey, messages, useTool = false) {
    const baseUrl = clean(row.base_url).replace(/\/$/, "");
    const model = clean(row.model_name);
    if (!baseUrl || !model) throw new Error("BASE_URL_OR_MODEL_MISSING");
    const settings = row.settings || {};
    let endpoint = `${baseUrl}/chat/completions`;
    if (row.provider_type === "gemini" || settings.endpoint_style === "gemini_openai_chat") {
      endpoint = `${/\/openai$/i.test(baseUrl) ? baseUrl : `${baseUrl}/openai`}/chat/completions`;
    }
    const payload = {
      model,
      messages,
      max_tokens: 300,
      stream: false,
      ...(useTool ? { tools: [providerTool()], tool_choice: "required" } : {}),
    };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...(settings.extra_headers || {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45_000),
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw: raw.slice(0, 600) }; }
    if (!response.ok || data?.error) throw new Error(data?.error?.message || data?.message || `PROVIDER_HTTP_${response.status}`);
    return { data, endpoint };
  }

  async function verifyProvider(row) {
    const apiKey = decryptProviderKey(row.api_key_ciphertext);
    const started = Date.now();
    try {
      const { data, endpoint } = await providerFetch(row, apiKey, [
        { role: "system", content: "You are an API readiness probe. Call aiguka_provider_probe." },
        { role: "user", content: "Call the readiness function now with ok=true and reply='ready'." },
      ], true);
      const calls = data?.choices?.[0]?.message?.tool_calls || [];
      if (!calls.some((item) => item?.function?.name === "aiguka_provider_probe")) throw new Error("TOOL_CALL_NOT_RETURNED");
      const checkedAt = nowIso();
      const settings = {
        ...(row.settings || {}),
        mode: providerMode(row),
        last_success_at: checkedAt,
        smoke_test: { ok: true, tested_at: checkedAt, latency_ms: Date.now() - started, endpoint, model: row.model_name, tool_call: true },
      };
      const saved = await patchProvider(row.provider_key, {
        connection_status: "production_ready",
        last_verified_at: checkedAt,
        last_error: null,
        settings,
        is_enabled: providerMode(row) === "PRODUCTION",
        updated_at: checkedAt,
      });
      return saved;
    } catch (error) {
      const checkedAt = nowIso();
      const message = safeError(error);
      const temporary = /429|quota|rate|capacity|timeout|temporar|unavailable|overloaded|502|503|504|credits|balance/i.test(message);
      const settings = {
        ...(row.settings || {}),
        smoke_test: { ok: false, tested_at: checkedAt, error: message, temporary },
      };
      const saved = await patchProvider(row.provider_key, {
        connection_status: temporary ? "cooldown" : "error",
        last_verified_at: checkedAt,
        last_error: message,
        settings,
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
      await bootstrapEnvProviders();
      const rows = await rest("ai_providers?select=*&order=updated_at.desc");
      const data = (rows || []).map(publicProvider).sort((a, b) => a.runtime_order - b.runtime_order || String(a.provider_name).localeCompare(String(b.provider_name)));
      res.json({ ok: true, data, source: "v10_ai_providers" });
    } catch (error) { res.status(500).json({ ok: false, error: safeError(error) }); }
  });

  app.post("/api/ai-providers", async (req, res) => {
    try {
      const input = await body(req);
      const providerKey = clean(input.provider_key).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      const providerName = clean(input.provider_name);
      if (!providerKey || !providerName) throw new Error("Thiếu mã hoặc tên nhà cung cấp");
      const existing = await providerRow(providerKey);
      const mode = ["OFF", "TEST", "PRODUCTION"].includes(clean(input.mode).toUpperCase()) ? clean(input.mode).toUpperCase() : providerMode(existing || {});
      const settings = {
        ...(existing?.settings || {}),
        ...(input.settings && typeof input.settings === "object" ? input.settings : {}),
        mode,
        runtime_order: Math.max(1, Number(input.runtime_order || existing?.settings?.runtime_order || 100)),
        endpoint_style: clean(input.endpoint_style || existing?.settings?.endpoint_style || "") || undefined,
      };
      const patch = {
        provider_name: providerName,
        provider_type: clean(input.provider_type || existing?.provider_type || "openai_compatible"),
        base_url: clean(input.base_url || existing?.base_url || ""),
        model_name: clean(input.model_name || existing?.model_name || ""),
        is_enabled: mode === "PRODUCTION",
        connection_status: "configured",
        settings,
        last_error: null,
        updated_at: nowIso(),
      };
      if (clean(input.api_key)) {
        patch.api_key_ciphertext = encryptProviderKey(clean(input.api_key));
        patch.api_key_hint = `••••${clean(input.api_key).slice(-4)}`;
      }
      let saved;
      if (existing) saved = await patchProvider(providerKey, patch);
      else {
        if (!patch.api_key_ciphertext) throw new Error("Chưa nhập API key");
        saved = (await rest("ai_providers", { method: "POST", body: { provider_key: providerKey, ...patch } }))?.[0];
      }
      if (!saved?.api_key_ciphertext) throw new Error("Chưa nhập API key");
      res.json({ ok: true, created: !existing, data: publicProvider(saved), source: "v10_ai_providers" });
    } catch (error) { res.status(422).json({ ok: false, error: safeError(error) }); }
  });

  app.post("/api/ai-providers/:providerKey/test", async (req, res) => {
    try {
      const row = await providerRow(req.params.providerKey);
      if (!row?.api_key_ciphertext) throw new Error("Chưa nhập API key");
      const saved = await verifyProvider(row);
      res.json({ ok: true, data: publicProvider(saved), smoke_test: saved?.settings?.smoke_test || null });
    } catch (error) {
      res.status(422).json({ ok: false, error: safeError(error), data: error.row ? publicProvider(error.row) : null });
    }
  });

  app.delete("/api/ai-providers/:providerKey", async (req, res) => {
    try {
      await rest(`ai_providers?provider_key=eq.${encodeURIComponent(req.params.providerKey)}`, { method: "DELETE", prefer: "return=minimal" });
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ ok: false, error: safeError(error) }); }
  });

  function contextFromDocument(row = {}) {
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const usageMode = clean(metadata.usage_mode || (row.status === "published" ? "PRODUCTION" : row.status === "archived" ? "OFF" : "TEST")).toUpperCase();
    return {
      id: row.id,
      context_key: row.document_key,
      context_name: row.title,
      page_id: row.page_id || null,
      source_type: metadata.source_type || row.document_type || "manual",
      content: row.content || "",
      usage_mode: ["OFF", "TEST", "PRODUCTION"].includes(usageMode) ? usageMode : "TEST",
      priority: Number(row.priority || 100),
      is_active: row.status !== "archived",
      current_version: Number(row.version_no || 1),
      metadata,
      created_at: row.created_at,
      updated_at: row.created_at,
    };
  }

  async function allDocuments() {
    return rest("ai_documents?select=*&order=created_at.desc&limit=2000");
  }

  function latestDocuments(rows = []) {
    const byKey = new Map();
    for (const row of rows) {
      const key = String(row.document_key || "");
      if (!key) continue;
      const current = byKey.get(key);
      if (!current || Number(row.version_no || 0) > Number(current.version_no || 0)) byKey.set(key, row);
    }
    return [...byKey.values()];
  }

  async function buildSnapshot() {
    const rows = await allDocuments();
    const published = latestDocuments(rows).filter((row) => row.status === "published");
    const oldRows = await rest("ai_published_snapshots?select=content,version_no&status=eq.published&order=version_no.desc&limit=1").catch(() => []);
    const oldContent = oldRows?.[0]?.content && typeof oldRows[0].content === "object" ? oldRows[0].content : {};
    const documents = published.map((row) => ({
      document_key: row.document_key,
      version_no: row.version_no,
      document_type: row.document_type,
      page_id: row.page_id,
      title: row.title,
      content: row.content,
      priority: row.priority,
      metadata: row.metadata || {},
    }));
    const content = { ...oldContent, documents };
    const checksum = crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex");
    const versionNo = Math.max(0, Number(oldRows?.[0]?.version_no || 0)) + 1;
    const sourceVersions = Object.fromEntries(documents.map((row) => [row.document_key, row.version_no]));
    const inserted = await rest("ai_published_snapshots", {
      method: "POST",
      body: { version_no: versionNo, checksum, content, status: "published", source_versions: sourceVersions, created_by: "v10_context_admin" },
    });
    const snapshot = inserted?.[0];
    if (snapshot?.id) {
      await rest("ai_runtime_config?id=eq.1", {
        method: "PATCH",
        body: { published_snapshot_id: snapshot.id, updated_at: nowIso() },
      });
    }
    return snapshot || null;
  }

  async function getDocumentById(id) {
    const rows = await rest(`ai_documents?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
    if (!rows?.[0]) throw new Error("Không tìm thấy ngữ cảnh");
    return rows[0];
  }

  async function saveContext(input = {}, actor = "v10_context_admin") {
    const name = clean(input.context_name || input.title);
    if (!name) throw new Error("Cần nhập tên ngữ cảnh");
    const usage = clean(input.usage_mode || "TEST").toUpperCase();
    if (!["OFF", "TEST", "PRODUCTION"].includes(usage)) throw new Error("Chế độ không hợp lệ");
    let old = null;
    if (clean(input.id)) old = await getDocumentById(clean(input.id));
    const documentKey = clean(input.context_key || old?.document_key) || `context_${crypto.randomBytes(8).toString("hex")}`;
    const rows = await rest(`ai_documents?document_key=eq.${encodeURIComponent(documentKey)}&select=version_no&order=version_no.desc&limit=1`);
    const versionNo = Math.max(0, Number(rows?.[0]?.version_no || 0)) + 1;
    const metadata = {
      ...(old?.metadata || {}),
      ...(input.metadata && typeof input.metadata === "object" ? input.metadata : {}),
      usage_mode: usage,
      source_type: clean(input.source_type || old?.metadata?.source_type || "manual"),
      change_note: clamp(input.change_note, 1000) || null,
    };
    const status = usage === "PRODUCTION" ? "published" : usage === "OFF" ? "archived" : "draft";
    const inserted = await rest("ai_documents", {
      method: "POST",
      body: {
        document_key: documentKey,
        version_no: versionNo,
        document_type: "context",
        page_id: clean(input.page_id || old?.page_id) || null,
        title: name,
        content: clamp(input.content ?? old?.content ?? ""),
        status,
        priority: Math.min(9999, Math.max(0, Number(input.priority ?? old?.priority ?? 100))),
        metadata,
        created_by: actor,
      },
    });
    if (usage === "PRODUCTION" || old?.status === "published") await buildSnapshot();
    return contextFromDocument(inserted?.[0] || {});
  }

  async function contextBundle() {
    const [documents, pages, providers] = await Promise.all([
      allDocuments(),
      rest("v9_pages?select=page_id,page_name,is_active&is_active=eq.true&order=page_name.asc"),
      rest("ai_providers?select=*&order=updated_at.desc"),
    ]);
    const latest = latestDocuments(documents).map(contextFromDocument).sort((a, b) => a.priority - b.priority || String(a.context_name).localeCompare(String(b.context_name)));
    const versions = (documents || []).map(contextFromDocument).sort((a, b) => Number(b.current_version) - Number(a.current_version));
    return { contexts: latest, versions, pages: pages || [], providers: (providers || []).map(publicProvider), test_logs: [] };
  }

  app.get("/api/ai-contexts", async (_req, res) => {
    try { res.json({ ok: true, ...(await contextBundle()), source: "v10_ai_documents" }); }
    catch (error) { res.status(500).json({ ok: false, error: safeError(error) }); }
  });

  app.post("/api/ai-contexts/save", async (req, res) => {
    try { res.json({ ok: true, data: await saveContext(await body(req)) }); }
    catch (error) { res.status(400).json({ ok: false, error: safeError(error) }); }
  });

  app.delete("/api/ai-contexts/:contextId", async (req, res) => {
    try {
      const old = await getDocumentById(req.params.contextId);
      const saved = await saveContext({
        id: old.id,
        context_name: old.title,
        content: old.content,
        page_id: old.page_id,
        priority: old.priority,
        usage_mode: "OFF",
        metadata: old.metadata,
        change_note: "Lưu trữ ngữ cảnh",
      }, "v10_context_archive");
      res.json({ ok: true, data: saved });
    } catch (error) { res.status(400).json({ ok: false, error: safeError(error) }); }
  });

  app.post("/api/ai-contexts/restore", async (req, res) => {
    try {
      const input = await body(req);
      const versionRows = await rest(`ai_documents?document_key=eq.${encodeURIComponent(clean(input.context_key || ""))}&version_no=eq.${Number(input.version_no || 0)}&select=*&limit=1`);
      let version = versionRows?.[0];
      if (!version && clean(input.context_id)) version = await getDocumentById(clean(input.context_id));
      if (!version) throw new Error("Không tìm thấy phiên bản");
      const saved = await saveContext({
        id: version.id,
        context_key: version.document_key,
        context_name: version.title,
        content: version.content,
        page_id: version.page_id,
        priority: version.priority,
        usage_mode: version.metadata?.usage_mode || (version.status === "published" ? "PRODUCTION" : "TEST"),
        metadata: version.metadata,
        change_note: `Khôi phục phiên bản ${version.version_no}`,
      }, "v10_context_restore");
      res.json({ ok: true, data: saved });
    } catch (error) { res.status(400).json({ ok: false, error: safeError(error) }); }
  });

  app.post("/api/ai-contexts/test", async (req, res) => {
    const started = Date.now();
    try {
      const input = await body(req);
      const contextId = clean(input.context_id);
      const inputText = clamp(input.input_text, 20000);
      if (!contextId || !inputText) throw new Error("Cần chọn ngữ cảnh và nhập câu hỏi thử");
      const selected = await getDocumentById(contextId);
      const documents = latestDocuments(await allDocuments());
      const pageId = clean(input.page_id || selected.page_id) || null;
      const included = documents.filter((row) => row.id === selected.id || (row.status === "draft" && (!row.page_id || row.page_id === pageId)));
      const systemText = included.map((row) => `### ${row.title}\n${row.content}`).join("\n\n") + "\n\nKhông bịa giá, tồn kho hoặc chính sách; thiếu dữ liệu phải nói rõ.";
      let providers;
      if (clean(input.provider_key)) providers = await rest(`ai_providers?provider_key=eq.${encodeURIComponent(clean(input.provider_key))}&select=*&limit=1`);
      else providers = await rest("ai_providers?is_enabled=eq.true&select=*&order=updated_at.desc&limit=1");
      const provider = providers?.[0];
      if (!provider?.api_key_ciphertext) throw new Error("Chưa cấu hình nhà cung cấp AI");
      const apiKey = decryptProviderKey(provider.api_key_ciphertext);
      const copy = { ...provider, model_name: clean(input.model_name || provider.model_name) };
      const { data } = await providerFetch(copy, apiKey, [
        { role: "system", content: systemText },
        { role: "user", content: inputText },
      ], false);
      const outputText = Array.isArray(data?.choices?.[0]?.message?.content)
        ? data.choices[0].message.content.map((part) => part?.text || "").join("")
        : clean(data?.choices?.[0]?.message?.content);
      res.json({ ok: true, output_text: outputText, provider_key: provider.provider_key, model_name: copy.model_name, latency_ms: Date.now() - started });
    } catch (error) { res.status(400).json({ ok: false, error: safeError(error), latency_ms: Date.now() - started }); }
  });

  app.get("/learning-reviewed/api/conversations", async (req, res) => {
    try {
      const result = await rpc("v10_learning_conversation_list", {
        p_search: clean(req.query.search) || null,
        p_limit: Math.min(500, Math.max(1, Number(req.query.limit || 50))),
        p_offset: Math.max(0, Number(req.query.offset || 0)),
      });
      res.json({ ok: true, ...(result || {}), data_source: "v10_core_service_role" });
    } catch (error) { res.status(500).json({ ok: false, error: safeError(error) }); }
  });

  app.get("/learning-reviewed/api/conversation", async (req, res) => {
    try {
      const pageId = clean(req.query.page_id);
      const senderId = clean(req.query.sender_id);
      if (!pageId || !senderId) throw new Error("PAGE_ID_AND_SENDER_ID_REQUIRED");
      const result = await rpc("v10_learning_conversation_detail", { p_page_id: pageId, p_sender_id: senderId });
      res.json({ ok: true, data: { ...(result || {}), page_id: pageId, sender_id: senderId, data_source: "v10_core_service_role" } });
    } catch (error) { res.status(500).json({ ok: false, error: safeError(error) }); }
  });

  app.get("/learning-reviewed/api/integrations", async (_req, res) => {
    try {
      const rows = await rest("v9_integrations?select=integration_key,integration_type,display_name,status,public_config,last_verified_at,last_error,updated_at&order=integration_key.asc");
      const data = (rows || []).map((row) => ({
        ...row,
        connection_enabled: row.status !== "disabled",
        message_sync_enabled: row.public_config?.message_sync_enabled !== false,
      }));
      if (!data.some((row) => row.integration_key === "pancake")) {
        data.push({
          integration_key: "pancake",
          integration_type: "pancake",
          display_name: "Pancake",
          status: process.env.PANCAKE_PAGE_ACCESS_TOKEN || process.env.PANCAKE_ACCESS_TOKEN ? "enabled" : "not_configured",
          connection_enabled: Boolean(process.env.PANCAKE_PAGE_ACCESS_TOKEN || process.env.PANCAKE_ACCESS_TOKEN),
          message_sync_enabled: true,
          public_config: {},
        });
      }
      res.json({ ok: true, data, source: "v9_integrations" });
    } catch (error) { res.status(500).json({ ok: false, error: safeError(error) }); }
  });

  app.patch("/learning-reviewed/api/integrations", async (req, res) => {
    try {
      const input = await body(req);
      const integrationKey = clean(input.integration_key);
      if (!integrationKey) throw new Error("INTEGRATION_KEY_REQUIRED");
      const rows = await rest(`v9_integrations?integration_key=eq.${encodeURIComponent(integrationKey)}&select=*&limit=1`);
      const current = rows?.[0];
      if (!current) throw new Error("INTEGRATION_NOT_MANAGED_IN_CORE");
      const publicConfig = { ...(current.public_config || {}), message_sync_enabled: input.message_sync_enabled !== false };
      const saved = await rest(`v9_integrations?integration_key=eq.${encodeURIComponent(integrationKey)}`, {
        method: "PATCH",
        body: { status: input.connection_enabled === false ? "disabled" : "ready", public_config: publicConfig, last_error: null, updated_at: nowIso() },
      });
      res.json({ ok: true, data: saved?.[0] || saved });
    } catch (error) { res.status(400).json({ ok: false, error: safeError(error) }); }
  });

  function followupStats(logs = []) {
    const pending = new Set(["queued", "ai_queued", "ai_processing", "ready_to_send", "retry", "delivery_processing"]);
    const failed = new Set(["failed", "ai_failed", "sent_partial"]);
    return logs.reduce((acc, row) => {
      acc.total += 1;
      if (["sent", "sent_partial"].includes(row.status)) acc.sent += 1;
      if (pending.has(row.status)) acc.pending += 1;
      if (row.status === "suppressed") acc.suppressed += 1;
      if (failed.has(row.status)) acc.failed += 1;
      return acc;
    }, { total: 0, sent: 0, pending: 0, suppressed: 0, failed: 0 });
  }

  function legacyFollowupShape(row = {}) {
    return {
      ...row,
      mode: "default_v8",
      use_pancake_contact_tags: false,
      window_start: `${String(row.day_start_hour ?? 8).padStart(2, "0")}:00`,
      window_end: "22:30",
      first_wait_min_minutes: Number(row.day_wait_minutes || 240),
      first_wait_max_minutes: Number(row.day_wait_minutes || 240),
      repeat_wait_minutes: Number(row.evening_wait_minutes || 120),
      max_followups_per_cycle: 2,
    };
  }

  app.get("/follow-up-admin/api/state", async (_req, res) => {
    try {
      const [configRows, heartbeatRows, logs, pages] = await Promise.all([
        rest("v10_followup_config?select=*&id=eq.1&limit=1"),
        rest("v9_worker_heartbeats?select=*&worker_name=eq.aiguka-v10-followup&limit=1"),
        rest("v10_followup_log?select=*&order=queued_at.desc&limit=200"),
        rest("v9_pages?select=page_id,page_name"),
      ]);
      const names = new Map((pages || []).map((row) => [String(row.page_id), row.page_name]));
      const enriched = (logs || []).map((row) => ({ ...row, page_name: names.get(String(row.page_id)) || null }));
      res.json({
        ok: true,
        config: legacyFollowupShape(configRows?.[0] || {}),
        events: [],
        worker: heartbeatRows?.[0] || null,
        stats: followupStats(enriched),
        logs: enriched.slice(0, 100),
        guard: { checked: 0, tagged: 0, last_checked_at: null },
        event_mode_available: false,
        source: "v10_followup_config",
      });
    } catch (error) { res.status(500).json({ ok: false, error: safeError(error) }); }
  });

  app.post("/follow-up-admin/api/config", async (req, res) => {
    try {
      const input = await body(req);
      const patch = {
        enabled: false,
        delivery_enabled: false,
        scan_interval_minutes: Math.min(180, Math.max(1, Number(input.scan_interval_minutes || 15))),
        max_age_hours: Math.min(23, Math.max(1, Number(input.max_age_hours || 20))),
        max_per_run: Math.min(100, Math.max(1, Number(input.max_per_run || 20))),
        day_wait_minutes: Math.min(1440, Math.max(15, Number(input.first_wait_min_minutes || input.day_wait_minutes || 240))),
        evening_wait_minutes: Math.min(1440, Math.max(15, Number(input.repeat_wait_minutes || input.evening_wait_minutes || 120))),
        updated_by: "v10_followup_admin_safe_off",
        updated_at: nowIso(),
      };
      const saved = await rest("v10_followup_config?id=eq.1", { method: "PATCH", body: patch });
      res.json({ ok: true, data: legacyFollowupShape(saved?.[0] || patch), delivery_locked_until_ingress_verified: true });
    } catch (error) { res.status(400).json({ ok: false, error: safeError(error) }); }
  });

  app.post("/follow-up-admin/api/apply", async (req, res) => {
    try {
      const input = await body(req);
      const patch = {
        enabled: false,
        delivery_enabled: false,
        scan_interval_minutes: Math.min(180, Math.max(1, Number(input.config?.scan_interval_minutes || 15))),
        max_age_hours: Math.min(23, Math.max(1, Number(input.config?.max_age_hours || 20))),
        max_per_run: Math.min(100, Math.max(1, Number(input.config?.max_per_run || 20))),
        updated_by: "v10_followup_admin_apply_safe_off",
        updated_at: nowIso(),
      };
      const saved = await rest("v10_followup_config?id=eq.1", { method: "PATCH", body: patch });
      res.json({ ok: true, data: { events: [], config: saved?.[0] || patch }, event_mode_available: false });
    } catch (error) { res.status(400).json({ ok: false, error: safeError(error) }); }
  });

  app.post("/follow-up-admin/api/scan", async (_req, res) => {
    try {
      await rest("v10_followup_config?id=eq.1", { method: "PATCH", prefer: "return=minimal", body: { last_scan_at: null, updated_by: "v10_followup_force_scan", updated_at: nowIso() } });
      res.json({ ok: true, requested: true });
    } catch (error) { res.status(500).json({ ok: false, error: safeError(error) }); }
  });

  app.post("/follow-up-admin/api/reset", async (_req, res) => {
    try {
      const patch = { enabled: false, delivery_enabled: false, scan_interval_minutes: 15, max_age_hours: 20, max_per_run: 20, day_wait_minutes: 240, evening_wait_minutes: 120, updated_by: "v10_followup_reset_safe_off", updated_at: nowIso() };
      const saved = await rest("v10_followup_config?id=eq.1", { method: "PATCH", body: patch });
      res.json({ ok: true, data: legacyFollowupShape(saved?.[0] || patch), delivery_locked_until_ingress_verified: true });
    } catch (error) { res.status(500).json({ ok: false, error: safeError(error) }); }
  });

  app.post("/follow-up-admin/api/event/save", async (_req, res) => res.status(409).json({ ok: false, error: "EVENT_MODE_NOT_MIGRATED_TO_V10" }));
  app.post("/follow-up-admin/api/event/delete", async (_req, res) => res.status(409).json({ ok: false, error: "EVENT_MODE_NOT_MIGRATED_TO_V10" }));

  console.log("[AIGUKA V10 admin compat] report/provider/context/learning/follow-up Core routes installed");
}
