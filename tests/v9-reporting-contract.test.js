import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildReportingEnvelope, assertReportingPayloadPrivacy, hashReportingContact } from "../v9/core/reporting-contract.js";

test("message reporting keeps metrics but removes raw text", () => {
  const message = "Cho xin giá bồn cầu";
  const envelope = buildReportingEnvelope("message_fact", {
    id: "event-1",
    source_system: "meta",
    page_id: "page-1",
    customer_id: "customer-1",
    actor_type: "customer",
    event_type: "customer_message",
    message_text: message,
    attachments: [{ type: "image" }],
    referral: { ad_id: "ad-1", campaign_id: "campaign-1" },
    occurred_at: "2026-07-29T10:00:00Z",
  });
  assert.equal(envelope.payload.message_length, message.length);
  assert.equal(envelope.payload.attachment_count, 1);
  assert.equal(envelope.payload.ad_id, "ad-1");
  assert.ok(!("message_text" in envelope.payload));
  assert.doesNotMatch(JSON.stringify(envelope), /Cho xin giá/);
});

test("contact reporting uses salted hash and never copies contact value", () => {
  const envelope = buildReportingEnvelope("contact_fact", {
    id: "contact-1",
    page_id: "page-1",
    customer_id: "customer-1",
    contact_type: "phone",
    contact_value: "0965 499 803",
    normalized_value: "0965499803",
    confidence: 1,
    captured_at: "2026-07-29T10:01:00Z",
  }, { contactHashSecret: "reporting-secret" });
  assert.equal(envelope.payload.contact_hash, hashReportingContact("0965499803", "reporting-secret"));
  assert.doesNotMatch(JSON.stringify(envelope), /0965499803|0965 499 803/);
  assert.ok(!("contact_value" in envelope.payload));
  assert.ok(!("normalized_value" in envelope.payload));
});

test("contact hash is null when reporting salt is missing", () => {
  const envelope = buildReportingEnvelope("contact_fact", {
    id: "contact-2",
    page_id: "page-1",
    customer_id: "customer-1",
    contact_type: "zalo",
    normalized_value: "0965499803",
    captured_at: "2026-07-29T10:01:00Z",
  });
  assert.equal(envelope.payload.contact_hash, null);
});

test("AI decision reporting excludes final reply and model input", () => {
  const envelope = buildReportingEnvelope("ai_decision_fact", {
    id: "decision-1",
    source_event_id: "event-1",
    page_id: "page-1",
    sender_id: "customer-1",
    mode: "SHADOW",
    status: "shadow_ai_completed",
    action: "reply_text",
    confidence: 0.9,
    knowledge_version: "2:abc",
    latency_ms: 1200,
    output: {
      model: "gpt-test",
      should_request_contact: true,
      needs_slides: false,
      risk_flags: [],
      final_reply: "Nội dung không được đưa sang báo cáo",
      should_send: false,
      transport_locked: true,
    },
    input_snapshot: { customer: { phone: "0965499803" } },
    created_at: "2026-07-29T10:02:00Z",
    updated_at: "2026-07-29T10:02:01Z",
  });
  const serialized = JSON.stringify(envelope);
  assert.doesNotMatch(serialized, /Nội dung không được đưa|0965499803/);
  assert.equal(envelope.payload.model, "gpt-test");
  assert.equal(envelope.payload.attributes.transport_locked, true);
});

test("privacy guard rejects forbidden field names", () => {
  assert.throws(() => assertReportingPayloadPrivacy({ message_text: "secret" }), /REPORTING_PRIVACY_FIELD_FORBIDDEN/);
  assert.throws(() => assertReportingPayloadPrivacy({ nested: { phone: "0965" } }), /REPORTING_PRIVACY_FIELD_FORBIDDEN/);
  assert.throws(() => assertReportingPayloadPrivacy([{ safe: true }, { zalo: "secret" }]), /REPORTING_PRIVACY_FIELD_FORBIDDEN/);
});

test("privacy guard permits safe values that happen to say phone or zalo", () => {
  assert.doesNotThrow(() => assertReportingPayloadPrivacy({
    contact_type: "phone",
    channel: "zalo",
    nested: { label: "phone", values: ["zalo", "phone"] },
  }));
});

test("contact reporting envelope passes privacy guard", () => {
  const envelope = buildReportingEnvelope("contact_fact", {
    id: "contact-safe",
    page_id: "page-1",
    customer_id: "customer-1",
    contact_type: "phone",
    normalized_value: "0965499803",
    captured_at: "2026-07-29T10:01:00Z",
  }, { contactHashSecret: "reporting-secret" });
  assert.doesNotThrow(() => assertReportingPayloadPrivacy(envelope.payload));
});

test("page and customer dimensions contain no contact fields", () => {
  const page = buildReportingEnvelope("page_dimension", {
    page_id: "page-1",
    page_name: "Page",
    operating_mode: "SHADOW",
    updated_at: "2026-07-29T10:03:00Z",
  });
  const customer = buildReportingEnvelope("customer_dimension", {
    id: "customer-row-1",
    page_id: "page-1",
    customer_id: "customer-1",
    display_name: "Khách",
    gender: "unknown",
    preferred_salutation: "anh/chị",
    phone: "0965499803",
    zalo: "0965499803",
    first_seen_at: "2026-07-29T09:00:00Z",
    last_seen_at: "2026-07-29T10:03:00Z",
    updated_at: "2026-07-29T10:03:00Z",
  });
  assert.equal(page.payload.page_id, "page-1");
  assert.doesNotMatch(JSON.stringify(customer), /0965499803|phone|zalo/);
});

test("reporting publisher and sync have separate startup gates", () => {
  const start = fs.readFileSync(new URL("../start.js", import.meta.url), "utf8");
  const coreGate = start.slice(start.indexOf("if (v9CoreReady) {"));
  assert.match(coreGate, /v9-reporting-publisher\.js/);
  const reportingGateStart = coreGate.indexOf("if (reportingReady) {");
  const reportingGateEnd = coreGate.indexOf("} else {", reportingGateStart);
  assert.ok(reportingGateStart >= 0 && reportingGateEnd > reportingGateStart);
  const reportingGate = coreGate.slice(reportingGateStart, reportingGateEnd);
  assert.match(reportingGate, /v9-reporting-sync-worker\.js/);
  assert.match(start, /AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY/);
});
