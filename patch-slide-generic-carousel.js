import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "drive-slide-manager-v4.js";
let source = fs.readFileSync(file, "utf8");
const marker = "AIGUKA_MESSENGER_GENERIC_CAROUSEL_V1";

if (source.includes(marker)) {
  console.log("[AIGUKA] Messenger generic carousel already installed");
} else {
  const oldBlock = `      const results = [];
      for (const asset of assets) {
        const imageUrl = \`${'${requestOrigin(req)}'}/api/slide-manager/image/${'${asset.id}'}\`;
        const response = await fetch(\`https://graph.facebook.com/v23.0/${'${encodeURIComponent(pageId)}'}/messages?access_token=${'${encodeURIComponent(token)}'}\`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ recipient: { id: recipient }, messaging_type: "RESPONSE", message: { attachment: { type: "image", payload: { url: imageUrl, is_reusable: true } } } }),
          signal: AbortSignal.timeout(30000),
        });
        const data = await response.json().catch(() => ({}));
        let error = data.error?.message || \`META_${'${response.status}'}\`;
        if (Number(data.error?.code) === 230 || /pages_messaging/i.test(error)) error = "Kết nối Facebook chưa có quyền pages_messaging. Hãy kết nối lại Facebook rồi thử lại.";
        if (/cannot send messages to this id/i.test(error)) error = "PSID không thuộc Page đã chọn.";
        if (/outside.*24|24.hour|messaging window/i.test(error)) error = "Khách đã ngoài cửa sổ nhắn tin 24 giờ.";
        results.push(response.ok ? { ok: true, file_name: asset.file_name, message_id: data.message_id } : { ok: false, file_name: asset.file_name, error, meta_code: data.error?.code || null });
      }
      const success = results.filter((item) => item.ok).length;
      res.json({ ok: true, all_sent: success === results.length, total: results.length, success_count: success, failure_count: results.length - success, results });`;

  const newBlock = `      // AIGUKA_MESSENGER_GENERIC_CAROUSEL_V1
      const preparedAssets = await prepareCarouselAssets(assets.slice(0, 10), {
        fetchImpl: fetch,
        timeoutMs: 15000,
      });
      const slideElements = preparedAssets.map((asset, index) => {
        const imageUrl = asset.source_url;
        const ordinal = String(index + 1).padStart(2, "0");
        const titleBase = clean(mapping.slide_title || mapping.product_name || "Mẫu sản phẩm");
        const title = \`${'${titleBase}'} — Mẫu ${'${ordinal}'}\`.slice(0, 80);
        const subtitle = clean(asset.file_name || \`Mẫu ${'${ordinal}'}\`).slice(0, 80);
        return {
          title,
          image_url: imageUrl,
          subtitle,
          default_action: {
            type: "web_url",
            url: imageUrl,
            webview_height_ratio: "full",
          },
          buttons: [
            {
              type: "web_url",
              url: "https://zalo.me/0989882690",
              title: "Báo giá",
              webview_height_ratio: "tall",
            },
          ],
        };
      });
      const response = await fetch(\`https://graph.facebook.com/v23.0/${'${encodeURIComponent(pageId)}'}/messages?access_token=${'${encodeURIComponent(token)}'}\`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipient },
          messaging_type: "RESPONSE",
          message: {
            attachment: {
              type: "template",
              payload: {
                template_type: "generic",
                image_aspect_ratio: "square",
                elements: slideElements,
              },
            },
          },
        }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await response.json().catch(() => ({}));
      let error = data.error?.message || \`META_${'${response.status}'}\`;
      if (Number(data.error?.code) === 230 || /pages_messaging/i.test(error)) error = "Kết nối Facebook chưa có quyền pages_messaging. Hãy kết nối lại Facebook rồi thử lại.";
      if (/cannot send messages to this id/i.test(error)) error = "PSID không thuộc Page đã chọn.";
      if (/outside.*24|24.hour|messaging window/i.test(error)) error = "Khách đã ngoài cửa sổ nhắn tin 24 giờ.";
      if (!response.ok) {
        res.status(400).json({ ok: false, code: "META_GENERIC_TEMPLATE_FAILED", error, meta_code: data.error?.code || null, slide_count: slideElements.length });
        return;
      }
      res.json({
        ok: true,
        all_sent: true,
        delivery_type: "generic_template",
        message_count: 1,
        slide_count: slideElements.length,
        media_source: "supabase_storage_static",
        preflight_count: preparedAssets.length,
        message_id: data.message_id || null,
        recipient_id: data.recipient_id || recipient,
      });`;

  if (!source.includes(oldBlock)) throw new Error("GENERIC_CAROUSEL_SEND_BLOCK_NOT_FOUND");
  source = source.replace(oldBlock, newBlock);

  const oldUi = `$('test-result').innerHTML='<b>Đã gửi '+j.success_count+'/'+j.total+' ảnh</b><br>'+j.results.map(x=>(x.ok?'✅ ':'❌ ')+E(x.file_name)+(x.error?' — '+E(x.error):'')).join('<br>');status(j.all_sent?'Gửi thử thành công.':'Có ảnh lỗi.',j.all_sent)`;
  const newUi = `$('test-result').innerHTML='<b>Đã gửi 1 slide ngang gồm '+E(j.slide_count||0)+' thẻ ảnh.</b><br><span class="muted">Khách kéo ngang để xem; hội thoại chỉ phát sinh một tin nhắn.</span>';status('Gửi slide thành công.',true)`;
  if (!source.includes(oldUi)) throw new Error("GENERIC_CAROUSEL_UI_BLOCK_NOT_FOUND");
  source = source.replace(oldUi, newUi);

  source = source.replace(
    '<div id="test-result" class="card" style="margin-top:12px">Chưa chạy thử.</div>',
    '<div id="test-result" class="card" style="margin-top:12px">Chưa chạy thử. Khi gửi thành công, toàn bộ ảnh sẽ nằm trong một carousel kéo ngang.</div>',
  );

  fs.writeFileSync(file, source, "utf8");
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(`GENERIC_CAROUSEL_SYNTAX:${syntax.stderr || syntax.stdout}`);
  console.log("[AIGUKA] Test slide now sends one Messenger generic carousel");
}
