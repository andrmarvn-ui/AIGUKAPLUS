-- Legacy reporting-only view over ai_learning_document_versions.
-- The underlying learning data is archived into ai_documents by the next migration.
drop view if exists public.v8_learning_quality;
