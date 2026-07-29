const PORT = Number(process.env.PORT || 3000);
const URL = `http://127.0.0.1:${PORT}/__aiguka/prewarm-v7-report-ui`;

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

for (let attempt = 1; attempt <= 4; attempt += 1) {
  try {
    if (attempt === 1) await sleep(2_000);
    const response = await fetch(URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(150_000),
      cache: "no-store",
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP_${response.status}:${body.slice(0, 300)}`);
    console.log(`[AIGUKA] Pre-V2.1 report UI prewarmed on attempt ${attempt}: ${body.slice(0, 300)}`);
    break;
  } catch (error) {
    console.error(
      `[AIGUKA] Report UI prewarm attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (attempt < 4) await sleep(attempt * 10_000);
  }
}
