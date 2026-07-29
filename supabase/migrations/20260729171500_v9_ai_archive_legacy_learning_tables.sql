-- Preserve legacy learning uploads and settings without allowing them into runtime snapshots.
-- All imported learning documents remain draft until explicitly reviewed and published.

insert into public.ai_documents(
  id,document_key,version_no,document_type,page_id,title,content,status,
  priority,metadata,created_by,created_at
)
select
  v.id,
  'learning_'||d.id::text,
  v.version_no,
  'other',
  null,
  d.title,
  coalesce(nullif(v.extracted_text,''),nullif(d.description,''),d.title),
  'draft',
  500,
  coalesce(d.metadata,'{}'::jsonb)||coalesce(v.metadata,'{}'::jsonb)||jsonb_build_object(
    'legacy_learning_document_id',d.id,
    'legacy_source_type',d.source_type,
    'legacy_product_group',d.product_group,
    'legacy_status',d.status,
    'storage_bucket',d.storage_bucket,
    'storage_path',coalesce(v.storage_path,d.storage_path),
    'original_filename',d.original_filename,
    'mime_type',d.mime_type,
    'file_size_bytes',d.file_size_bytes,
    'checksum_sha256',coalesce(v.checksum_sha256,d.checksum_sha256),
    'parser_name',v.parser_name,
    'parser_version',v.parser_version,
    'extraction_status',v.extraction_status,
    'extraction_error',v.extraction_error,
    'indexed_at',v.indexed_at,
    'requires_review',true
  ),
  'v9_archive_legacy_learning',
  coalesce(v.created_at,d.created_at)
from public.ai_learning_documents d
join public.ai_learning_document_versions v on v.document_id=d.id
on conflict(document_key,version_no) do update set
  title=excluded.title,
  content=excluded.content,
  status='draft',
  metadata=excluded.metadata;

insert into public.ai_documents(
  id,document_key,version_no,document_type,page_id,title,content,status,
  priority,metadata,created_by,created_at
)
select
  d.id,
  'learning_'||d.id::text,
  1,
  'other',
  null,
  d.title,
  coalesce(nullif(d.description,''),d.title),
  'draft',
  500,
  coalesce(d.metadata,'{}'::jsonb)||jsonb_build_object(
    'legacy_learning_document_id',d.id,
    'legacy_source_type',d.source_type,
    'legacy_product_group',d.product_group,
    'legacy_status',d.status,
    'storage_bucket',d.storage_bucket,
    'storage_path',d.storage_path,
    'original_filename',d.original_filename,
    'mime_type',d.mime_type,
    'file_size_bytes',d.file_size_bytes,
    'checksum_sha256',d.checksum_sha256,
    'requires_review',true
  ),
  'v9_archive_legacy_learning',
  d.created_at
from public.ai_learning_documents d
where not exists(
  select 1 from public.ai_learning_document_versions v where v.document_id=d.id
)
on conflict(document_key,version_no) do update set
  title=excluded.title,
  content=excluded.content,
  status='draft',
  metadata=excluded.metadata;

update public.ai_runtime_config
set settings=settings||jsonb_build_object(
  'legacy_learning_settings',coalesce((
    select jsonb_object_agg(setting_key,jsonb_build_object(
      'value',setting_value,
      'schema_version',schema_version,
      'updated_at',updated_at,
      'updated_by',updated_by
    ) order by setting_key)
    from public.ai_learning_settings
  ),'{}'::jsonb),
  'legacy_learning_archived_at',now()
),
updated_at=now()
where id=1;

-- Guard against accidental loss before dropping the old tables.
do $$
declare
  source_documents integer;
  archived_documents integer;
  source_settings integer;
  archived_settings integer;
begin
  select count(*) into source_documents from public.ai_learning_documents;
  select count(distinct document_key) into archived_documents
  from public.ai_documents where document_key like 'learning_%';
  select count(*) into source_settings from public.ai_learning_settings;
  select count(*) into archived_settings
  from jsonb_object_keys(coalesce((
    select settings->'legacy_learning_settings'
    from public.ai_runtime_config where id=1
  ),'{}'::jsonb));
  if archived_documents <> source_documents then
    raise exception 'V9_LEARNING_ARCHIVE_DOCUMENT_COUNT_MISMATCH source=% archived=%',source_documents,archived_documents;
  end if;
  if archived_settings <> source_settings then
    raise exception 'V9_LEARNING_ARCHIVE_SETTING_COUNT_MISMATCH source=% archived=%',source_settings,archived_settings;
  end if;
end $$;

drop table public.ai_learning_document_versions;
drop table public.ai_learning_documents;
drop table public.ai_learning_settings;
drop table public.aiguka_config_hub;
drop function if exists public.set_aiguka_config_hub_updated_at();
