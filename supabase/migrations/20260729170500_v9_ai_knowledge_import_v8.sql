-- Copy essential reusable configuration from V8 into the clean V9 AI Knowledge schema.
-- This migration is idempotent and deliberately does not delete legacy data.

insert into public.ai_providers(
  provider_key,provider_name,provider_type,base_url,model_name,
  api_key_ciphertext,api_key_hint,is_enabled,connection_status,settings,
  last_verified_at,last_error,created_at,updated_at
)
select
  provider_key,
  provider_name,
  coalesce(provider_type,'openai_compatible'),
  base_url,
  model_name,
  api_key_ciphertext,
  api_key_hint,
  is_enabled,
  coalesce(connection_status,'unknown'),
  coalesce(settings,'{}'::jsonb) || jsonb_build_object(
    'legacy_mode',mode,
    'available_models',coalesce(available_models,'[]'::jsonb),
    'api_key_secret_name',api_key_secret_name
  ),
  coalesce(last_success_at,last_checked_at),
  last_error,
  created_at,
  updated_at
from public.v8_ai_providers
on conflict(provider_key) do update set
  provider_name=excluded.provider_name,
  provider_type=excluded.provider_type,
  base_url=excluded.base_url,
  model_name=excluded.model_name,
  api_key_ciphertext=excluded.api_key_ciphertext,
  api_key_hint=excluded.api_key_hint,
  is_enabled=excluded.is_enabled,
  connection_status=excluded.connection_status,
  settings=excluded.settings,
  last_verified_at=excluded.last_verified_at,
  last_error=excluded.last_error,
  updated_at=excluded.updated_at;

insert into public.ai_drive_connections(
  connection_key,client_id,client_secret_ciphertext,client_secret_hint,
  access_token_ciphertext,refresh_token_ciphertext,token_type,scope,
  token_expires_at,root_folder_id,account_email,account_name,is_enabled,
  connection_status,metadata,last_verified_at,last_error,created_at,updated_at
)
select
  connection_key,client_id,client_secret_ciphertext,client_secret_hint,
  access_token_ciphertext,refresh_token_ciphertext,token_type,scope,
  token_expires_at,root_folder_id,account_email,account_name,is_enabled,
  coalesce(connection_status,'unknown'),coalesce(metadata,'{}'::jsonb),
  last_checked_at,last_error,created_at,updated_at
from public.v8_google_drive_connections
on conflict(connection_key) do update set
  client_id=excluded.client_id,
  client_secret_ciphertext=excluded.client_secret_ciphertext,
  client_secret_hint=excluded.client_secret_hint,
  access_token_ciphertext=excluded.access_token_ciphertext,
  refresh_token_ciphertext=excluded.refresh_token_ciphertext,
  token_type=excluded.token_type,
  scope=excluded.scope,
  token_expires_at=excluded.token_expires_at,
  root_folder_id=excluded.root_folder_id,
  account_email=excluded.account_email,
  account_name=excluded.account_name,
  is_enabled=excluded.is_enabled,
  connection_status=excluded.connection_status,
  metadata=excluded.metadata,
  last_verified_at=excluded.last_verified_at,
  last_error=excluded.last_error,
  updated_at=excluded.updated_at;

insert into public.ai_documents(
  id,document_key,version_no,document_type,page_id,title,content,status,
  priority,metadata,created_by,created_at
)
select
  v.id,
  coalesce(c.context_key,'legacy_context_'||v.context_id::text),
  v.version_no,
  case
    when lower(coalesce(v.source_type,'')) like '%prompt%' then 'system_prompt'
    when lower(v.context_name) like '%khuyến mãi%' or lower(v.context_name) like '%ưu đãi%' then 'promotion'
    when lower(v.context_name) like '%địa chỉ%' or lower(v.context_name) like '%showroom%' then 'location'
    when lower(v.context_name) like '%quy tắc%' or lower(v.context_name) like '%chính sách%' then 'business_policy'
    else 'context'
  end,
  v.page_id,
  v.context_name,
  v.content,
  case
    when v.is_active is false then 'archived'
    when upper(coalesce(v.usage_mode,''))='PRODUCTION' then 'published'
    else 'draft'
  end,
  coalesce(v.priority,100),
  coalesce(v.metadata,'{}'::jsonb) || jsonb_build_object(
    'legacy_context_id',v.context_id,
    'legacy_source_type',v.source_type,
    'legacy_usage_mode',v.usage_mode,
    'legacy_change_note',v.change_note
  ),
  v.created_by,
  v.created_at
