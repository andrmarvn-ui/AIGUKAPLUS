-- Compatibility repair discovered during the 2026-08-08 Supabase cleanup.
-- A live Node compatibility reader still filters product_items by is_active every
-- five minutes, while the legacy table only exposes `enabled`. The table currently
-- has no rows. Keep one source of truth (`enabled`) and expose a generated read-only
-- alias so the old reader stops generating recurring Postgres errors without adding
-- another independently writable state field.

alter table if exists public.product_items
  add column if not exists is_active boolean
  generated always as (coalesce(enabled, true)) stored;
