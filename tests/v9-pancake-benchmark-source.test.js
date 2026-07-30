import assert from "node:assert/strict";
import test from "node:test";
import { __private__ } from "../pancake-live.js";

test("Botcake is normalized as the AICAKE source", () => {
  const message = {
    message: "Dạ em chào anh/chị ạ",
    admin_id: "104810069068200",
    admin_name: "Botcake",
    created_at: "2026-07-30T08:00:00Z",
    is_admin: true,
  };
  assert.equal(__private__.inferDirection(message, "104810069068200", "customer"), "outbound");
  assert.equal(__private__.sourceSystem(message, "outbound"), "aicake");
});

test("Pancake conversation snippet creates a timestamped outbound summary", () => {
  const message = __private__.conversationSummaryMessage({
    id: "104810069068200_123",
    page_id: "104810069068200",
    snippet: "[Botcake] Dạ em gửi anh/chị một số mẫu phù hợp ạ",
    updated_at: "2026-07-30T08:00:00Z",
    last_sent_by: {
      id: "104810069068200",
      admin_id: "104810069068200",
      admin_name: "Botcake",
      app_id: 556376998159104,
    },
  });
  assert.ok(message);
  assert.equal(message.is_admin, true);
  assert.equal(message.created_at, "2026-07-30T08:00:00Z");
  const normalized = __private__.normalizeMessage(message, {
    pageId: "104810069068200",
    senderId: "123",
    fallbackTime: "2026-07-30T07:59:00Z",
  });
  assert.equal(normalized.direction, "outbound");
  assert.equal(normalized.source_system, "aicake");
  assert.equal(normalized.is_automatic, true);
  assert.match(normalized.message_text, /một số mẫu phù hợp/);
});