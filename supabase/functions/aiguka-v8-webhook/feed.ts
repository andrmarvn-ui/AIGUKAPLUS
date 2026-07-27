export type J = Record<string, any>;
const txt = (v: any) => v == null ? null : (String(v).trim() || null);
const eventTime = (v: any) => {
  const n = Number(v || Date.now());
  return new Date(n < 10_000_000_000 ? n * 1000 : n).toISOString();
};

export async function processFeedChange(
  c: any,
  audit: (row: J) => Promise<void>,
  postId: string,
  pageId: string,
  change: J,
  counters: J,
) {
  const value = change?.value || {};
  const field = txt(change?.field) || "unknown";
  const item = txt(value.item);
  const verb = txt(value.verb);
  const commentId = txt(value.comment_id) || (item === "comment" ? txt(value.post_id) : null);

  if (field !== "feed" || item !== "comment" || !commentId) {
    counters.skipped += 1;
    await audit({ request_id: `${postId}:change:${counters.skipped}` });
    return;
  }

  if (verb === "remove" || verb === "hide") {
    await c.from("v8_comment_events").update({
      lead_status: "removed",
      private_reply_status: "cancelled",
      updated_at: new Date().toISOString(),
    }).eq("page_id", pageId).eq("comment_id", commentId);
    counters.comments += 1;
    return;
  }

  if (verb !== "add" && verb !== "edited") {
    counters.skipped += 1;
    return;
  }

  const payload = {
    p_page_id: pageId,
    p_comment_id: commentId,
    p_parent_id: txt(value.parent_id),
    p_post_id: txt(value.post_id),
    p_sender_id: txt(value.from?.id),
    p_sender_name: txt(value.from?.name),
    p_message_text: txt(value.message),
    p_event_time: eventTime(value.created_time),
    p_verb: verb,
    p_item_type: item,
    p_raw_payload: { field, value },
  };

  const { error } = await c.rpc("v8_register_comment_event", payload);
  if (error) {
    counters.failed += 1;
    console.error("COMMENT_REGISTER_FAILED", error.message);
    return;
  }
  counters.comments += 1;
}
