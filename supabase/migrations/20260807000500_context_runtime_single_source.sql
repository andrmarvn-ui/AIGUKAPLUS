-- AIGUKA context runtime single-source pipeline.
-- Canonical editable source: v8_ai_contexts.
-- Runtime artifacts: ai_documents + immutable ai_published_snapshots.
-- Every relevant context save automatically compiles and publishes one ACTIVE snapshot.

create or replace function public.ai_publish_runtime_snapshot(
  p_created_by text default 'context_center_auto_publish'
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_content jsonb;
  v_checksum text;
  v_snapshot_id uuid;
  v_version_no bigint;
  v_source_versions jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('aiguka_ai_publish_runtime_snapshot'));

  -- Legacy migrations left the sequence behind existing rows. Align it before publishing.
  perform setval(
    'public.ai_published_snapshots_version_no_seq',
    greatest((select coalesce(max(version_no), 0) from public.ai_published_snapshots), 1),
    true
  );

  select jsonb_build_object(
    'documents', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.priority, d.document_key, d.version_no desc)
      from public.ai_documents d
      where d.status = 'published'
    ), '[]'::jsonb),
    'catalog', coalesce((
      select jsonb_agg(
        to_jsonb(n) || jsonb_build_object(
          'assets', coalesce((
            select jsonb_agg(jsonb_build_object(
              'asset_id', a.id,
              'provider', a.provider,
              'external_id', a.external_id,
              'source_url', a.source_url,
              'mime_type', a.mime_type,
              'sort_order', ca.sort_order,
              'role', ca.asset_role
            ) order by ca.sort_order, a.file_name)
            from public.ai_catalog_assets ca
            join public.ai_assets a on a.id = ca.asset_id and a.is_active
            where ca.catalog_key = n.catalog_key
          ), '[]'::jsonb)
        )
        order by n.catalog_key
      )
      from public.ai_catalog_nodes n
      where n.is_active
    ), '[]'::jsonb),
    'ad_mappings', coalesce((
      select jsonb_agg(to_jsonb(m) order by m.ad_account_id, m.campaign_id, m.adset_id, m.ad_id)
      from public.ai_ad_mappings m
      where m.is_active
    ), '[]'::jsonb),
    'quality_release', 'context_runtime_single_source_v1'
  ) into v_content;

  select jsonb_build_object(
    'source_of_truth', 'v8_ai_contexts',
    'context_versions', coalesce((
      select jsonb_object_agg(d.document_key, d.version_no order by d.document_key)
      from public.ai_documents d
      where d.status = 'published'
    ), '{}'::jsonb),
    'published_documents', (select count(*) from public.ai_documents where status = 'published'),
    'draft_documents_excluded', (select count(*) from public.ai_documents where status = 'draft'),
    'archived_documents_excluded', (select count(*) from public.ai_documents where status = 'archived'),
    'catalog_nodes', (select count(*) from public.ai_catalog_nodes where is_active),
    'assets', (select count(*) from public.ai_assets where is_active),
    'ad_mappings', (select count(*) from public.ai_ad_mappings where is_active),
    'published_at', now()
  ) into v_source_versions;

  v_checksum := encode(digest(v_content::text, 'sha256'), 'hex');

  select id into v_snapshot_id
  from public.ai_published_snapshots
  where checksum = v_checksum
  limit 1;

  if v_snapshot_id is null then
    v_version_no := nextval('public.ai_published_snapshots_version_no_seq');
    insert into public.ai_published_snapshots(
      id, version_no, checksum, content, status, source_versions, built_at, created_by, created_at
    ) values (
      gen_random_uuid(), v_version_no, v_checksum, v_content, 'published', v_source_versions, now(), p_created_by, now()
    )
    returning id into v_snapshot_id;
  else
    update public.ai_published_snapshots
    set content = v_content,
        status = 'published',
        source_versions = v_source_versions,
        built_at = now(),
        created_by = p_created_by
    where id = v_snapshot_id;
  end if;

  update public.ai_published_snapshots
  set status = 'retired'
  where id <> v_snapshot_id
    and status = 'published';

  update public.ai_runtime_config
  set published_snapshot_id = v_snapshot_id,
      mode = 'ACTIVE',
      cache_ttl_seconds = 30,
      settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object(
        'context_source_of_truth', 'v8_ai_contexts',
        'context_auto_publish', true,
        'context_runtime_pipeline', 'context_runtime_single_source_v1',
        'last_context_publish_at', now(),
        'last_context_publish_by', p_created_by
      ),
      updated_at = now()
  where id = 1;

  return v_snapshot_id;
end;
$$;

