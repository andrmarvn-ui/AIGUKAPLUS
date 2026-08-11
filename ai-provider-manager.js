import crypto from "node:crypto";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
const trim = (v) => String(v ?? "").trim();
const nowIso = () => new Date().toISOString();
const safeError = (error) => trim(error?.error?.message || error?.message || error?.error_description || error?.error || "provider_test_failed").replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 800);

export function installAiProviderManager(app) {
  const sb = trim(process.env.SUPABASE_URL).replace(/\/$/, "");
  const service = trim(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const headers = { apikey: service, authorization: `Bearer ${service}`, "content-type": "application/json" };
  const encKey = crypto.createHash("sha256").update(`${service}|${sb}|AIGUKA_AI_PROVIDER_KEYS_V1`).digest();
  const encrypt = (value) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encKey, iv);
    const out = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), out.toString("base64")].join(".");
  };
  const decrypt = (value) => {
    const [i, t, d] = String(value || "").split(".");
    if (!i || !t || !d) throw new Error("API_KEY_FORMAT_INVALID");
    const decipher = crypto.createDecipheriv("aes-256-gcm", encKey, Buffer.from(i, "base64"));
    decipher.setAuthTag(Buffer.from(t, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(d, "base64")), decipher.final()]).toString("utf8");
  };

  async function body(req) {
    if (req.body && typeof req.body === "object") return req.body;
    let raw = "";
    for await (const c of req) raw += c;
    return raw ? JSON.parse(raw) : {};
  }
  async function rest(path, opts = {}) {
    const response = await fetch(`${sb}/rest/v1/${path}`, { ...opts, headers: { ...headers, ...opts.headers }, cache: "no-store" });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!response.ok) throw new Error(data?.message || data?.error || `SUPABASE_HTTP_${response.status}`);
    return data;
  }
  async function findOne(key) {
    const rows = await rest(`v8_ai_providers?provider_key=eq.${encodeURIComponent(key)}&select=*&limit=1`);
    return rows?.[0] || null;
  }
  async function patchOne(key, patch) {
    const rows = await rest(`v8_ai_providers?provider_key=eq.${encodeURIComponent(key)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
    return rows?.[0] || null;
  }
  function endpointStyle(row) {
    const configured = trim(row.settings?.endpoint_style);
    if (configured) return configured;
    const host = (() => { try { return new URL(row.base_url).hostname.toLowerCase(); } catch { return ""; } })();
    if (row.provider_type === "gemini") return "gemini_openai_chat";
    if (["api.deepseek.com", "api.moonshot.ai", "openrouter.ai", "integrate.api.nvidia.com", "api.x.ai", "api.tokenrouter.com"].includes(host)) return "chat_completions";
    return "responses";
  }
  function testTool() {
    return {
      name: "aiguka_provider_probe",
      description: "Return a provider readiness probe",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { ok: { type: "boolean" }, provider: { type: "string" }, reply: { type: "string" } },
        required: ["ok", "provider", "reply"],
      },
    };
  }
  function hasChatToolCall(payload) {
    const calls = payload?.choices?.[0]?.message?.tool_calls || [];
    return calls.some((x) => x?.function?.name === "aiguka_provider_probe");
  }
  function hasResponsesToolCall(payload) {
    return (payload?.output || []).some((x) => x?.type === "function_call" && x?.name === "aiguka_provider_probe");
  }
  async function readPayload(response) {
    const raw = await response.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw: raw.slice(0, 1000) }; }
    if (!response.ok || payload?.error) throw new Error(payload?.error?.message || payload?.message || `HTTP_${response.status}`);
    return payload;
  }
  async function listModels(row, key) {
    const base = trim(row.settings?.upstream_base_url || row.base_url).replace(/\/$/, "");
    try {
      let response;
      if (row.provider_type === "gemini") {
        const url = new URL(`${base || "https://generativelanguage.googleapis.com/v1beta"}/models`);
        url.searchParams.set("key", key);
        response = await fetch(url, { signal: AbortSignal.timeout(15000), cache: "no-store" });
      } else {
        response = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000), cache: "no-store" });
      }
      const payload = await readPayload(response);
      return (payload.data || payload.models || []).map((x) => x.id || String(x.name || "").replace(/^models\//, "")).filter(Boolean).slice(0, 200);
    } catch {
      return [];
    }
  }
  async function smokeTest(row, key) {
    const started = Date.now();
    const style = endpointStyle(row);
    const base = trim(row.settings?.upstream_base_url || row.base_url).replace(/\/$/, "");
    const model = trim(row.model_name);
    const host = (() => { try { return new URL(base).hostname.toLowerCase(); } catch { return ""; } })();
    if (!base || !model) throw new Error("BASE_URL_OR_MODEL_MISSING");
    const tool = testTool();
    let payload;
    let endpoint;

    const cohereHost = (() => {
      try { return new URL(base).hostname.toLowerCase().endsWith("cohere.ai"); }
      catch { return false; }
    })();

    if (cohereHost) {
      endpoint = "https://api.cohere.ai/v2/chat"; // AIGUKA_COHERE_NATIVE_V2_TEST_V3
      payload = await readPayload(await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "X-Client-Name": "AIGUKA" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "You are an API readiness probe. The only valid response is a call to aiguka_provider_probe." },
            { role: "user", content: "Call aiguka_provider_probe now with ok=true, provider='cohere', and reply='ready'." },
          ],
          tools: [{ type: "function", function: tool }],
          strict_tools: true,
          temperature: 0,
          max_tokens: 180,
          stream: false,
          ...(host === "api.tokenrouter.com" ? { reasoning_effort: "low" } : {}),
        }),
        signal: AbortSignal.timeout(55000),
      }));
      const calls = payload?.message?.tool_calls || [];
      if (!calls.some((x) => x?.function?.name === "aiguka_provider_probe")) throw new Error("TOOL_CALL_NOT_RETURNED");
    } else if (style === "gemini_openai_chat") {
      const compatBase = /\/openai$/i.test(base) ? base : `${base}/openai`;
      endpoint = `${compatBase}/chat/completions`;
      payload = await readPayload(await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: "You are an API readiness probe. You must call aiguka_provider_probe." }, { role: "user", content: "Confirm the provider can perform a real tool call." }],
          tools: [{ type: "function", function: tool }],
          tool_choice: "required",
          max_tokens: 180,
        }),
        signal: AbortSignal.timeout(55000),
      }));
      if (!hasChatToolCall(payload)) throw new Error("TOOL_CALL_NOT_RETURNED");
    } else if (style === "chat_completions") {
      endpoint = `${base}/chat/completions`;
      payload = await readPayload(await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(row.settings?.extra_headers || {}) },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: "You are an API readiness probe. You must call aiguka_provider_probe." }, { role: "user", content: "Confirm the provider can perform a real tool call." }],
          tools: [{ type: "function", function: tool }],
          tool_choice: "required",
          max_tokens: 180,
          stream: false,
        }),
        signal: AbortSignal.timeout(55000),
      }));
      if (!hasChatToolCall(payload)) throw new Error("TOOL_CALL_NOT_RETURNED");
    } else {
      endpoint = `${base}/responses`;
      payload = await readPayload(await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          instructions: "You are an API readiness probe. You must call aiguka_provider_probe.",
          tools: [{ type: "function", ...tool, strict: true }],
          tool_choice: { type: "function", name: "aiguka_provider_probe" },
          parallel_tool_calls: false,
          input: [{ role: "user", content: [{ type: "input_text", text: "Confirm the provider can perform a real tool call." }] }],
          max_output_tokens: 180,
        }),
        signal: AbortSignal.timeout(55000),
      }));
      if (!hasResponsesToolCall(payload)) throw new Error("TOOL_CALL_NOT_RETURNED");
    }

    return {
      ok: true,
      tested_at: nowIso(),
      latency_ms: Date.now() - started,
      endpoint,
      endpoint_style: style,
      model,
      response_id: payload?.id || null,
      usage: payload?.usage || null,
      tool_call: true,
    };
  }
  async function verifyAndPersist(row) {
    const key = decrypt(row.api_key_ciphertext);
    const models = await listModels(row, key);
    try {
      const smoke = await smokeTest(row, key);
      const settings = {
        ...(row.settings || {}),
        endpoint_style: smoke.endpoint_style,
        runtime_order: Math.max(1, Number(row.settings?.runtime_order || 100)),
        smoke_test: smoke,
        cooldown_until: null,
        runtime_cooldown_until: null,
        runtime_state: "ready",
        runtime_error_class: null,
        runtime_auto_recover: true,
      };
      const saved = await patchOne(row.provider_key, {
        connection_status: "production_ready",
        last_checked_at: smoke.tested_at,
        last_success_at: smoke.tested_at,
        last_error: null,
        available_models: models,
        settings,
        is_enabled: String(row.mode).toUpperCase() === "PRODUCTION",
        updated_at: smoke.tested_at,
      });
      return { row: saved, smoke, models };
    } catch (error) {
      const message = safeError(error);
      const testedAt = nowIso();
      const lower = message.toLowerCase();
      const temporary = /(?:http_429|rate limit|too many requests|quota|resource exhausted|capacity|timeout|temporar|overloaded|unavailable|network|fetch failed|http_408|http_424|http_499|http_500|http_502|http_503|http_504|payment required|insufficient balance|no credits remaining|add credits)/i.test(lower);
      const billing = /payment required|insufficient balance|no credits remaining|add credits/i.test(lower);
      const cooldownMs = billing ? 6 * 60 * 60_000 : /timeout|network|fetch failed|http_5[0-9][0-9]/i.test(lower) ? 2 * 60_000 : 5 * 60_000;
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
      throw failure;
    }
  }
  function publicRow(x) {
    const smoke = x.settings?.smoke_test || null;
    return {
      provider_key: x.provider_key,
      provider_name: x.provider_name,
      provider_type: x.provider_type || "openai_compatible",
      base_url: x.base_url,
      model_name: x.model_name,
      mode: x.mode,
      is_enabled: x.is_enabled,
      connection_status: x.connection_status,
      last_checked_at: x.last_checked_at,
      last_success_at: x.last_success_at,
      last_error: x.last_error,
      available_models: x.available_models || [],
      settings: x.settings || {},
      runtime_order: Number(x.settings?.runtime_order || 100),
      endpoint_style: endpointStyle(x),
      smoke_test: smoke,
      production_ready: x.connection_status === "production_ready" && smoke?.ok === true,
      has_api_key: Boolean(x.api_key_ciphertext),
      api_key_hint: x.api_key_hint || "",
    };
  }

  app.get("/api/ai-providers", async (_req, res) => {
    try {
      const rows = await rest("v8_ai_providers?select=*&order=provider_name.asc");
      res.json({ ok: true, data: (rows || []).map(publicRow).sort((a, b) => a.runtime_order - b.runtime_order || a.provider_name.localeCompare(b.provider_name)) });
    } catch (error) { res.status(500).json({ ok: false, error: safeError(error) }); }
  });

  app.post("/api/ai-providers", async (req, res) => {
    try {
      const b = await body(req);
      const key = trim(b.provider_key).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      if (!key || !trim(b.provider_name)) throw new Error("Thiếu mã hoặc tên nhà cung cấp");
      const defaults = { gemini: "https://generativelanguage.googleapis.com/v1beta", anthropic: "https://api.anthropic.com", cohere: "https://api.cohere.com", mistral: "https://api.mistral.ai/v1", groq: "https://api.groq.com/openai/v1", openrouter: "https://openrouter.ai/api/v1", together: "https://api.together.xyz/v1", xai: "https://api.x.ai/v1", openai_compatible: "https://api.openai.com/v1" };
      const type = trim(b.provider_type) || "openai_compatible";
      const existing = await findOne(key);
      const requestedMode = ["OFF", "TEST", "PRODUCTION"].includes(String(b.mode).toUpperCase()) ? String(b.mode).toUpperCase() : "OFF";
      const settings = { ...(existing?.settings || {}), ...(b.settings || {}), runtime_order: Math.max(1, Number(b.runtime_order || existing?.settings?.runtime_order || 100)), endpoint_style: trim(b.endpoint_style || existing?.settings?.endpoint_style || "") || undefined };
      const changedRuntime = trim(b.api_key) || trim(b.base_url) !== trim(existing?.base_url) || trim(b.model_name) !== trim(existing?.model_name);
      if (changedRuntime) delete settings.smoke_test;
      const row = {
        provider_name: trim(b.provider_name),
        provider_type: type,
        base_url: trim(b.base_url) || defaults[type] || "",
        model_name: trim(b.model_name),
        mode: requestedMode,
        is_enabled: false,
        settings,
        updated_at: nowIso(),
      };
      if (trim(b.api_key)) {
        row.api_key_ciphertext = encrypt(trim(b.api_key));
        row.api_key_hint = `••••${trim(b.api_key).slice(-4)}`;
      }
      let saved;
      if (existing) saved = (await rest(`v8_ai_providers?provider_key=eq.${encodeURIComponent(key)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) }))?.[0];
      else saved = (await rest("v8_ai_providers", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ provider_key: key, ...row, api_key_secret_name: null }) }))?.[0];
      if (!saved?.api_key_ciphertext) throw new Error("Chưa nhập API key");
      const checked = await verifyAndPersist(saved);
      res.json({ ok: true, created: !existing, data: publicRow(checked.row), smoke_test: checked.smoke });
    } catch (error) {
      res.status(422).json({ ok: false, error: safeError(error), data: error.row ? publicRow(error.row) : null });
    }
  });

  app.post("/api/ai-providers/:key/test", async (req, res) => {
    try {
      const row = await findOne(req.params.key);
      if (!row?.api_key_ciphertext) throw new Error("Chưa nhập API key");
      const checked = await verifyAndPersist(row);
      res.json({ ok: true, data: publicRow(checked.row), smoke_test: checked.smoke, models: checked.models });
    } catch (error) { res.status(422).json({ ok: false, error: safeError(error), data: error.row ? publicRow(error.row) : null }); }
  });

  app.delete("/api/ai-providers/:key", async (req, res) => {
    try {
      await rest(`v8_ai_providers?provider_key=eq.${encodeURIComponent(req.params.key)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ ok: false, error: safeError(error) }); }
  });

  app.get("/ai-providers", (_req, res) => res.type("html").send(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trung tâm nhà cung cấp AI</title><style>body{margin:0;background:#f4f7fb;color:#101828;font:14px Arial}.wrap{max-width:1320px;margin:auto;padding:24px}.top,.head,.actions{display:flex;align-items:center;gap:10px}.top,.head{justify-content:space-between}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.card{background:#fff;border:1px solid #d0d5dd;border-radius:12px;padding:16px}.btn{border:1px solid #b8c5d6;border-radius:7px;padding:9px 13px;background:#fff;cursor:pointer}.primary{background:#155eef;color:#fff;border-color:#155eef}.danger{color:#b42318}.badge{padding:5px 9px;border-radius:999px;background:#f2f4f7}.ok{background:#d1fadf;color:#05603a}.bad{background:#fee4e2;color:#b42318}.warn{background:#fef0c7;color:#b54708}.facts{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.fact{border:1px solid #e4e7ec;border-radius:8px;padding:9px;background:#f9fafb}.modal{display:none;position:fixed;inset:0;background:#0007;align-items:center;justify-content:center}.modal.show{display:flex}.dialog{width:min(660px,94vw);background:#fff;border-radius:12px;padding:20px;max-height:92vh;overflow:auto}label{display:block;font-weight:700;margin-top:10px}input,select{box-sizing:border-box;width:100%;padding:9px;border:1px solid #c5d0df;border-radius:7px;margin-top:5px}.note{background:#eaf4ff;border:1px solid #84caff;padding:12px;border-radius:8px;margin-bottom:16px}.muted{color:#667085}.error{color:#b42318;margin-top:10px}.success{color:#05603a;margin-top:10px}@media(max-width:850px){.grid,.facts{grid-template-columns:1fr}}</style><style id="aiguka-provider-compact-ui">/* AIGUKA_AI_PROVIDER_COMPACT_UI_V2 */
body{background:#f6f8fb!important}.wrap{max-width:1500px!important;padding:18px!important}.grid{display:block!important}.provider-toolbar{display:grid;grid-template-columns:minmax(220px,1fr) 220px auto;gap:10px;align-items:center;background:#fff;border:1px solid #d8e0ea;border-radius:10px;padding:10px;margin:14px 0;box-shadow:0 2px 7px #10182808}.provider-search,.provider-sort{height:38px;border:1px solid #cfd8e3;border-radius:7px;background:#fff;padding:0 11px;font:inherit;color:#101828}.provider-tabs{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.provider-tab{border:1px solid #d0d5dd;background:#fff;border-radius:999px;padding:7px 10px;cursor:pointer;font-weight:700;color:#475467}.provider-tab.active{border-color:#155eef;color:#155eef;background:#eff4ff}.provider-tab[data-state="ready"]{color:#067647}.provider-tab[data-state="error"]{color:#b42318}.provider-tab[data-state="test"]{color:#b54708}.provider-tab[data-state="cooldown"]{color:#175cd3}.provider-section{margin:14px 0}.provider-section-head{display:flex;align-items:center;gap:7px;font-weight:800;font-size:14px;margin:0 0 7px;padding:0 2px}.provider-section-head.ready{color:#067647}.provider-section-head.test{color:#b54708}.provider-section-head.cooldown{color:#175cd3}.provider-section-head.error{color:#b42318}.provider-section-head.off{color:#475467}.provider-list{display:flex;flex-direction:column;gap:6px}.provider-row{background:#fff;border:1px solid #d8e0ea;border-radius:9px;box-shadow:0 1px 4px #10182807;overflow:hidden}.provider-row.error-row{border-color:#f1b9b6}.provider-summary{display:grid;grid-template-columns:minmax(150px,.85fr) minmax(160px,1fr) minmax(190px,1.1fr) auto 34px;gap:12px;align-items:center;min-height:50px;padding:8px 10px 8px 13px;cursor:pointer}.provider-summary:hover{background:#f9fbfd}.provider-name{font-size:15px;font-weight:800;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.provider-model,.provider-endpoint{font-size:13px;color:#475467;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.provider-model b,.provider-endpoint b{font-size:11px;color:#98a2b3;margin-right:6px;text-transform:uppercase;letter-spacing:.02em}.provider-status{justify-self:end;border-radius:999px;padding:4px 8px;font-size:11px;font-weight:800;white-space:nowrap}.provider-status.ready{background:#d1fadf;color:#05603a}.provider-status.test{background:#fef0c7;color:#b54708}.provider-status.cooldown{background:#dbeafe;color:#175cd3}.provider-status.error{background:#fee4e2;color:#b42318}.provider-status.off{background:#f2f4f7;color:#475467}.provider-toggle{width:30px;height:30px;border:0;background:transparent;border-radius:6px;cursor:pointer;color:#475467;font-size:17px;line-height:1;transition:transform .18s ease}.provider-toggle:hover{background:#eef2f6}.provider-row.expanded .provider-toggle{transform:rotate(180deg)}.provider-details{display:none;border-top:1px solid #e4e7ec;background:#fbfcfe;padding:11px 13px 12px}.provider-row.expanded .provider-details{display:block}.provider-facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}.provider-fact{border:1px solid #e4e7ec;border-radius:7px;background:#fff;padding:7px 9px;min-width:0}.provider-fact b{display:block;font-size:10px;color:#667085;margin-bottom:2px;text-transform:uppercase;letter-spacing:.02em}.provider-fact span{display:block;font-size:13px;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.provider-alert{margin-top:8px;border:1px solid #f5c2c0;background:#fff1f0;color:#b42318;border-radius:7px;padding:8px 10px;font-size:12px;line-height:1.35;max-height:64px;overflow:auto}.provider-footer{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:9px}.provider-tested{font-size:12px;color:#667085}.provider-actions{display:flex;gap:6px}.provider-actions .btn{padding:7px 10px!important}.provider-empty{background:#fff;border:1px dashed #cfd8e3;border-radius:10px;padding:22px;text-align:center;color:#667085}.top h1{margin-bottom:3px}.top .muted{font-size:13px}@media(max-width:980px){.provider-toolbar{grid-template-columns:1fr 1fr}.provider-tabs{grid-column:1/-1;justify-content:flex-start}.provider-summary{grid-template-columns:minmax(140px,.8fr) minmax(150px,1fr) minmax(170px,1fr) auto 34px}.provider-facts{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:640px){.provider-toolbar{grid-template-columns:1fr}.provider-tabs{grid-column:auto}.provider-summary{grid-template-columns:minmax(0,1fr) auto 32px;gap:8px}.provider-model{grid-column:1/2;grid-row:2;font-size:12px}.provider-endpoint{grid-column:1/2;grid-row:3;font-size:12px}.provider-status{grid-column:2;grid-row:1/4}.provider-toggle{grid-column:3;grid-row:1/4}.provider-facts{grid-template-columns:1fr}.provider-footer{align-items:flex-start;flex-direction:column}.provider-actions{width:100%}.provider-actions .btn{flex:1}}
</style></head><body><div class="wrap"><div class="top"><div><h1>Trung tâm nhà cung cấp AI</h1><div class="muted">Một nguồn cấu hình duy nhất cho key, model, endpoint, priority và kiểm thử runtime V10</div></div><div><a class="btn" href="/dashboard">Dashboard</a> <button class="btn primary" onclick="openForm()">+ Thêm nhà cung cấp</button></div></div><div class="note"><b>Production Ready</b> chỉ xuất hiện sau khi gọi model thật và nhận đúng function/tool call. Lỗi quota, endpoint, model hoặc tool-call sẽ tự tắt provider.</div><div id="status" class="muted"></div><div id="grid" class="grid"></div></div><div id="modal" class="modal"><form id="form" class="dialog"><div class="head"><h2 id="title">Nhà cung cấp AI</h2><button type="button" class="btn" onclick="closeForm()">Đóng</button></div><label>Mã nhà cung cấp<input id="provider_key" required></label><label>Tên hiển thị<input id="provider_name" required></label><label>Chuẩn API<select id="provider_type"><option value="openai_compatible">OpenAI / tương thích OpenAI</option><option value="gemini">Google Gemini</option><option value="openrouter">OpenRouter</option><option value="xai">xAI</option><option value="anthropic">Anthropic</option></select></label><label>Base URL<input id="base_url" required></label><label>Model<input id="model_name" required></label><label>Endpoint style<select id="endpoint_style"><option value="">Tự nhận diện</option><option value="responses">Responses API</option><option value="chat_completions">Chat Completions</option><option value="gemini_openai_chat">Gemini OpenAI compatibility</option></select></label><label>Priority (1 là cao nhất)<input id="runtime_order" type="number" min="1" value="100"></label><label>API key mới<input id="api_key" type="password" autocomplete="new-password" placeholder="Để trống nếu không đổi"></label><label>Chế độ<select id="mode"><option>OFF</option><option>TEST</option><option>PRODUCTION</option></select></label><div class="actions" style="margin-top:16px"><button class="btn primary">Lưu + test thật</button></div><div class="muted" style="margin-top:8px">Nếu test thất bại, provider tự chuyển OFF.</div></form></div><script>let rows=[];const $=id=>document.getElementById(id),E=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));function badge(x){if(x.production_ready)return '<span class="badge ok">Production Ready</span>';if(x.connection_status==='error')return '<span class="badge bad">Error</span>';return '<span class="badge warn">Chưa kiểm thử thật</span>'}async function load(){ $('status').textContent='Đang tải...';const r=await fetch('/api/ai-providers',{cache:'no-store'}),j=await r.json();if(!r.ok)throw Error(j.error);rows=j.data||[];$('grid').innerHTML=rows.map(x=>{const s=x.smoke_test||{};return '<div class="card"><div class="head"><div><h2 style="margin:0">'+E(x.provider_name)+'</h2><div class="muted">'+E(x.provider_key)+'</div></div>'+badge(x)+'</div><div class="facts"><div class="fact"><b>Priority</b><br>'+E(x.runtime_order)+'</div><div class="fact"><b>Mode</b><br>'+E(x.mode)+'</div><div class="fact"><b>Model</b><br>'+E(x.model_name||'-')+'</div><div class="fact"><b>Endpoint</b><br>'+E(x.endpoint_style)+'</div><div class="fact"><b>Tool call</b><br>'+(s.tool_call?'✓ OK':'✗ Chưa đạt')+'</div><div class="fact"><b>Latency</b><br>'+E(s.latency_ms?Math.round(s.latency_ms)+' ms':'-')+'</div></div><div class="muted" style="margin-top:10px">Key: '+E(x.has_api_key?x.api_key_hint:'Chưa nhập')+' · Lần test: '+E(s.tested_at?new Date(s.tested_at).toLocaleString('vi-VN'):'Chưa có')+'</div>'+(x.last_error?'<div class="error">'+E(x.last_error)+'</div>':'')+'<div class="actions" style="margin-top:14px"><button class="btn primary" data-action="test" data-key="'+E(x.provider_key)+'">Test thật</button><button class="btn" data-action="edit" data-key="'+E(x.provider_key)+'">Sửa</button><button class="btn danger" data-action="remove" data-key="'+E(x.provider_key)+'">Xóa</button></div></div>'}).join('')||'<div class="card">Chưa có provider.</div>';$('status').textContent='Đã tải '+rows.length+' provider.'}function openForm(x={}){$('form').reset();for(const k of ['provider_key','provider_name','provider_type','base_url','model_name','endpoint_style','runtime_order','mode'])if(x[k]!=null)$(k).value=x[k];$('provider_key').readOnly=!!x.provider_key;$('title').textContent=x.provider_key?'Sửa '+x.provider_name:'Thêm nhà cung cấp';$('modal').classList.add('show')}function closeForm(){$('modal').classList.remove('show')}function edit(k){openForm(rows.find(x=>x.provider_key===k)||{})}$('form').onsubmit=async e=>{e.preventDefault();const b={};for(const k of ['provider_key','provider_name','provider_type','base_url','model_name','endpoint_style','runtime_order','api_key','mode'])b[k]=$(k).value;$('status').textContent='Đang lưu và gọi test thật...';const r=await fetch('/api/ai-providers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}),j=await r.json();if(!r.ok){alert(j.error);await load();return}closeForm();await load();alert('Provider đã vượt qua tool-call test và được cập nhật.')};async function testKey(k){$('status').textContent='Đang gọi model thật '+k+'...';const r=await fetch('/api/ai-providers/'+encodeURIComponent(k)+'/test',{method:'POST'}),j=await r.json();alert(r.ok?'PASS · tool-call OK · '+Math.round(j.smoke_test?.latency_ms||0)+' ms':j.error);await load()}async function removeKey(k){if(!confirm('Xóa provider '+k+'?'))return;await fetch('/api/ai-providers/'+encodeURIComponent(k),{method:'DELETE'});await load()}document.addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(!b)return;const k=b.dataset.key;if(b.dataset.action==='test')testKey(k);if(b.dataset.action==='edit')edit(k);if(b.dataset.action==='remove')removeKey(k)});load().catch(e=>{$('status').textContent=e.message})</script><script id="aiguka-provider-compact-ui-script">// AIGUKA_AI_PROVIDER_COMPACT_UI_V2
(()=>{let activeState='all',sortMode='status';const expanded=new Set();const states={ready:{label:'Production Ready',icon:'✓'},cooldown:{label:'Cooldown',icon:'↻'},test:{label:'Test',icon:'◷'},error:{label:'Error',icon:'!'},off:{label:'Off',icon:'○'}};function stateOf(x){if(x.connection_status==='cooldown')return'cooldown';if(x.production_ready)return'ready';if(x.connection_status==='error')return'error';if(String(x.mode||'').toUpperCase()==='TEST'||x.connection_status==='needs_test')return'test';return'off'}function counts(){const c={all:rows.length,ready:0,cooldown:0,test:0,error:0,off:0};rows.forEach(x=>c[stateOf(x)]++);return c}function safe(v){return E(v==null?'-':v)}function fact(label,value){return '<div class="provider-fact"><b>'+label+'</b><span title="'+safe(value)+'">'+safe(value)+'</span></div>'}function endpointOf(x){return x.endpoint_style||x.smoke_test?.endpoint||x.base_url||'-'}function row(x){const s=stateOf(x),sm=x.smoke_test||{},status=states[s],key=String(x.provider_key||''),isOpen=expanded.has(key);return '<div class="provider-row '+(s==='error'?'error-row ':'')+(isOpen?'expanded':'')+'" data-provider-row="'+safe(key)+'"><div class="provider-summary" data-expand="'+safe(key)+'"><div class="provider-name" title="'+safe(x.provider_name||x.provider_key)+'">'+safe(x.provider_name||x.provider_key)+'</div><div class="provider-model" title="'+safe(x.model_name||'-')+'"><b>Model</b>'+safe(x.model_name||'-')+'</div><div class="provider-endpoint" title="'+safe(sm.endpoint||x.base_url||endpointOf(x))+'"><b>Endpoint</b>'+safe(endpointOf(x))+'</div><span class="provider-status '+s+'">'+status.label+'</span><button type="button" class="provider-toggle" data-expand="'+safe(key)+'" aria-label="Mở rộng cấu hình" title="Mở rộng cấu hình">⌄</button></div><div class="provider-details"><div class="provider-facts">'+fact('Mã provider',x.provider_key)+fact('API key',x.api_key_hint||'-')+fact('Ưu tiên',x.runtime_order)+fact('Chế độ',x.mode)+fact('Model',x.model_name)+fact('Base URL',x.base_url)+fact('Tool call',sm.tool_call?'✓ OK':'✕ Chưa đạt')+fact('Độ trễ',sm.latency_ms?Math.round(sm.latency_ms)+' ms':'-')+'</div>'+(x.last_error?'<div class="provider-alert">⚠ '+safe(x.last_error)+'</div>':'')+'<div class="provider-footer"><div class="provider-tested">Lần test: '+safe(sm.tested_at?new Date(sm.tested_at).toLocaleString('vi-VN'):'Chưa có')+'</div><div class="provider-actions"><button class="btn primary" data-action="test" data-key="'+safe(key)+'">Test thật</button><button class="btn" data-action="edit" data-key="'+safe(key)+'">Sửa</button><button class="btn danger" data-action="remove" data-key="'+safe(key)+'">Xóa</button></div></div></div></div>'}function sorted(list){return [...list].sort((a,b)=>{if(sortMode==='priority')return Number(a.runtime_order||999)-Number(b.runtime_order||999);if(sortMode==='name')return String(a.provider_name||a.provider_key).localeCompare(String(b.provider_name||b.provider_key),'vi');if(sortMode==='latency')return Number(a.smoke_test?.latency_ms||1e9)-Number(b.smoke_test?.latency_ms||1e9);const order={ready:0,cooldown:1,test:2,error:3,off:4};return order[stateOf(a)]-order[stateOf(b)]||Number(a.runtime_order||999)-Number(b.runtime_order||999)})}function ensureToolbar(){if(document.getElementById('providerToolbar'))return;const toolbar=document.createElement('div');toolbar.id='providerToolbar';toolbar.className='provider-toolbar';toolbar.innerHTML='<input id="providerSearch" class="provider-search" placeholder="Tìm nhà cung cấp, model, endpoint..."><select id="providerSort" class="provider-sort"><option value="status">Sắp xếp: Trạng thái</option><option value="priority">Sắp xếp: Ưu tiên</option><option value="name">Sắp xếp: Tên</option><option value="latency">Sắp xếp: Độ trễ</option></select><div id="providerTabs" class="provider-tabs"></div>';document.getElementById('grid').before(toolbar);document.getElementById('providerSearch').addEventListener('input',renderCompact);document.getElementById('providerSort').addEventListener('change',e=>{sortMode=e.target.value;renderCompact()});document.getElementById('grid').addEventListener('click',e=>{const toggle=e.target.closest('[data-expand]');if(!toggle||e.target.closest('[data-action]'))return;const key=String(toggle.dataset.expand||'');if(!key)return;expanded.has(key)?expanded.delete(key):expanded.add(key);renderCompact()})}function renderTabs(){const c=counts(),tabs=document.getElementById('providerTabs');tabs.innerHTML=[['all','Tất cả'],['ready','Production Ready'],['cooldown','Cooldown'],['test','Test'],['error','Error'],['off','Off']].map(([k,l])=>'<button class="provider-tab '+(activeState===k?'active':'')+'" data-state="'+k+'">'+l+' <span>'+c[k]+'</span></button>').join('');tabs.querySelectorAll('.provider-tab').forEach(b=>b.onclick=()=>{activeState=b.dataset.state;renderCompact()})}function renderCompact(){ensureToolbar();renderTabs();const q=String(document.getElementById('providerSearch')?.value||'').toLowerCase().trim();let list=rows.filter(x=>(activeState==='all'||stateOf(x)===activeState)&&(!q||JSON.stringify([x.provider_name,x.provider_key,x.model_name,x.endpoint_style,x.base_url,x.mode,x.connection_status]).toLowerCase().includes(q)));list=sorted(list);const grid=document.getElementById('grid');if(!list.length){grid.innerHTML='<div class="provider-empty">Không có nhà cung cấp phù hợp bộ lọc.</div>';return}const groups=sortMode==='status'?['ready','cooldown','test','error','off']:['all'];grid.innerHTML=groups.map(g=>{const items=g==='all'?list:list.filter(x=>stateOf(x)===g);if(!items.length)return'';const meta=g==='all'?{label:'Kết quả',icon:'•'}:states[g];return '<section class="provider-section"><div class="provider-section-head '+g+'"><span>'+meta.icon+'</span>'+meta.label+' ('+items.length+')</div><div class="provider-list">'+items.map(row).join('')+'</div></section>'}).join('')}const originalLoad=load;load=async function(){await originalLoad();renderCompact()};setTimeout(()=>{if(Array.isArray(rows))renderCompact()},0)})();
</script></body></html>`));
}

// AIGUKA_TOKENROUTER_KIMI_K3_MANAGER_V1

// AIGUKA_AI_PROVIDER_RESILIENCE_UI_V1

// AIGUKA_PROVIDER_TEMPORARY_ERROR_RECOVERY_V1
