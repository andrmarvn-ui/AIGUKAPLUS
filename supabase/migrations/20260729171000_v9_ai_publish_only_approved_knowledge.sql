-- Draft and archived documents must never enter the runtime knowledge snapshot.
-- Retire the previous import snapshot, publish a deterministic approved-only snapshot,
-- and remove all client access to the Knowledge tables.

revoke all on table public.ai_runtime_config from public,anon,authenticated;
revoke all on table public.ai_providers from public,anon,authenticated;
revoke all on table public.ai_drive_connections from public,anon,authenticated;
revoke all on table public.ai_documents from public,anon,authenticated;
revoke all on table public.ai_catalog_nodes from public,anon,authenticated;
revoke all on table public.ai_assets from public,anon,authenticated;
revoke all on table public.ai_catalog_assets from public,anon,authenticated;
revoke all on table public.ai_ad_mappings from public,anon,authenticated;
revoke all on table public.ai_published_snapshots from public,anon,authenticated;
revoke all on sequence public.ai_published_snapshots_version_no_seq from public,anon,authenticated;

update public.ai_published_snapshots
set status='retired'
where status='published';

with snapshot_content as (
  select jsonb_build_object(
    'documents',coalesce((
      select jsonb_agg(to_jsonb(d) order by d.priority,d.document_key,d.version_no)
      from public.ai_documents d
      where d.status='published'
    ),'[]'::jsonb),
    'catalog',coalesce((
      select jsonb_agg(
        to_jsonb(n)||jsonb_build_object('assets',coalesce((
          select jsonb_agg(jsonb_build_object(
            'asset_id',a.id,
            'provider',a.provider,
            'external_id',a.external_id,
            'source_url',a.source_url,
            'mime_type',a.mime_type,
            'sort_order',ca.sort_order,
            'role',ca.asset_role
          ) order by ca.sort_order,a.file_name)
          from public.ai_catalog_assets ca
          join public.ai_assets a on a.id=ca.asset_id and a.is_active
          where ca.catalog_key=n.catalog_key
        ),'[]'::jsonb))
        order by n.catalog_key
      )
      from public.ai_catalog_nodes n
      where n.is_active
    ),'[]'::jsonb),
    'ad_mappings',coalesce((
      select jsonb_agg(to_jsonb(m) order by m.ad_account_id,m.campaign_id,m.adset_id,m.ad_id)
      from public.ai_ad_mappings m
      where m.is_active
    ),'[]'::jsonb)
  ) content
), inserted as (
  insert into public.ai_published_snapshots(
    checksum,content,status,source_versions,created_by
  )
  select
    encode(digest(content::text,'sha256'),'hex'),
    content,
    'published',
    jsonb_build_object(
      'published_documents',(select count(*) from public.ai_documents where status='published'),
      'draft_documents_excluded',(select count(*) from public.ai_documents where status='draft'),
      'archived_documents_excluded',(select count(*) from public.ai_documents where status='archived'),
      'catalog_nodes',(select count(*) from public.ai_catalog_nodes where is_active),
      'assets',(select count(*) from public.ai_assets where is_active),
      'ad_mappings',(select count(*) from public.ai_ad_mappings where is_active)
    ),
    'v9_publish_approved_only'
  from snapshot_content
  on conflict(checksum) do update set
    status='published',
    source_versions=excluded.source_versions,
    created_by=excluded.created_by
  returning id
)
update public.ai_runtime_config
set published_snapshot_id=(select id from inserted limit 1),
    mode='SHADOW',
    updated_at=now()
where id=1;
