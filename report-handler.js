import { installReportRoutes as installV11ReportRoutes } from "./report-handler-v11.js";
import { installV10CoreAdminCompat } from "./v10-core-admin-compat.js";

export function installReportRoutes(app, options = {}) {
  const result = installV11ReportRoutes(app, options);
  installV10CoreAdminCompat(app, options);
  return result;
}
