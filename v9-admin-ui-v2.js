import { installV9AdminUi } from "./v9-admin-ui.js";

function enhance(html) {
  return String(html)
    .replace(
      "<td class=\"mono\">'+esc(r.page_id||'-')+'</td><td class=\"mono\">'+esc(r.ad_account_id||'-')+'</td>",
      "<td>'+esc(r.page_name||r.page_id||'-')+'</td><td>'+esc(r.ad_account_name||r.ad_account_id||'-')+'</td>",
    )
    .replace(
      "Reporting DB riêng chưa được kết nối. Giao diện đã sẵn sàng nhưng không fallback sang RPC V8 chậm.",
      "Reporting DB chưa kết nối. Báo cáo không quay lại RPC V8 chậm.",
    );
}

export function installV9AdminUiV2(app) {
  const routes = [];
  installV9AdminUi({
    get(path, handler) { routes.push({ path, handler }); },
  });

  for (const { path, handler } of routes) {
    app.get(path, (req, res) => {
      const send = res.send.bind(res);
      res.send = (body) => send(enhance(body));
      return handler(req, res);
    });
  }
}

export const __private__ = { enhance };