from public.v8_ai_context_versions v
left join public.v8_ai_contexts c on c.id=v.context_id
on conflict(document_key,version_no) do update set
  document_type=excluded.document_type,
  page_id=excluded.page_id,
  title=excluded.title,
  content=excluded.content,
  status=excluded.status,
  priority=excluded.priority,
  metadata=excluded.metadata,
  created_by=excluded.created_by;

-- Insert catalog and business group nodes without parent references first.
insert into public.ai_catalog_nodes(
  catalog_key,parent_key,root_key,display_name,node_type,asset_policy,metadata,is_active,created_at,updated_at
)
select
  c.catalog_key,
  null,
  coalesce(c.root_product_key,c.catalog_key),
  c.catalog_name,
  case when c.parent_key is null then 'root' else 'product_group' end,
  jsonb_build_object(
    'drive_folder_id',c.drive_folder_id,
    'drive_folder_url',c.drive_folder_url,
    'folder_path',c.folder_path,
    'is_sendable',c.is_sendable
  ),
  coalesce(c.metadata,'{}'::jsonb) || jsonb_build_object('legacy_level_no',c.level_no),
  c.is_active,
  c.created_at,
  c.updated_at
from public.v8_product_catalog c
on conflict(catalog_key) do update set
  root_key=excluded.root_key,
  display_name=excluded.display_name,
  node_type=excluded.node_type,
  asset_policy=excluded.asset_policy,
  metadata=excluded.metadata,
  is_active=excluded.is_active,
  updated_at=excluded.updated_at;

insert into public.ai_catalog_nodes(
  catalog_key,parent_key,root_key,display_name,node_type,metadata,is_active,created_at,updated_at
)
select
  g.group_key,null,g.group_key,g.group_name,'product_group',
  coalesce(g.metadata,'{}'::jsonb) || jsonb_build_object(
    'description',g.description,
    'priority',g.priority,
    'auto_sync',g.auto_sync,
    'season_tag',g.season_tag,
    'valid_from',g.valid_from,
    'valid_to',g.valid_to
  ),
  g.is_active,g.created_at,g.updated_at
from public.v8_business_product_groups g
on conflict(catalog_key) do update set
  display_name=excluded.display_name,
  metadata=public.ai_catalog_nodes.metadata||excluded.metadata,
  is_active=excluded.is_active,
  updated_at=excluded.updated_at;

-- Create fallback nodes referenced only by rules/assets/mappings.
insert into public.ai_catalog_nodes(catalog_key,root_key,display_name,node_type,metadata,is_active)
select key,key,coalesce(max(name),key),'product_group',jsonb_build_object('source','legacy_fallback'),true
from (
  select nullif(product_key,'') key,max(product_name) name from public.v8_product_rules group by product_key
  union all
  select nullif(coalesce(catalog_key,product_key),'') key,max(product_name) name from public.v8_drive_assets group by coalesce(catalog_key,product_key)
  union all
  select nullif(product_key,'') key,max(product_name) name from public.v8_slide_mapping group by product_key
) s
where key is not null
group by key
on conflict(catalog_key) do nothing;

update public.ai_catalog_nodes n
set parent_key=c.parent_key
from public.v8_product_catalog c
where n.catalog_key=c.catalog_key
  and c.parent_key is not null
  and exists(select 1 from public.ai_catalog_nodes p where p.catalog_key=c.parent_key);