create or replace function public.ai_sync_context_to_runtime(
  p_context_id uuid,
  p_publish boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_context public.v8_ai_contexts%rowtype;
  v_status text;
  v_document_type text;
  v_created_at timestamptz;
  v_created_by text;
  v_snapshot_id uuid;
begin
  select * into v_context
  from public.v8_ai_contexts
  where id = p_context_id;

  if not found then
    return null;
  end if;

  v_status := case
    when not coalesce(v_context.is_active, false) then 'archived'
    when upper(coalesce(v_context.usage_mode, 'OFF')) = 'PRODUCTION' then 'published'
    else 'draft'
  end;

  v_document_type := case
    when lower(coalesce(v_context.source_type, '')) like '%prompt%' then 'system_prompt'
    when lower(coalesce(v_context.context_name, '')) like '%khuyến mãi%'
      or lower(coalesce(v_context.context_name, '')) like '%ưu đãi%'
      or lower(coalesce(v_context.context_name, '')) like '%event%'
      or coalesce(v_context.metadata ->> 'event_type', '') <> '' then 'promotion'
    when lower(coalesce(v_context.context_name, '')) like '%địa chỉ%'
      or lower(coalesce(v_context.context_name, '')) like '%showroom%' then 'location'
    when lower(coalesce(v_context.context_name, '')) like '%quy tắc%'
      or lower(coalesce(v_context.context_name, '')) like '%chính sách%' then 'business_policy'
    else 'context'
  end;

  select v.created_at, v.created_by
  into v_created_at, v_created_by
  from public.v8_ai_context_versions v
  where v.context_id = v_context.id
    and v.version_no = v_context.current_version
  limit 1;

  update public.ai_documents
  set status = 'archived'
  where document_key = v_context.context_key
    and status <> 'archived';

  insert into public.ai_documents(
    document_key, version_no, document_type, page_id, title, content,
    status, priority, metadata, created_by, created_at
  ) values (
    v_context.context_key,
    greatest(1, coalesce(v_context.current_version, 1)),
    v_document_type,
    v_context.page_id,
    v_context.context_name,
    coalesce(v_context.content, ''),
    v_status,
    coalesce(v_context.priority, 100),
    coalesce(v_context.metadata, '{}'::jsonb) || jsonb_build_object(
      'source_of_truth', 'v8_ai_contexts',
      'legacy_context_id', v_context.id,
      'legacy_source_type', v_context.source_type,
      'legacy_usage_mode', v_context.usage_mode,
      'context_updated_at', v_context.updated_at,
      'runtime_synced_at', now()
    ),
    coalesce(v_context.updated_by, v_created_by, v_context.created_by, 'context_center'),
    coalesce(v_created_at, v_context.updated_at, v_context.created_at, now())
  )
  on conflict(document_key, version_no) do update set
    document_type = excluded.document_type,
    page_id = excluded.page_id,
    title = excluded.title,
    content = excluded.content,
    status = excluded.status,
    priority = excluded.priority,
    metadata = excluded.metadata,
    created_by = excluded.created_by;

  if p_publish then
    v_snapshot_id := public.ai_publish_runtime_snapshot(
      coalesce(v_context.updated_by, v_context.created_by, 'context_center_auto_publish')
    );
  end if;

  return v_snapshot_id;
end;
$$;

create or replace function public.ai_context_runtime_sync_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.ai_sync_context_to_runtime(new.id, true);
  return new;
end;
$$;

drop trigger if exists trg_ai_context_runtime_publish_insert on public.v8_ai_contexts;
create trigger trg_ai_context_runtime_publish_insert
after insert on public.v8_ai_contexts
for each row execute function public.ai_context_runtime_sync_trigger();

drop trigger if exists trg_ai_context_runtime_publish_update on public.v8_ai_contexts;
create trigger trg_ai_context_runtime_publish_update
after update of context_key, context_name, page_id, source_type, content, usage_mode,
  priority, is_active, current_version, metadata
on public.v8_ai_contexts
for each row execute function public.ai_context_runtime_sync_trigger();

revoke all on function public.ai_publish_runtime_snapshot(text) from public, anon, authenticated;
revoke all on function public.ai_sync_context_to_runtime(uuid, boolean) from public, anon, authenticated;
revoke all on function public.ai_context_runtime_sync_trigger() from public, anon, authenticated;

do $$
declare
  r record;
begin
  for r in select id from public.v8_ai_contexts order by priority, context_key loop
    perform public.ai_sync_context_to_runtime(r.id, false);
  end loop;
  perform public.ai_publish_runtime_snapshot('migration_context_runtime_single_source_v1');
end;
$$;
