const PORT = Number(process.env.PORT || 3000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function check() {
  await sleep(1800);
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/__aiguka/db-check`, {
      headers: { "x-aiguka-selfcheck": "1" },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; }
    catch { data = { raw: raw.slice(0, 300) }; }
    if (!response.ok || data?.ok !== true) {
      console.error(`[AIGUKA selfcheck] db-check failed HTTP_${response.status}: ${data?.error || data?.raw || "unknown"}`);
      return;
    }
    console.log(`[AIGUKA selfcheck] db-check healthy: pages=${data.pages ?? "-"}, ad_accounts=${data.ad_accounts ?? "-"}, ads=${data.ads ?? "-"}`);
  } catch (error) {
    console.error(`[AIGUKA selfcheck] db-check exception: ${error instanceof Error ? error.message : String(error)}`);
  }
}

void check();
