import { installReportRoutes as installV11ReportRoutes } from "./report-handler-v11.js";
import { installV10CoreAdminCompat } from "./v10-core-admin-compat.js";
import { installV10BridgeAdminRoutes } from "./v10-bridge-admin-routes.js";

export function installReportRoutes(app, options = {}) {
  installV10BridgeAdminRoutes(app, options);
  const result = installV11ReportRoutes(app, options);
  installV10CoreAdminCompat(app, options);
  return result;
}
