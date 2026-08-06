import fs from "node:fs";

const file = "v10-outbound-worker.js";
const MARK = "AIGUKA_V10_OUTBOUND_REPLY_ORDER_V1";
if (!fs.existsSync(file)) throw new Error("V10_OUTBOUND_REPLY_ORDER_WORKER_MISSING");
let source = fs.readFileSync(file, "utf8");

if (!source.includes(MARK)) {
  const finalGateTarget = "async function finalGate(decision, config) {";
  if (!source.includes(finalGateTarget)) throw new Error("V10_OUTBOUND_REPLY_ORDER_FINAL_GATE_TARGET_MISSING");
  const helper = String.raw`function pageReplyAfterLatestCustomerInOrder(messages = []) {
  let latestCustomerIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index] && messages[index].role === "customer") {
      latestCustomerIndex = index;
      break;
    }
  }
  if (latestCustomerIndex < 0) return false;
  return messages.slice(latestCustomerIndex + 1).some(function (message) {
    return message && ["human", "bot", "automation", "page"].includes(message.role);
  });
}

// ${MARK}

`;
  source = source.replace(finalGateTarget, helper + finalGateTarget);

  const snapshotTarget = '  if (conversation?.safety?.verified_page_reply_after_latest_customer) return { allowed: false, reason: "PAGE_ALREADY_REPLIED" };';
  const snapshotReplacement = '  const snapshotPageReplyAfterLatestCustomer = pageReplyAfterLatestCustomerInOrder(conversation?.messages || []);';
  if (!source.includes(snapshotTarget)) throw new Error("V10_OUTBOUND_REPLY_ORDER_SNAPSHOT_TARGET_MISSING");
  source = source.replace(snapshotTarget, snapshotReplacement);

  const stateTarget = '  if (customerAt > 0 && Number.isFinite(pageAt) && pageAt >= customerAt) return { allowed: false, reason: "PAGE_ALREADY_REPLIED" };';
  const stateReplacement = `  const pageClearlyAfterCustomer = customerAt > 0 && Number.isFinite(pageAt) && pageAt > customerAt + 1000;\n  const pageOrderedAfterCustomer = customerAt > 0 && Number.isFinite(pageAt) && pageAt >= customerAt && snapshotPageReplyAfterLatestCustomer;\n  if (pageClearlyAfterCustomer || pageOrderedAfterCustomer) return { allowed: false, reason: "PAGE_ALREADY_REPLIED" };`;
  if (!source.includes(stateTarget)) throw new Error("V10_OUTBOUND_REPLY_ORDER_STATE_TARGET_MISSING");
  source = source.replace(stateTarget, stateReplacement);

  fs.writeFileSync(file, source, "utf8");
  console.log("[AIGUKA V10] outbound reply-order guard enabled: new customer messages override earlier page replies");
}
