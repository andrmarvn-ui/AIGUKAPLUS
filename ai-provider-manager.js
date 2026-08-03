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
    if (["api.deepseek.com", "api.moonshot.ai", "openrouter.ai", "integrate.api.nvidia.com", "api.x.ai"].includes(host)) return "chat_completions";
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
    if (!base || !model) throw new Error("BASE_URL_OR_MODEL_MISSING");
    const tool = testTool();
    let payload;
    let endpoint;

    if (style === "gemini_openai_chat") {
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
      const settings = { ...(row.settings || {}), endpoint_style: smoke.endpoint_style, runtime_order: Math.max(1, Number(row.settings?.runtime_order || 100)), smoke_test: smoke };
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
      const settings = { ...(row.settings || {}), runtime_order: Math.max(1, Number(row.settings?.runtime_order || 100)), smoke_test: { ok: false, tested_at: testedAt, error: message } };
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

  app.get("/ai-providers", (_req, res) => res.type("html").send(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trung tâm nhà cung cấp AI</title><style>body{margin:0;background:#f4f7fb;color:#101828;font:14px Arial}.wrap{max-width:1320px;margin:auto;padding:24px}.top,.head,.actions{display:flex;align-items:center;gap:10px}.top,.head{justify-content:space-between}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.card{background:#fff;border:1px solid #d0d5dd;border-radius:12px;padding:16px}.btn{border:1px solid #b8c5d6;border-radius:7px;padding:9px 13px;background:#fff;cursor:pointer}.primary{background:#155eef;color:#fff;border-color:#155eef}.danger{color:#b42318}.badge{padding:5px 9px;border-radius:999px;background:#f2f4f7}.ok{background:#d1fadf;color:#05603a}.bad{background:#fee4e2;color:#b42318}.warn{background:#fef0c7;color:#b54708}.facts{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.fact{border:1px solid #e4e7ec;border-radius:8px;padding:9px;background:#f9fafb}.modal{display:none;position:fixed;inset:0;background:#0007;align-items:center;justify-content:center}.modal.show{display:flex}.dialog{width:min(660px,94vw);background:#fff;border-radius:12px;padding:20px;max-height:92vh;overflow:auto}label{display:block;font-weight:700;margin-top:10px}input,select{box-sizing:border-box;width:100%;padding:9px;border:1px solid #c5d0df;border-radius:7px;margin-top:5px}.note{background:#eaf4ff;border:1px solid #84caff;padding:12px;border-radius:8px;margin-bottom:16px}.muted{color:#667085}.error{color:#b42318;margin-top:10px}.success{color:#05603a;margin-top:10px}@media(max-width:850px){.grid,.facts{grid-template-columns:1fr}}</style></head><body><div class="wrap"><div class="top"><div><h1>Trung tâm nhà cung cấp AI</h1><div class="muted">Một nguồn cấu hình duy nhất cho key, model, endpoint, priority và kiểm thử runtime V10</div></div><div><a class="btn" href="/dashboard">Dashboard</a> <button class="btn primary" onclick="openForm()">+ Thêm nhà cung cấp</button></div></div><div class="note"><b>Production Ready</b> chỉ xuất hiện sau khi gọi model thật và nhận đúng function/tool call. Lỗi quota, endpoint, model hoặc tool-call sẽ tự tắt provider.</div><div id="status" class="muted"></div><div id="grid" class="grid"></div></div><div id="modal" class="modal"><form id="form" class="dialog"><div class="head"><h2 id="title">Nhà cung cấp AI</h2><button type="button" class="btn" onclick="closeForm()">Đóng</button></div><label>Mã nhà cung cấp<input id="provider_key" required></label><label>Tên hiển thị<input id="provider_name" required></label><label>Chuẩn API<select id="provider_type"><option value="openai_compatible">OpenAI / tương thích OpenAI</option><option value="gemini">Google Gemini</option><option value="openrouter">OpenRouter</option><option value="xai">xAI</option><option value="anthropic">Anthropic</option></select></label><label>Base URL<input id="base_url" required></label><label>Model<input id="model_name" required></label><label>Endpoint style<select id="endpoint_style"><option value="">Tự nhận diện</option><option value="responses">Responses API</option><option value="chat_completions">Chat Completions</option><option value="gemini_openai_chat">Gemini OpenAI compatibility</option></select></label><label>Priority (1 là cao nhất)<input id="runtime_order" type="number" min="1" value="100"></label><label>API key mới<input id="api_key" type="password" autocomplete="new-password" placeholder="Để trống nếu không đổi"></label><label>Chế độ<select id="mode"><option>OFF</option><option>TEST</option><option>PRODUCTION</option></select></label><div class="actions" style="margin-top:16px"><button class="btn primary">Lưu + test thật</button></div><div class="muted" style="margin-top:8px">Nếu test thất bại, provider tự chuyển OFF.</div></form></div><script>let rows=[];const $=id=>document.getElementById(id),E=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));function badge(x){if(x.production_ready)return '<span class="badge ok">Production Ready</span>';if(x.connection_status==='error')return '<span class="badge bad">Error</span>';return '<span class="badge warn">Chưa kiểm thử thật</span>'}async function load(){ $('status').textContent='Đang tải...';const r=await fetch('/api/ai-providers',{cache:'no-store'}),j=await r.json();if(!r.ok)throw Error(j.error);rows=j.data||[];$('grid').innerHTML=rows.map(x=>{const s=x.smoke_test||{};return '<div class="card"><div class="head"><div><h2 style="margin:0">'+E(x.provider_name)+'</h2><div class="muted">'+E(x.provider_key)+'</div></div>'+badge(x)+'</div><div class="facts"><div class="fact"><b>Priority</b><br>'+E(x.runtime_order)+'</div><div class="fact"><b>Mode</b><br>'+E(x.mode)+'</div><div class="fact"><b>Model</b><br>'+E(x.model_name||'-')+'</div><div class="fact"><b>Endpoint</b><br>'+E(x.endpoint_style)+'</div><div class="fact"><b>Tool call</b><br>'+(s.tool_call?'✓ OK':'✗ Chưa đạt')+'</div><div class="fact"><b>Latency</b><br>'+E(s.latency_ms?Math.round(s.latency_ms)+' ms':'-')+'</div></div><div class="muted" style="margin-top:10px">Key: '+E(x.has_api_key?x.api_key_hint:'Chưa nhập')+' · Lần test: '+E(s.tested_at?new Date(s.tested_at).toLocaleString('vi-VN'):'Chưa có')+'</div>'+(x.last_error?'<div class="error">'+E(x.last_error)+'</div>':'')+'<div class="actions" style="margin-top:14px"><button class="btn primary" data-action="test" data-key="'+E(x.provider_key)+'">Test thật</button><button class="btn" data-action="edit" data-key="'+E(x.provider_key)+'">Sửa</button><button class="btn danger" data-action="remove" data-key="'+E(x.provider_key)+'">Xóa</button></div></div>'}).join('')||'<div class="card">Chưa có provider.</div>';$('status').textContent='Đã tải '+rows.length+' provider.'}function openForm(x={}){$('form').reset();for(const k of ['provider_key','provider_name','provider_type','base_url','model_name','endpoint_style','runtime_order','mode'])if(x[k]!=null)$(k).value=x[k];$('provider_key').readOnly=!!x.provider_key;$('title').textContent=x.provider_key?'Sửa '+x.provider_name:'Thêm nhà cung cấp';$('modal').classList.add('show')}function closeForm(){$('modal').classList.remove('show')}function edit(k){openForm(rows.find(x=>x.provider_key===k)||{})}$('form').onsubmit=async e=>{e.preventDefault();const b={};for(const k of ['provider_key','provider_name','provider_type','base_url','model_name','endpoint_style','runtime_order','api_key','mode'])b[k]=$(k).value;$('status').textContent='Đang lưu và gọi test thật...';const r=await fetch('/api/ai-providers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}),j=await r.json();if(!r.ok){alert(j.error);await load();return}closeForm();await load();alert('Provider đã vượt qua tool-call test và được cập nhật.')}async function testKey(k){$('status').textContent='Đang gọi model thật '+k+'...';const r=await fetch('/api/ai-providers/'+encodeURIComponent(k)+'/test',{method:'POST'}),j=await r.json();alert(r.ok?'PASS · tool-call OK · '+Math.round(j.smoke_test?.latency_ms||0)+' ms':j.error);await load()}async function removeKey(k){if(!confirm('Xóa provider '+k+'?'))return;await fetch('/api/ai-providers/'+encodeURIComponent(k),{method:'DELETE'});await load()}document.addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(!b)return;const k=b.dataset.key;if(b.dataset.action==='test')testKey(k);if(b.dataset.action==='edit')edit(k);if(b.dataset.action==='remove')removeKey(k)});load().catch(e=>{$('status').textContent=e.message})</script></body></html>`));
}