with aliases as (
  select catalog_key,array_agg(distinct alias order by alias) filter(where alias is not null and btrim(alias)<>'') values
  from (
    select catalog_key,alias from public.v8_product_aliases where is_active
    union all
    select group_key,alias from public.v8_business_group_aliases where is_active
  ) a
  group by catalog_key
)
update public.ai_catalog_nodes n
set aliases=a.values
from aliases a
where a.catalog_key=n.catalog_key;

with rules as (
  select product_key,jsonb_agg(jsonb_build_object(
    'keyword',keyword,
    'match_type',match_type,
    'priority',priority,
    'confidence',confidence,
    'note',note
  ) order by priority desc,keyword) filter(where is_active) values
  from public.v8_product_rules
  group by product_key
)
update public.ai_catalog_nodes n
set rules=coalesce(r.values,'[]'::jsonb)
from rules r
where r.product_key=n.catalog_key;

with group_map as (
  select catalog_key,jsonb_agg(jsonb_build_object(
    'group_key',group_key,
    'root_product_key',root_product_key,
    'folder_path_pattern',folder_path_pattern,
    'mapping_source',mapping_source,
    'priority',priority
  ) order by priority desc) filter(where is_active) values
  from public.v8_business_group_mappings
  group by catalog_key
)
update public.ai_catalog_nodes n
set metadata=n.metadata||jsonb_build_object('business_group_mappings',g.values)
from group_map g
where g.catalog_key=n.catalog_key;

insert into public.ai_assets(
  id,provider,external_id,folder_id,file_name,mime_type,source_url,file_size,
  metadata,is_active,last_synced_at,created_at,updated_at
)
select
  id,'google_drive',drive_file_id,parent_folder_id,file_name,mime_type,
  coalesce(delivery_url,file_url),file_size,
  coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
    'legacy_product_key',product_key,
    'legacy_catalog_key',catalog_key,
    'product_name',product_name,
    'parent_folder_name',parent_folder_name,
    'parent_folder_url',parent_folder_url,
    'root_folder_url',root_folder_url,
    'sort_order',sort_order,
    'delivery_status',delivery_status,
    'delivery_content_type',delivery_content_type
  ),
  is_active,last_seen_at,first_seen_at,coalesce(modified_time,last_seen_at,now())
from public.v8_drive_assets
where drive_file_id is not null
on conflict(provider,external_id) do update set
  folder_id=excluded.folder_id,
  file_name=excluded.file_name,
  mime_type=excluded.mime_type,
  source_url=excluded.source_url,
  file_size=excluded.file_size,
  metadata=excluded.metadata,
  is_active=excluded.is_active,
  last_synced_at=excluded.last_synced_at,
  updated_at=excluded.updated_at;

insert into public.ai_catalog_assets(catalog_key,asset_id,asset_role,sort_order,metadata)
select
  coalesce(d.catalog_key,d.product_key),
  a.id,
  'slide',
  coalesce(d.sort_order,0),
  jsonb_build_object('source','v8_drive_assets')
from public.v8_drive_assets d
join public.ai_assets a on a.provider='google_drive' and a.external_id=d.drive_file_id
join public.ai_catalog_nodes n on n.catalog_key=coalesce(d.catalog_key,d.product_key)
where d.is_active and d.drive_file_id is not null
on conflict(catalog_key,asset_id,asset_role) do update set
  sort_order=excluded.sort_order,
  metadata=excluded.metadata;

insert into public.ai_assets(
  provider,external_id,folder_id,file_name,source_url,metadata,is_active,last_synced_at
)
select
  'legacy_slide',id::text,drive_folder_id,coalesce(slide_title,product_name),slide_url,
  jsonb_build_object(
    'page_id',page_id,
    'product_key',product_key,
    'drive_folder_url',drive_folder_url,
    'drive_folder_ids',drive_folder_ids,
    'sync_mode',sync_mode,
    'sync_status',sync_status,
    'note',note
  ),
  is_active,last_synced_at
