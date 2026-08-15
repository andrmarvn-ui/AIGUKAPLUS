import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  commentPrivateReplyContextFromMessages,
  commentPrivateReplyEligibility,
} from "../v9/core/comment-private-reply.js";
import { createMessageGateway } from "../v10/core/message-gateway.js";
import { buildConversationContext } from "../v10/core/conversation-assembler.js";

function commentMessage(text = "Bồn cầu giá bao nhiêu?") {
  return {
    id: "legacy_inbox:event-1",
    role: "customer",
    event_type: "customer_comment",
    text,
    payload: {
      kind: "feed_change",
      change: {
        value: {
          item: "comment",
          verb: "add",
          comment_id: "comment-123",
          post_id: "page-1_post-1",
          from: { id: "customer-1" },
          message: text,
        },
      },
    },
  };
}

test("only actionable comments become private-reply work", () => {
  const actionable = commentPrivateReplyEligibility({
    page_id: "page-1",
    sender_id: "customer-1",
    comment_id: "comment-1",
    message_text: "Chậu 2 hố giá bao nhiêu?",
  });
  assert.equal(actionable.eligible, true);
  assert.equal(actionable.reason, "ACTIONABLE_CUSTOMER_COMMENT");

  for (const messageText of ["Tuyệt vời", ".", "❤️"]) {
    const result = commentPrivateReplyEligibility({
      page_id: "page-1",
      sender_id: "customer-1",
      comment_id: "comment-1",
      message_text: messageText,
    });
    assert.equal(result.eligible, false);
  }

  const contact = commentPrivateReplyEligibility({
    page_id: "page-1",
    sender_id: "customer-1",
    comment_id: "comment-phone",
    message_text: "SĐT 0912345678",
  });
  assert.equal(contact.eligible, true);
  assert.equal(contact.phone, "0912345678");
  assert.equal(contact.reason, "CONTACT_IN_COMMENT_REQUIRES_PRIVATE_ACK");
});

test("comment delivery context preserves comment id and forbids public replies", () => {
  const context = commentPrivateReplyContextFromMessages([commentMessage()]);
  assert.equal(context.deliveryMode, "comment_private_reply");
  assert.equal(context.commentId, "comment-123");
  assert.equal(context.customerId, "customer-1");
  assert.equal(context.publicReplyForbidden, true);
});

test("conversation assembler treats a customer comment like customer input", () => {
  const message = commentMessage();
  const context = buildConversationContext([{
    source_event_id: message.id,
    actor_type: "customer",
    event_type: message.event_type,
    message_text: message.text,
    payload: message.payload,
    occurred_at: "2026-08-15T08:00:00Z",
  }]);
  assert.equal(context.requires_ai, true);
  assert.equal(context.latest_customer_message.event_type, "customer_comment");
  assert.equal(commentPrivateReplyContextFromMessages(context.messages).commentId, "comment-123");
});

test("Message Gateway addresses source comment and never a public comments endpoint", async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).includes("me/accounts")) {
      return new Response(JSON.stringify({ data: [{ id: "page-1", name: "Page", access_token: "page-token" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ message_id: "mid-private-1", recipient_id: "customer-1" }), { status: 200 });
  };
  const gateway = createMessageGateway({
    coreRequest: async () => [],
    fetchImpl,
    loadConnection: async () => ({ accessToken: "user-token" }),
    graphVersion: "v23.0",
  });

  await gateway.sendPrivateCommentReply("page-1", "comment-123", "Tin nhắn riêng");
  const sent = requests.at(-1);
  const body = JSON.parse(sent.init.body);
  assert.deepEqual(body.recipient, { comment_id: "comment-123" });
  assert.deepEqual(body.message, { text: "Tin nhắn riêng" });
  assert.equal(body.messaging_type, "RESPONSE");
  assert.doesNotMatch(sent.url, /\/comments(?:\?|$)/);

  const source = fs.readFileSync(new URL("../v10-outbound-worker.js", import.meta.url), "utf8");
  assert.match(source, /meta_comment_private_reply/);
  assert.match(source, /public_comment_reply_forbidden/);
  assert.match(source, /Number\(error\?\.code \|\| 0\) === 10900/);
  assert.match(source, /COMMENT_PRIVATE_REPLY_ALREADY_EXISTS/);
  assert.doesNotMatch(source, /graph\.facebook\.com|\/comments/);
});

test("recovery worker only requeues the current customer frontier", () => {
  const source = fs.readFileSync(new URL("../v10-comment-private-reply-recovery-worker.js", import.meta.url), "utf8");
  assert.match(source, /state\.last_source_event_id/);
  assert.match(source, /alreadyHandled/);
  assert.match(source, /public_reply_forbidden: true/);
  assert.match(source, /delivery_mode: "comment_private_reply"/);
});
