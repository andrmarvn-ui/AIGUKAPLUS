import fs from "node:fs";
import crypto from "node:crypto";
import { fetchPancakeConversationDetails, mergeConversationMessages } from "./pancake-live.js";
import { fetchMetaBusinessConversation } from "./meta-business-history.js";

export function installLearningAdminV2(app, { supabaseUrl, publishableKey, serviceRoleKey }) {
  const knowledgeBase = String(supabaseUrl || "").replace(/\/$/, "");
  const knowledgeServiceKey = serviceRoleKey || publishableKey;
  const coreBase = String(process.env.AIGUKA_V9_CORE_URL || "").replace(/\/$/, "");
  const coreKey = String(process.env.AIGUKA_V9_CORE_SERVICE_ROLE_KEY || "");

  function headers(token, admin = false) {
    return {
      apikey: token,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(admin ? {
        "x-aiguka-railway-test": "enabled",
        "x-aiguka-admin-secret": "AIGUKA_RAILWAY_TEST_MODE",
      } : {}),
    };
  }

  async function dbRequest(base, token, path, options = {}) {
    if (!base || !token) throw new Error("DATABASE_CONNECTION_NOT_READY");
    const response = await fetch(`${base}/rest/v1/${path}`, {
      method: options.method || "GET",
      headers: {
        ...headers(token, options.admin === true),
        Prefer: options.prefer || "return=representation",
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeout || 30_000),
      cache: "no-store",
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; }
    catch { data = { raw: raw.slice(0, 800) }; }
    if (!response.ok) throw new Error(data?.message || data?.error || data?.hint || `REST_HTTP_${response.status}`);
    return data;
  }

  const knowledgeRest = (path, options = {}) => dbRequest(knowledgeBase, knowledgeServiceKey, path, {
    ...options,
    admin: true,
  });

  async function knowledgeRpc(name, args = {}, useService = false) {
    const token = useService ? knowledgeServiceKey : publishableKey;
    if (!token) throw new Error(useService ? "MISSING_SUPABASE_SERVICE_ROLE_KEY" : "MISSING_SUPABASE_PUBLISHABLE_KEY");
    return dbRequest(knowledgeBase, token, `rpc/${name}`, {
      method: "POST",
      body: args,
      admin: true,
      timeout: 30_000,
    });
  }

  async function coreRpc(name, args = {}) {
    if (!coreBase || !coreKey) throw new Error("V10_CORE_CONNECTION_NOT_READY");
    return dbRequest(coreBase, coreKey, `rpc/${name}`, {
      method: "POST",
      body: args,
      timeout: 30_000,
    });
  }

  app.use("/learning-reviewed", app.json({ limit: "3mb" }));

  app.get("/learning-reviewed/api/conversations", async (req, res) => {
    const search = String(req.query.search || "").trim() || null;
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 500);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    try {
      let data;
      let fallbackWarning = null;
      try {
        data = await coreRpc("v10_learning_conversation_list", {
          p_search: search,
          p_limit: limit,
          p_offset: offset,
        });
      } catch (coreError) {
        data = await knowledgeRpc("v8_learning_conversation_list_test", {
          p_search: search,
          p_limit: limit,
          p_offset: offset,
        });
        fallbackWarning = `Core V10 chưa sẵn sàng; đang dùng V8 dự phòng: ${coreError.message}`;
        data = { ...data, data_source: "legacy_v8_fallback", warning: fallbackWarning };
      }
      res.json({ ok: true, ...data, warning: fallbackWarning || data?.warning || null });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/learning-reviewed/api/conversation", async (req, res) => {
    try {
      const pageId = String(req.query.page_id || "").trim();
      const senderId = String(req.query.sender_id || "").trim();
      if (!pageId || !senderId) throw new Error("PAGE_ID_AND_SENDER_ID_REQUIRED");

      let data;
      let coreError = null;
      try {
        data = await coreRpc("v10_learning_conversation_detail", {
          p_page_id: pageId,
          p_sender_id: senderId,
        });
      } catch (error) {
        coreError = error;
        data = await knowledgeRpc("v8_learning_conversation_detail_test", {
          p_page_id: pageId,
          p_sender_id: senderId,
        });
        data = { ...data, data_source: "legacy_v8_fallback" };
      }

      const dbMessages = data.events || data.messages || data.message_history || [];
      const identityRows = await knowledgeRest(
        `lt_conversation_identities?select=conversation_id,pancake_tags,pancake_employee,pancake_status,updated_at&page_id=eq.${encodeURIComponent(pageId)}&sender_id=eq.${encodeURIComponent(senderId)}&order=updated_at.desc&limit=1`,
      ).catch(() => []);
      const identity = identityRows?.[0] || null;

      let legacy = [];
      try {
        const rows = await knowledgeRest(
          `messages?page_id=eq.${encodeURIComponent(pageId)}&sender_id=eq.${encodeURIComponent(senderId)}&select=id,external_message_id,role,text,attachment_url,created_at,source,raw&order=created_at.asc&limit=1000`,
        );
        legacy = (rows || []).map((message) => ({
          id: `legacy:${message.external_message_id || message.id}`,
          message_id: message.external_message_id || message.id,
          direction: ["customer", "user"].includes(message.role) ? "inbound" : "outbound",
          role: message.role || "unknown",
          actor_type: message.role || "unknown",
          actor_name: message.role === "admin" ? "Nhân viên" : message.role === "bot" ? "BOT/AI" : message.role === "page" ? "Trang Facebook" : message.role === "system" ? "Hệ thống" : "Khách hàng",
          source_system: message.source || "legacy_messages",
          message_text: message.text || "",
          text: message.text || "",
          attachments: message.attachment_url ? [{ url: message.attachment_url }] : [],
          sent_at: message.created_at,
          created_at: message.created_at,
          raw_payload: message.raw || {},
        }));
      } catch {}

      const integrationRows = await knowledgeRest("v8_integration_runtime?integration_key=eq.pancake&select=*&limit=1").catch(() => []);
      const integration = integrationRows?.[0] || { connection_enabled: true, message_sync_enabled: true, status: "unknown" };
      const pancakeId = String(identity?.conversation_id || data.pancake_conversation_id || data.conversation_id || senderId);
      const customer = {
        ...(data.customer || {}),
        page_id: data.customer?.page_id || pageId,
        sender_id: data.customer?.sender_id || data.customer?.customer_id || senderId,
      };

      let pancake = { ok: false, messages: [], attempts: [], reason: "disabled" };
      if (integration.connection_enabled !== false && integration.message_sync_enabled !== false && pancakeId) {
        try {
          pancake = await fetchPancakeConversationDetails({
            conversationId: pancakeId,
            pageId,
            senderId,
            fallbackTime: customer.last_seen_at,
          });
        } catch (error) {
          pancake = { ok: false, messages: [], attempts: [], reason: error instanceof Error ? error.message : String(error) };
        }
      }

      let meta = { ok: false, messages: [], reason: "not_loaded" };
      try { meta = await fetchMetaBusinessConversation({ pageId, senderId }); }
      catch (error) { meta = { ok: false, messages: [], reason: error instanceof Error ? error.message : String(error) }; }

      const messages = mergeConversationMessages(
        mergeConversationMessages(
          mergeConversationMessages(dbMessages, legacy),
          meta.messages,
        ),
        pancake.messages,
      );

      let productDetection = data.product_detection || null;
      if (!productDetection) {
        try {
          const rows = await knowledgeRpc("v8_detect_conversation_product", {
            p_page_id: pageId,
            p_sender_id: senderId,
          }, true);
          productDetection = Array.isArray(rows) ? rows[0] || null : rows;
        } catch {}
      }

      res.json({
        ok: true,
        data: {
          ...data,
          customer,
          page_id: pageId,
          sender_id: senderId,
          pancake_conversation_id: pancakeId,
          pancake_tags: identity?.pancake_tags || data.pancake_tags || [],
          pancake_employee: identity?.pancake_employee || data.pancake_employee || null,
          pancake_status: identity?.pancake_status || data.pancake_status || null,
          pancake_url: data.pancake_url || "https://pancake.vn",
          meta_business_url: data.meta_business_url || `https://business.facebook.com/latest/inbox/all?asset_id=${encodeURIComponent(pageId)}&selected_item_id=${encodeURIComponent(senderId)}`,
          messages,
          db_message_count: dbMessages.length,
          pancake_message_count: pancake.messages.length,
          pancake_attempts: pancake.attempts,
          integration,
          legacy_message_count: legacy.length,
          meta_message_count: meta.messages.length,
          meta_history_status: meta.ok ? "ok" : meta.reason,
          product_detection: productDetection,
          core_v10_error: coreError?.message || null,
          data_source: data.data_source || (coreError ? "legacy_v8_fallback" : "core_v10"),
        },
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/learning-reviewed/api/integrations", async (_req, res) => {
    try {
      const rows = await knowledgeRest("v8_integration_runtime?select=*&order=integration_key.asc&limit=50");
      res.json({ ok: true, data: rows || [] });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.patch("/learning-reviewed/api/integrations", async (req, res) => {
    try {
      const body = req.body || {};
      const integrationKey = String(body.integration_key || "");
      if (integrationKey !== "pancake") throw new Error("INTEGRATION_NOT_SUPPORTED");
      const rows = await knowledgeRest("v8_integration_runtime?integration_key=eq.pancake", {
        method: "PATCH",
        body: {
          connection_enabled: body.connection_enabled !== false,
          message_sync_enabled: body.message_sync_enabled !== false,
          status: body.connection_enabled === false ? "disabled" : "enabled",
          last_error: null,
          last_checked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      });
      res.json({ ok: true, data: rows?.[0] || rows });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/learning-reviewed/api/sync", async (req, res) => {
    try {
      const body = req.body || {};
      const pageId = String(body.page_id || "");
      const senderId = String(body.sender_id || "");
      let data;
      let message;
      if (body.scope === "profile") {
        data = await knowledgeRpc("v8_dispatch_single_customer_profile_sync", {
          p_page_id: pageId,
          p_sender_id: senderId,
        }, true);
        message = "Đã yêu cầu cập nhật hồ sơ khách. Hội thoại chính vẫn đọc từ Core V10.";
      } else {
        data = await knowledgeRpc("v8_request_meta_sync", {
          p_scope: "conversation",
          p_limit: 1,
          p_page_id: pageId,
          p_sender_id: senderId,
          p_force: true,
          p_stale_minutes: 1,
          p_requested_by: "learning_admin_v10_manual",
        }, true);
        message = "Đã yêu cầu đồng bộ thủ công. Việc tải trang không còn tự chạy đồng bộ nặng.";
      }
      res.json({ ok: true, data, message });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/learning-reviewed/api/save", async (req, res) => {
    try {
      const body = req.body || {};
      const data = await knowledgeRpc("v8_learning_save_case_test", {
        p_page_id: body.page_id,
        p_sender_id: body.sender_id,
        p_conversation_id: body.conversation_id || null,
        p_source_message_id: body.source_message_id || null,
        p_source_message_text: body.source_message_text || "",
        p_original_reply_text: body.original_reply_text || null,
        p_improved_reply_text: body.improved_reply_text || "",
        p_intent_key: body.intent_key || null,
        p_product_group: body.product_group || null,
        p_context_snapshot: body.context_snapshot || {},
      }, true);
      res.json(data);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/learning-reviewed/api/prompts", async (_req, res) => {
    try {
      const [groups, inventory] = await Promise.all([
        knowledgeRest("v8_prompt_groups?select=*&order=sort_order.asc,group_name.asc&limit=500"),
        knowledgeRest("v8_prompt_inventory?select=*&order=priority.asc,updated_at.desc&limit=2000"),
      ]);
      const branches = (inventory || []).map((item) => ({
        id: item.id,
        source_type: item.source_type,
        branch_key: item.prompt_key,
        branch_name: item.prompt_name,
        prompt_group_key: item.prompt_group_key,
        group_name: item.group_name,
        trigger_description: [
          item.stage && `Giai đoạn: ${item.stage}`,
          item.intent_type && `Intent: ${item.intent_type}`,
          item.business_group_key && `Sản phẩm: ${item.business_group_key}`,
        ].filter(Boolean).join(" · "),
        instruction_text: item.prompt_text || "",
        example_customer_message: item.conditions?.example_customer_message || "",
        example_good_reply: item.conditions?.example_good_reply || "",
        priority: item.priority,
        is_active: item.is_active,
        conditions: item.conditions || {},
      }));
      res.json({ ok: true, groups: groups || [], branches });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/learning-reviewed/api/prompts", async (req, res) => {
    try {
      const body = req.body || {};
      const payload = {
        branch_key: `manual_${crypto.randomBytes(8).toString("hex")}`,
        branch_name: String(body.branch_name || "").trim(),
        prompt_group_key: body.prompt_group_key || null,
        trigger_description: body.trigger_description || null,
        conditions: {
          source: "manual_admin",
          example_customer_message: body.example_customer_message || null,
          example_good_reply: body.example_good_reply || null,
        },
        instruction_text: String(body.instruction_text || "").trim(),
        example_customer_message: body.example_customer_message || null,
        example_good_reply: body.example_good_reply || null,
        priority: Number(body.priority || 100),
        is_active: body.is_active !== false,
        created_by: "learning_admin_v2",
      };
      if (!payload.branch_name || !payload.instruction_text) throw new Error("PROMPT_NAME_AND_INSTRUCTION_REQUIRED");
      const rows = await knowledgeRest("v8_prompt_branches", { method: "POST", body: payload });
      res.json({ ok: true, data: rows?.[0] || rows });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.patch("/learning-reviewed/api/prompts", async (req, res) => {
    try {
      const body = req.body || {};
      const id = String(body.id || "");
      const source = String(body.source_type || "prompt_branch");
      if (!id) throw new Error("PROMPT_ID_REQUIRED");
      let rows;
      if (source === "reply_template") {
        rows = await knowledgeRest(`v8_reply_templates?id=eq.${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: {
            template_name: String(body.branch_name || "").trim(),
            prompt_group_key: body.prompt_group_key || null,
            body: String(body.instruction_text || ""),
            priority: Number(body.priority || 100),
            is_active: body.is_active !== false,
            updated_at: new Date().toISOString(),
          },
        });
      } else {
        rows = await knowledgeRest(`v8_prompt_branches?id=eq.${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: {
            branch_name: String(body.branch_name || "").trim(),
            prompt_group_key: body.prompt_group_key || null,
            trigger_description: body.trigger_description || null,
            instruction_text: String(body.instruction_text || "").trim(),
            example_customer_message: body.example_customer_message || null,
            example_good_reply: body.example_good_reply || null,
            conditions: {
              source: "manual_admin",
              example_customer_message: body.example_customer_message || null,
              example_good_reply: body.example_good_reply || null,
            },
            priority: Number(body.priority || 100),
            is_active: body.is_active !== false,
            updated_at: new Date().toISOString(),
          },
        });
      }
      res.json({ ok: true, data: rows?.[0] || rows });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.delete("/learning-reviewed/api/prompts", async (req, res) => {
    try {
      const id = String(req.query.id || "");
      const source = String(req.query.source_type || "prompt_branch");
      if (!id) throw new Error("PROMPT_ID_REQUIRED");
      const table = source === "reply_template" ? "v8_reply_templates" : "v8_prompt_branches";
      await knowledgeRest(`${table}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/learning-admin-v2-client.js", (_req, res) => {
    res.type("application/javascript").send(fs.readFileSync(new URL("./learning-admin-v2-client.js", import.meta.url), "utf8"));
  });
  app.get("/learning-reviewed", (_req, res) => {
    res.type("html").send(fs.readFileSync(new URL("./learning-admin-v2.html", import.meta.url), "utf8"));
  });
}