from public.v8_slide_mapping
where slide_url is not null or drive_folder_id is not null
on conflict(provider,external_id) do update set
  folder_id=excluded.folder_id,
  file_name=excluded.file_name,
  source_url=excluded.source_url,
  metadata=excluded.metadata,
  is_active=excluded.is_active,
  last_synced_at=excluded.last_synced_at;

insert into public.ai_catalog_assets(catalog_key,asset_id,asset_role,sort_order,metadata)
select
  s.product_key,a.id,'slide',coalesce(s.priority,0),jsonb_build_object('source','v8_slide_mapping','page_id',s.page_id)
from public.v8_slide_mapping s
join public.ai_assets a on a.provider='legacy_slide' and a.external_id=s.id::text
join public.ai_catalog_nodes n on n.catalog_key=s.product_key
where s.is_active
on conflict(catalog_key,asset_id,asset_role) do update set
  sort_order=excluded.sort_order,
  metadata=excluded.metadata;

insert into public.ai_ad_mappings(
  page_id,ad_account_id,campaign_id,adset_id,ad_id,catalog_keys,
  confidence,source,is_active,metadata,created_at,updated_at
)
select
  '*',
  ad_account_id,
  campaign_id,
  adset_id,
  ad_id,
  array_remove(array[
    nullif(product_item_key,''),
    nullif(product_group,''),
    nullif(product_type,''),
    nullif(carousel_key,'')
  ],null),
  1,
  'v8_ad_mappings',
  coalesce(is_active,enabled,true),
  jsonb_build_object(
    'campaign_name',campaign_name,
    'adset_name',adset_name,
    'ad_name',ad_name,
    'product_name',product_name,
    'recognition_name',recognition_name,
    'selected_folders',selected_folders,
    'drive_folders',drive_folders,
    'main_folder',main_folder,
    'product_drive_path',product_drive_path,
    'slide_key',slide_key,
    'image_urls',image_urls,
    'price_range',price_range,
    'zalo_url',zalo_url,
    'notes',notes,
    'effective_status',effective_status,
    'mapping_target_type',mapping_target_type,
    'mapping_mode',mapping_mode
  ),
  created_at,
  updated_at
from public.ad_mappings
where ad_id is not null
on conflict(page_id,ad_id) do update set
  ad_account_id=excluded.ad_account_id,
  campaign_id=excluded.campaign_id,
  adset_id=excluded.adset_id,
  catalog_keys=excluded.catalog_keys,
  is_active=excluded.is_active,
  metadata=excluded.metadata,
  updated_at=excluded.updated_at;

-- Compile one immutable snapshot. Workers cache this document and do not join knowledge tables per message.
with snapshot_content as (
  select jsonb_build_object(
    'documents',coalesce((
      select jsonb_agg(to_jsonb(d) order by d.priority,d.document_key,d.version_no)
      from public.ai_documents d where d.status<>'archived'
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
      ) from public.ai_catalog_nodes n where n.is_active
    ),'[]'::jsonb),
    'ad_mappings',coalesce((
      select jsonb_agg(to_jsonb(m) order by m.ad_account_id,m.campaign_id,m.adset_id,m.ad_id)
      from public.ai_ad_mappings m where m.is_active
    ),'[]'::jsonb)
  ) content
), inserted as (
  insert into public.ai_published_snapshots(checksum,content,status,source_versions,created_by)
  select encode(digest(content::text,'sha256'),'hex'),content,'published',jsonb_build_object(
    'legacy_context_versions',(select count(*) from public.v8_ai_context_versions),
    'legacy_catalog',(select count(*) from public.v8_product_catalog),
    'legacy_assets',(select count(*) from public.v8_drive_assets),
    'legacy_ad_mappings',(select count(*) from public.ad_mappings)
  ),'v9_import_v8'
  from snapshot_content
  on conflict(checksum) do update set status='published'
  returning id
)
update public.ai_runtime_config
set published_snapshot_id=(select id from inserted limit 1),
    mode='SHADOW',
    updated_at=now()
where id=1;
