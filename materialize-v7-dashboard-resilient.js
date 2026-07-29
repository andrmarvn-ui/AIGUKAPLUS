import https from "node:https";

const supabaseUrl = new URL(
  String(
    process.env.SUPABASE_URL ||
      process.env.SUPABASE_PROJECT_URL ||
      "https://ezygfpeeqbbirdeazene.supabase.co",
  ).replace(/\/$/, ""),
);
const apiKey = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    "",
);

if (!apiKey) throw new Error("MISSING_SUPABASE_KEY_FOR_V7_DASHBOARD");

const body = JSON.stringify({ p_code_key: "v7_dashboard_stable" });

function requestEmbeddedCode() {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: supabaseUrl.protocol,
        hostname: supabaseUrl.hostname,
        port: supabaseUrl.port || 443,
        path: "/rest/v1/rpc/v8_get_embedded_code_test",
        method: "POST",
        headers: {
          apikey: apiKey,
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-aiguka-railway-test": "enabled",
          "x-aiguka-admin-secret": "AIGUKA_RAILWAY_TEST_MODE",
          connection: "close",
        },
        timeout: 120_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let payload;
          try {
            payload = JSON.parse(text);
          } catch {
            reject(new Error(`V7_CODE_INVALID_JSON:${text.slice(0, 300)}`));
            return;
          }
          if ((res.statusCode || 500) >= 400 || !payload?.ok || !Array.isArray(payload?.chunks)) {
            reject(
              new Error(
                payload?.message ||
                  payload?.error ||
                  `V7_CODE_HTTP_${res.statusCode || 500}`,
              ),
            );
            return;
          }
          resolve(payload);
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("V7_CODE_HTTPS_TIMEOUT")));
    req.on("error", reject);
    req.end(body);
  });
}

async function loadWithRetry() {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const payload = await requestEmbeddedCode();
      console.log(`[AIGUKA] V7 dashboard source loaded through direct HTTPS on attempt ${attempt}`);
      return payload;
    } catch (error) {
      lastError = error;
      console.error(
        `[AIGUKA] V7 dashboard source attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
  throw lastError || new Error("V7_CODE_LOAD_FAILED");
}

const payload = await loadWithRetry();
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = String(typeof input === "string" ? input : input?.url || input);
  if (url.includes("/rest/v1/rpc/v8_get_embedded_code_test")) {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return originalFetch(input, init);
};

try {
  await import("./materialize-v7-dashboard.js");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("[AIGUKA] Resilient pre-V2.1 dashboard materialization completed");
