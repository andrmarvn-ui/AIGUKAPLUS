import assert from "node:assert/strict";
import test from "node:test";
import {
  driveFileId,
  prepareCarouselAssets,
  staticCarouselUrl,
} from "../v10/core/carousel-media.js";

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, ...Array(64).fill(1)]);

function imageResponse(status = 200) {
  return new Response(status === 200 ? JPEG : "failure", {
    status,
    headers: {
      "content-type": status === 200 ? "image/jpeg" : "text/plain",
      "content-length": String(status === 200 ? JPEG.length : 7),
    },
  });
}

test("Drive IDs are extracted while dynamic Drive and proxy URLs are never used as carousel media", () => {
  const fileId = "1AVV5KtHayKbE2COcnBd1gop64Nrf9BWk";
  assert.equal(driveFileId(`https://drive.google.com/uc?export=view&id=${fileId}`), fileId);
  assert.equal(staticCarouselUrl({ source_url: `https://drive.google.com/uc?export=view&id=${fileId}` }), "");
  assert.equal(staticCarouselUrl({ source_url: `https://example.supabase.co/functions/v1/aiguka-drive-image-proxy?file_id=${fileId}` }), "");
});

test("all carousel cards resolve to verified static Storage URLs before Meta send", async () => {
  const driveIds = [
    "1AVV5KtHayKbE2COcnBd1gop64Nrf9BWk",
    "1JNQZ3_kc3PTatQysyisDRBlzX1Ebzu04",
    "1PGXmIyWZwSRlzpYgSjesIGZaxnToikZO",
  ];
  const requested = [];
  const assets = driveIds.map((id, index) => ({
    title: `Mẫu ${index + 1}`,
    source_url: `https://drive.google.com/uc?export=view&id=${id}`,
  }));
  const ready = await prepareCarouselAssets(assets, {
    lookupStorageAssets: async (ids) => ids.map((id) => ({
      drive_file_id: id,
      storage_status: "ready",
      storage_url: `https://example.supabase.co/storage/v1/object/public/catalog/by-id/${id}`,
    })),
    fetchImpl: async (url) => {
      requested.push(url);
      return imageResponse();
    },
  });
  assert.equal(ready.length, 3);
  assert.equal(requested.length, 3);
  assert.ok(ready.every((asset) => asset.source_url.includes("/storage/v1/object/public/")));
  assert.ok(ready.every((asset) => asset.carousel_preflight.bytes === JPEG.length));
});

test("one failed card blocks the whole carousel instead of sending broken images", async () => {
  const assets = [
    { source_url: "https://cdn.example.com/01.jpg" },
    { source_url: "https://cdn.example.com/02.jpg" },
  ];
  await assert.rejects(
    prepareCarouselAssets(assets, {
      fetchImpl: async (url) => imageResponse(url.endsWith("02.jpg") ? 502 : 200),
    }),
    /CAROUSEL_PREFLIGHT_FAILED:2:HTTP_502/,
  );
});

