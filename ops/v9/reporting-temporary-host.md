# V9 Reporting temporary host

Until a dedicated Supabase Reporting project is provisioned, V9 Reporting uses the existing AIGUKA Knowledge project as a temporary host. Core remains isolated.

Runtime resolution:
- explicit `AIGUKA_V9_REPORTING_URL` / `AIGUKA_V9_REPORTING_SERVICE_ROLE_KEY` always wins;
- otherwise server-side V9 reporting may use `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` as the temporary reporting host;
- no browser key or raw credential is exposed;
- no fallback to V8 report RPCs or raw-message scans is allowed.

The temporary host contains the same 13-table Reporting schema and can be migrated without changing the V9 Admin UI or API contract.
