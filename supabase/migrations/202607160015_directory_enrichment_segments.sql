begin;

-- Canonical data-platform primitives. Provider data is ingested once, retained as
-- source facts, resolved into master entities and exposed only when the recorded
-- permission/cache scope permits reuse for the requesting tenant.
create type public.provider_cache_scope as enum ('global','provider_account','tenant','one_time');
create type public.directory_entity_type as enum ('organization','establishment','person');
create type public.directory_freshness_state as enum ('fresh','stale','missing','refreshing','quarantined');
create type public.ingestion_state as enum ('scheduled','running','paused','quarantined','completed','failed','cancelled');
create type public.enrichment_state as enum ('queued','running','completed','partially_completed','failed','cancelled');

alter table public.data_providers
  add column if not exists adapter_key text,
  add column if not exists integration_type text not null default 'api'
    check (integration_type in ('api','json','file','sftp','webhook','scrape_html','browser')),
  add column if not exists cache_scope public.provider_cache_scope not null default 'tenant',
  add column if not exists allowed_entity_types public.directory_entity_type[] not null default '{organization}',
  add column if not exists allowed_purposes text[] not null default '{}',
  add column if not exists allow_raw_storage boolean not null default false,
  add column if not exists allow_tenant_display boolean not null default false,
  add column if not exists allow_export boolean not null default false,
  add column if not exists allow_resale boolean not null default false,
  add column if not exists source_attribution_required boolean not null default false,
  add column if not exists valid_from date,
  add column if not exists valid_until date,
  add column if not exists permission_document_path text,
  add column if not exists paused_reason text;

create table public.provider_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  data_provider_id uuid not null,
  name text not null,
  external_account_id text,
  integration_id uuid,
  credentials_ciphertext text,
  status text not null default 'inactive' check (status in ('inactive','active','paused','error','revoked')),
  configuration jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,id),
  unique (tenant_id,data_provider_id,name),
  foreign key (tenant_id,data_provider_id) references public.data_providers(tenant_id,id) on delete cascade,
  foreign key (tenant_id,integration_id) references public.tenant_integrations(tenant_id,id)
);

create table public.provider_account_tenants (
  provider_account_id uuid not null,
  owner_tenant_id uuid not null,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (provider_account_id,tenant_id),
  foreign key (owner_tenant_id,provider_account_id) references public.provider_accounts(tenant_id,id) on delete cascade
);

create table public.provider_permissions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  data_provider_id uuid not null,
  provider_account_id uuid,
  permission_name text not null,
  cache_scope public.provider_cache_scope not null,
  allowed_domains text[] not null default '{}',
  allowed_paths text[] not null default '{}',
  allowed_entity_types public.directory_entity_type[] not null default '{}',
  allowed_purposes text[] not null default '{}',
  raw_storage_allowed boolean not null default false,
  tenant_display_allowed boolean not null default false,
  cross_tenant_reuse_allowed boolean not null default false,
  export_allowed boolean not null default false,
  resale_allowed boolean not null default false,
  attribution_required boolean not null default false,
  retention_days integer check (retention_days is null or retention_days >= 0),
  starts_at timestamptz,
  expires_at timestamptz,
  document_storage_path text,
  written_approval_reference text,
  status text not null default 'draft' check (status in ('draft','active','expired','revoked')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,id),
  foreign key (tenant_id,data_provider_id) references public.data_providers(tenant_id,id) on delete cascade,
  foreign key (tenant_id,provider_account_id) references public.provider_accounts(tenant_id,id) on delete cascade
);

create table public.provider_field_permissions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  permission_id uuid not null,
  entity_type public.directory_entity_type not null,
  field_key text not null,
  may_fetch boolean not null default false,
  may_store boolean not null default false,
  may_display boolean not null default false,
  may_filter boolean not null default false,
  may_export boolean not null default false,
  retention_days integer check (retention_days is null or retention_days >= 0),
  created_at timestamptz not null default now(),
  unique (permission_id,entity_type,field_key),
  unique (tenant_id,id),
  foreign key (tenant_id,permission_id) references public.provider_permissions(tenant_id,id) on delete cascade
);

create table public.provider_rate_limits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  provider_account_id uuid not null,
  quota_key text not null,
  window_seconds integer not null check (window_seconds > 0),
  max_units integer not null check (max_units >= 0),
  max_concurrency integer not null default 1 check (max_concurrency > 0),
  minimum_delay_ms integer not null default 0 check (minimum_delay_ms >= 0),
  timeout_ms integer not null default 30000 check (timeout_ms between 1000 and 300000),
  max_retries integer not null default 5 check (max_retries between 0 and 20),
  allowed_start_time time,
  allowed_end_time time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_account_id,quota_key),
  unique (tenant_id,id),
  foreign key (tenant_id,provider_account_id) references public.provider_accounts(tenant_id,id) on delete cascade
);

create table public.provider_freshness_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  data_provider_id uuid not null,
  entity_type public.directory_entity_type not null,
  field_key text,
  ttl_days integer not null default 20 check (ttl_days between 0 and 3650),
  synchronous_before_contract boolean not null default false,
  stale_while_revalidate boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (data_provider_id,entity_type,field_key),
  unique (tenant_id,id),
  foreign key (tenant_id,data_provider_id) references public.data_providers(tenant_id,id) on delete cascade
);

create table public.provider_usage_counters (
  tenant_id uuid not null,
  provider_account_id uuid not null,
  quota_key text not null,
  window_started_at timestamptz not null,
  used_units integer not null default 0 check (used_units >= 0),
  updated_at timestamptz not null default now(),
  primary key (provider_account_id,quota_key,window_started_at),
  foreign key (tenant_id,provider_account_id) references public.provider_accounts(tenant_id,id) on delete cascade
);

create table public.parser_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  data_provider_id uuid not null,
  entity_type public.directory_entity_type not null,
  version text not null,
  fixture_storage_path text,
  expected_fields text[] not null default '{}',
  minimum_match_rate numeric not null default 0.90 check (minimum_match_rate between 0 and 1),
  disappearance_threshold numeric not null default 0.10 check (disappearance_threshold between 0 and 1),
  page_fingerprint text,
  status text not null default 'draft' check (status in ('draft','active','paused','retired')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (data_provider_id,entity_type,version),
  unique (tenant_id,id),
  foreign key (tenant_id,data_provider_id) references public.data_providers(tenant_id,id) on delete cascade
);

create table public.ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  data_provider_id uuid not null,
  provider_account_id uuid,
  permission_id uuid not null,
  name text not null,
  entity_type public.directory_entity_type not null,
  schedule_expression text,
  priority integer not null default 100,
  max_records integer not null default 5000 check (max_records > 0),
  quota_interpretation text not null default 'per_run'
    check (quota_interpretation in ('per_run','per_period','combined_entities','per_entity_type','per_tenant')),
  filter_definition jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active','paused','archived')),
  next_run_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,id),
  foreign key (tenant_id,data_provider_id) references public.data_providers(tenant_id,id) on delete cascade,
  foreign key (tenant_id,provider_account_id) references public.provider_accounts(tenant_id,id) on delete set null,
  foreign key (tenant_id,permission_id) references public.provider_permissions(tenant_id,id)
);

create table public.ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  ingestion_job_id uuid not null,
  parser_version_id uuid,
  status public.ingestion_state not null default 'scheduled',
  requested_records integer not null default 0,
  fetched_records integer not null default 0,
  new_records integer not null default 0,
  changed_records integer not null default 0,
  unchanged_records integer not null default 0,
  error_records integer not null default 0,
  quarantined_records integer not null default 0,
  quota_remaining integer,
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id,id),
  foreign key (tenant_id,ingestion_job_id) references public.ingestion_jobs(tenant_id,id) on delete cascade,
  foreign key (tenant_id,parser_version_id) references public.parser_versions(tenant_id,id)
);

create table public.crawl_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  ingestion_run_id uuid not null,
  priority_bucket integer not null check (priority_bucket between 1 and 4),
  filter_definition jsonb not null default '{}'::jsonb,
  estimated_records integer,
  sort_order integer not null default 0,
  status text not null default 'pending' check (status in ('pending','running','completed','skipped','failed')),
  created_at timestamptz not null default now(),
  unique (tenant_id,id),
  foreign key (tenant_id,ingestion_run_id) references public.ingestion_runs(tenant_id,id) on delete cascade
);

create table public.crawl_checkpoints (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  ingestion_run_id uuid not null,
  crawl_plan_id uuid,
  last_filter jsonb not null default '{}'::jsonb,
  last_page text,
  last_external_identifier text,
  last_processed_record text,
  fetched_records integer not null default 0,
  new_records integer not null default 0,
  changed_records integer not null default 0,
  unchanged_records integer not null default 0,
  error_records integer not null default 0,
  remaining_capacity integer,
  last_successful_step text,
  last_error text,
  next_retry_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (tenant_id,ingestion_run_id,crawl_plan_id),
  foreign key (tenant_id,ingestion_run_id) references public.ingestion_runs(tenant_id,id) on delete cascade,
  foreign key (tenant_id,crawl_plan_id) references public.crawl_plans(tenant_id,id) on delete cascade
);

create table public.raw_payloads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  ingestion_run_id uuid not null,
  permission_id uuid not null,
  external_identifier text,
  content_type text not null,
  http_status integer,
  request_id text,
  response_headers jsonb not null default '{}'::jsonb,
  source_timestamp timestamptz,
  fetched_at timestamptz not null default now(),
  parser_version_id uuid,
  payload_ciphertext text,
  storage_path text,
  payload_sha256 text not null,
  retention_until timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  unique (tenant_id,id),
  foreign key (tenant_id,ingestion_run_id) references public.ingestion_runs(tenant_id,id) on delete cascade,
  foreign key (tenant_id,permission_id) references public.provider_permissions(tenant_id,id),
  foreign key (tenant_id,parser_version_id) references public.parser_versions(tenant_id,id)
);

create table public.ingestion_errors (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  ingestion_run_id uuid not null,
  raw_payload_id uuid,
  stage text not null,
  error_code text,
  message text not null,
  retryable boolean not null default false,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (tenant_id,ingestion_run_id) references public.ingestion_runs(tenant_id,id) on delete cascade,
  foreign key (tenant_id,raw_payload_id) references public.raw_payloads(tenant_id,id) on delete set null
);

create table public.master_entities (
  id uuid primary key default gen_random_uuid(),
  entity_type public.directory_entity_type not null,
  cache_scope public.provider_cache_scope not null,
  owner_tenant_id uuid references public.tenants(id) on delete cascade,
  license_tenant_id uuid not null references public.tenants(id) on delete cascade,
  data_provider_id uuid not null,
  provider_account_id uuid,
  permission_id uuid not null,
  canonical_name text not null,
  organization_number text,
  external_primary_id text,
  legal_form text,
  organization_status text,
  address_line1 text,
  postal_code text,
  city text,
  municipality text,
  municipality_code text,
  county text,
  county_code text,
  country_code text not null default 'SE',
  latitude numeric,
  longitude numeric,
  industry text,
  sni_code text,
  employee_count integer,
  revenue numeric,
  result numeric,
  website text,
  phone_e164 text,
  email citext,
  current_master jsonb not null default '{}'::jsonb,
  data_quality_score numeric not null default 0 check (data_quality_score between 0 and 100),
  enriched_at timestamptz,
  fresh_until timestamptz,
  next_refresh_at timestamptz,
  source_removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((cache_scope='global' and owner_tenant_id is null) or (cache_scope<>'global' and owner_tenant_id is not null)),
  unique (id,owner_tenant_id),
  foreign key (license_tenant_id,data_provider_id) references public.data_providers(tenant_id,id),
  foreign key (license_tenant_id,provider_account_id) references public.provider_accounts(tenant_id,id),
  foreign key (license_tenant_id,permission_id) references public.provider_permissions(tenant_id,id)
);
create index master_entities_name_trgm_idx on public.master_entities using gin (canonical_name gin_trgm_ops);
create index master_entities_directory_filter_idx on public.master_entities(entity_type,country_code,county,municipality,city,sni_code,employee_count);
create unique index master_entities_global_org_unique on public.master_entities(organization_number)
  where cache_scope='global' and entity_type='organization' and organization_number is not null;
create unique index master_entities_tenant_org_unique on public.master_entities(owner_tenant_id,organization_number)
  where cache_scope<>'global' and entity_type='organization' and organization_number is not null;

create table public.source_entities (
  id uuid primary key default gen_random_uuid(),
  owner_tenant_id uuid not null references public.tenants(id) on delete cascade,
  data_provider_id uuid not null,
  provider_account_id uuid,
  permission_id uuid not null,
  entity_type public.directory_entity_type not null,
  external_identifier text not null,
  raw_payload_id uuid,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  removed_at timestamptz,
  parser_version_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  unique (data_provider_id,provider_account_id,entity_type,external_identifier),
  unique (id,owner_tenant_id),
  foreign key (owner_tenant_id,data_provider_id) references public.data_providers(tenant_id,id),
  foreign key (owner_tenant_id,provider_account_id) references public.provider_accounts(tenant_id,id),
  foreign key (owner_tenant_id,permission_id) references public.provider_permissions(tenant_id,id),
  foreign key (owner_tenant_id,raw_payload_id) references public.raw_payloads(tenant_id,id),
  foreign key (owner_tenant_id,parser_version_id) references public.parser_versions(tenant_id,id)
);

create table public.entity_source_links (
  master_entity_id uuid not null references public.master_entities(id) on delete cascade,
  source_entity_id uuid not null references public.source_entities(id) on delete cascade,
  match_method text not null,
  confidence numeric not null default 1 check (confidence between 0 and 1),
  manually_verified boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (master_entity_id,source_entity_id)
);

create table public.source_facts (
  id uuid primary key default gen_random_uuid(),
  source_entity_id uuid not null references public.source_entities(id) on delete cascade,
  field_key text not null,
  field_value jsonb not null,
  value_hash text not null,
  fetched_at timestamptz not null,
  last_seen_at timestamptz not null,
  verified_at timestamptz,
  confidence numeric not null default 0.5 check (confidence between 0 and 1),
  parser_version_id uuid,
  permission_id uuid not null,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (source_entity_id,field_key,value_hash)
);

create table public.field_values (
  id uuid primary key default gen_random_uuid(),
  master_entity_id uuid not null references public.master_entities(id) on delete cascade,
  field_key text not null,
  field_value jsonb not null,
  selected_source_fact_id uuid references public.source_facts(id) on delete set null,
  source_priority integer not null default 100,
  confidence numeric not null default 0.5 check (confidence between 0 and 1),
  manually_verified boolean not null default false,
  verified_at timestamptz,
  fresh_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (master_entity_id,field_key)
);

create table public.field_value_history (
  id bigint generated always as identity primary key,
  master_entity_id uuid not null references public.master_entities(id) on delete cascade,
  field_key text not null,
  old_value jsonb,
  new_value jsonb,
  source_fact_id uuid references public.source_facts(id) on delete set null,
  change_type text not null check (change_type in ('created','changed','removed','conflict','source_changed','verified')),
  changed_at timestamptz not null default now()
);

create table public.entity_freshness (
  master_entity_id uuid primary key references public.master_entities(id) on delete cascade,
  state public.directory_freshness_state not null default 'missing',
  enriched_at timestamptz,
  fresh_until timestamptz,
  next_refresh_at timestamptz,
  last_refresh_started_at timestamptz,
  last_refresh_completed_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

create table public.field_freshness (
  master_entity_id uuid not null references public.master_entities(id) on delete cascade,
  field_key text not null,
  verified_at timestamptz,
  fresh_until timestamptz,
  next_refresh_at timestamptz,
  state public.directory_freshness_state not null default 'missing',
  updated_at timestamptz not null default now(),
  primary key (master_entity_id,field_key)
);

create table public.enrichment_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  master_entity_id uuid references public.master_entities(id) on delete cascade,
  data_provider_id uuid not null,
  provider_account_id uuid,
  permission_id uuid not null,
  enrichment_type text not null default 'full',
  requested_fields text[] not null default '{}',
  purpose text not null,
  status public.enrichment_state not null default 'queued',
  idempotency_key text not null,
  estimated_external_calls integer not null default 1,
  estimated_cost numeric not null default 0,
  actual_external_calls integer not null default 0,
  actual_cost numeric not null default 0,
  quota_result jsonb not null default '{}'::jsonb,
  permission_result jsonb not null default '{}'::jsonb,
  requested_by uuid references auth.users(id) on delete set null,
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (tenant_id,id),
  unique (tenant_id,idempotency_key),
  foreign key (tenant_id,data_provider_id) references public.data_providers(tenant_id,id),
  foreign key (tenant_id,provider_account_id) references public.provider_accounts(tenant_id,id),
  foreign key (tenant_id,permission_id) references public.provider_permissions(tenant_id,id)
);

create table public.refresh_locks (
  lock_key text primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  enrichment_job_id uuid,
  locked_until timestamptz not null,
  locked_by text not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id,enrichment_job_id) references public.enrichment_jobs(tenant_id,id) on delete cascade
);

create table public.duplicate_candidates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  left_entity_id uuid not null references public.master_entities(id) on delete cascade,
  right_entity_id uuid not null references public.master_entities(id) on delete cascade,
  match_method text not null,
  confidence numeric not null check (confidence between 0 and 1),
  status text not null default 'pending' check (status in ('pending','confirmed','rejected','merged')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check (left_entity_id <> right_entity_id),
  unique (tenant_id,left_entity_id,right_entity_id)
);

create table public.data_conflicts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  master_entity_id uuid not null references public.master_entities(id) on delete cascade,
  field_key text not null,
  candidate_values jsonb not null,
  status text not null default 'open' check (status in ('open','resolved','ignored')),
  resolution jsonb,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.data_quality_scores (
  master_entity_id uuid primary key references public.master_entities(id) on delete cascade,
  completeness numeric not null default 0 check (completeness between 0 and 100),
  freshness numeric not null default 0 check (freshness between 0 and 100),
  consistency numeric not null default 0 check (consistency between 0 and 100),
  provenance numeric not null default 0 check (provenance between 0 and 100),
  overall numeric generated always as ((completeness+freshness+consistency+provenance)/4) stored,
  details jsonb not null default '{}'::jsonb,
  calculated_at timestamptz not null default now()
);

create table public.segments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  description text,
  entity_type public.directory_entity_type not null,
  segment_type text not null default 'dynamic' check (segment_type in ('dynamic','snapshot')),
  rule_definition jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  owner_user_id uuid references auth.users(id) on delete set null,
  team_id uuid,
  last_refreshed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,name),
  unique (tenant_id,id),
  foreign key (tenant_id,team_id) references public.teams(tenant_id,id)
);

create table public.segment_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  segment_id uuid not null,
  group_number integer not null default 1,
  sort_order integer not null default 0,
  field_key text not null,
  operator text not null check (operator in ('eq','neq','in','not_in','contains','starts_with','gte','lte','between','is_null','not_null','within_radius')),
  comparison_value jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id,id),
  foreign key (tenant_id,segment_id) references public.segments(tenant_id,id) on delete cascade
);

create table public.segment_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  segment_id uuid not null,
  member_count integer not null default 0,
  rule_definition jsonb not null,
  generated_at timestamptz not null default now(),
  generated_by uuid references auth.users(id) on delete set null,
  unique (tenant_id,id),
  foreign key (tenant_id,segment_id) references public.segments(tenant_id,id) on delete cascade
);

create table public.segment_memberships (
  tenant_id uuid not null,
  snapshot_id uuid not null,
  segment_id uuid not null,
  master_entity_id uuid not null references public.master_entities(id) on delete cascade,
  matched_at timestamptz not null default now(),
  primary key (snapshot_id,master_entity_id),
  foreign key (tenant_id,snapshot_id) references public.segment_snapshots(tenant_id,id) on delete cascade,
  foreign key (tenant_id,segment_id) references public.segments(tenant_id,id) on delete cascade
);

create table public.nix_checks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid,
  phone_e164 text not null,
  source text not null default 'NIX-Telefon',
  source_version text,
  result text not null check (result in ('listed','not_listed','unknown','error')),
  checked_at timestamptz not null,
  valid_until timestamptz not null,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id,id),
  foreign key (tenant_id,customer_id) references public.customers(tenant_id,id) on delete cascade
);
create index nix_checks_lookup_idx on public.nix_checks(tenant_id,phone_e164,checked_at desc);

create table public.contact_permissions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  customer_id uuid not null,
  channel text not null check (channel in ('call','sms','email')),
  purpose text not null default 'direct_marketing',
  legal_basis text,
  status text not null check (status in ('allowed','denied','objected','expired','unknown')),
  source text not null,
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  evidence jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id,id),
  foreign key (tenant_id,customer_id) references public.customers(tenant_id,id) on delete cascade
);
create index contact_permissions_lookup_idx on public.contact_permissions(tenant_id,customer_id,channel,created_at desc);

create table public.retention_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  data_category text not null,
  purpose text not null,
  legal_basis text,
  retention_days integer not null check (retention_days >= 0),
  action text not null default 'delete' check (action in ('delete','anonymize','archive','review')),
  data_provider_id uuid,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,data_category,purpose,data_provider_id),
  foreign key (tenant_id,data_provider_id) references public.data_providers(tenant_id,id) on delete cascade
);

-- Provider permission is evaluated centrally. A global row is visible only when
-- its permission explicitly allows cross-tenant reuse and tenant display.
create or replace function public.can_access_master_entity(p_entity public.master_entities)
returns boolean
language sql stable security definer set search_path=public
as $$
  select case
    when public.current_tenant_id() is null then false
    when p_entity.owner_tenant_id=public.current_tenant_id() then true
    when p_entity.cache_scope='global' and exists (
      select 1 from public.provider_permissions pp
      where pp.id=p_entity.permission_id
        and pp.status='active'
        and pp.cache_scope='global'
        and pp.cross_tenant_reuse_allowed
        and pp.tenant_display_allowed
        and (pp.starts_at is null or pp.starts_at<=now())
        and (pp.expires_at is null or pp.expires_at>now())
    ) then true
    when p_entity.cache_scope='provider_account' and exists (
      select 1 from public.provider_account_tenants pat
      join public.provider_accounts pa on pa.id=pat.provider_account_id and pa.tenant_id=pat.owner_tenant_id
      join public.provider_permissions pp on pp.provider_account_id=pa.id and pp.id=p_entity.permission_id
      where pa.id=p_entity.provider_account_id
        and pat.tenant_id=public.current_tenant_id()
        and pa.status='active'
        and pp.status='active'
        and pp.tenant_display_allowed
        and (pp.expires_at is null or pp.expires_at>now())
    ) then true
    else false
  end
$$;

-- Explicit-tenant service function for API keys. It duplicates the same access
-- predicate instead of relying on client supplied tenant context.
create or replace function public.directory_search_for_tenant(
  p_tenant_id uuid,
  p_entity_type public.directory_entity_type default 'organization',
  p_query text default null,
  p_country_code text default 'SE',
  p_county text default null,
  p_municipality text default null,
  p_city text default null,
  p_sni_code text default null,
  p_employee_min integer default null,
  p_employee_max integer default null,
  p_has_phone boolean default null,
  p_has_email boolean default null,
  p_fresh_only boolean default false,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  id uuid, entity_type public.directory_entity_type, canonical_name text, organization_number text,
  legal_form text, organization_status text, address_line1 text, postal_code text, city text,
  municipality text, county text, country_code text, latitude numeric, longitude numeric,
  industry text, sni_code text, employee_count integer, revenue numeric, result numeric,
  website text, phone_e164 text, email citext, data_quality_score numeric,
  enriched_at timestamptz, fresh_until timestamptz, freshness_state public.directory_freshness_state,
  source_attribution_required boolean
)
language sql stable security definer set search_path=public
as $$
  select me.id,me.entity_type,me.canonical_name,me.organization_number,me.legal_form,me.organization_status,
         me.address_line1,me.postal_code,me.city,me.municipality,me.county,me.country_code,me.latitude,me.longitude,
         me.industry,me.sni_code,me.employee_count,me.revenue,me.result,me.website,me.phone_e164,me.email,
         me.data_quality_score,me.enriched_at,me.fresh_until,
         case
           when ef.state is not null then ef.state
           when me.enriched_at is null then 'missing'::public.directory_freshness_state
           when me.fresh_until>now() then 'fresh'::public.directory_freshness_state
           else 'stale'::public.directory_freshness_state
         end,
         coalesce(pp.attribution_required,false)
  from public.master_entities me
  left join public.entity_freshness ef on ef.master_entity_id=me.id
  left join public.provider_permissions pp on pp.id=me.permission_id
  where me.entity_type=p_entity_type
    and (p_country_code is null or me.country_code=p_country_code)
    and (p_query is null or me.canonical_name ilike '%'||p_query||'%' or me.organization_number ilike '%'||p_query||'%')
    and (p_county is null or me.county=p_county)
    and (p_municipality is null or me.municipality=p_municipality)
    and (p_city is null or me.city=p_city)
    and (p_sni_code is null or me.sni_code like p_sni_code||'%')
    and (p_employee_min is null or me.employee_count>=p_employee_min)
    and (p_employee_max is null or me.employee_count<=p_employee_max)
    and (p_has_phone is null or (me.phone_e164 is not null)=p_has_phone)
    and (p_has_email is null or (me.email is not null)=p_has_email)
    and (not p_fresh_only or me.fresh_until>now())
    and (
      me.owner_tenant_id=p_tenant_id
      or (me.cache_scope='global' and pp.status='active' and pp.cache_scope='global'
          and pp.cross_tenant_reuse_allowed and pp.tenant_display_allowed
          and (pp.starts_at is null or pp.starts_at<=now()) and (pp.expires_at is null or pp.expires_at>now()))
      or (me.cache_scope='provider_account' and exists (
        select 1 from public.provider_account_tenants pat
        join public.provider_accounts pa on pa.id=pat.provider_account_id and pa.tenant_id=pat.owner_tenant_id
        where pat.provider_account_id=me.provider_account_id and pat.tenant_id=p_tenant_id and pa.status='active'
      ) and pp.status='active' and pp.tenant_display_allowed and (pp.expires_at is null or pp.expires_at>now()))
    )
  order by me.data_quality_score desc, me.canonical_name
  limit greatest(1,least(coalesce(p_limit,50),200))
  offset greatest(coalesce(p_offset,0),0)
$$;

create or replace function public.directory_entity_for_tenant(p_tenant_id uuid,p_entity_id uuid)
returns setof public.master_entities
language sql stable security definer set search_path=public
as $$
  select me.*
  from public.master_entities me
  left join public.provider_permissions pp on pp.id=me.permission_id
  where me.id=p_entity_id and (
    me.owner_tenant_id=p_tenant_id
    or (me.cache_scope='global' and pp.status='active' and pp.cache_scope='global'
        and pp.cross_tenant_reuse_allowed and pp.tenant_display_allowed
        and (pp.expires_at is null or pp.expires_at>now()))
    or (me.cache_scope='provider_account' and exists (
      select 1 from public.provider_account_tenants pat
      join public.provider_accounts pa on pa.id=pat.provider_account_id and pa.tenant_id=pat.owner_tenant_id
      where pat.provider_account_id=me.provider_account_id and pat.tenant_id=p_tenant_id and pa.status='active'
    ) and pp.status='active' and pp.tenant_display_allowed and (pp.expires_at is null or pp.expires_at>now()))
  )
$$;

-- RLS: catalog writes are service-only; tenant operators can administer their
-- provider configuration and segments, while all catalog reads pass the access predicate.
alter table public.master_entities enable row level security;
alter table public.source_entities enable row level security;
alter table public.entity_source_links enable row level security;
alter table public.source_facts enable row level security;
alter table public.field_values enable row level security;
alter table public.field_value_history enable row level security;
alter table public.entity_freshness enable row level security;
alter table public.field_freshness enable row level security;
alter table public.data_quality_scores enable row level security;

create policy master_entities_licensed_select on public.master_entities for select to authenticated
  using (public.can_access_master_entity(master_entities));
create policy source_entities_owner_select on public.source_entities for select to authenticated
  using (owner_tenant_id=public.current_tenant_id() and public.is_tenant_admin(owner_tenant_id));
create policy entity_source_links_licensed_select on public.entity_source_links for select to authenticated
  using (exists(select 1 from public.master_entities me where me.id=master_entity_id and public.can_access_master_entity(me)));
create policy source_facts_licensed_select on public.source_facts for select to authenticated
  using (exists(
    select 1 from public.entity_source_links l join public.master_entities me on me.id=l.master_entity_id
    where l.source_entity_id=source_facts.source_entity_id and public.can_access_master_entity(me)
  ));
create policy field_values_licensed_select on public.field_values for select to authenticated
  using (exists(select 1 from public.master_entities me where me.id=master_entity_id and public.can_access_master_entity(me)));
create policy field_value_history_admin_select on public.field_value_history for select to authenticated
  using (exists(select 1 from public.master_entities me where me.id=master_entity_id and public.can_access_master_entity(me))
         and public.has_current_role(array['owner','admin','team_lead','backoffice']));
create policy entity_freshness_licensed_select on public.entity_freshness for select to authenticated
  using (exists(select 1 from public.master_entities me where me.id=master_entity_id and public.can_access_master_entity(me)));
create policy field_freshness_licensed_select on public.field_freshness for select to authenticated
  using (exists(select 1 from public.master_entities me where me.id=master_entity_id and public.can_access_master_entity(me)));
create policy data_quality_scores_licensed_select on public.data_quality_scores for select to authenticated
  using (exists(select 1 from public.master_entities me where me.id=master_entity_id and public.can_access_master_entity(me)));

-- Tenant-owned administration tables.
do $$
declare t text;
begin
  foreach t in array array[
    'provider_accounts','provider_permissions','provider_field_permissions','provider_rate_limits',
    'provider_freshness_policies','provider_usage_counters','parser_versions','ingestion_jobs','ingestion_runs',
    'crawl_plans','crawl_checkpoints','raw_payloads','ingestion_errors','enrichment_jobs','refresh_locks',
    'duplicate_candidates','data_conflicts','segments','segment_rules','segment_snapshots','segment_memberships',
    'nix_checks','contact_permissions','retention_policies'
  ] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('create policy %I_ops_select on public.%I for select to authenticated using (tenant_id=public.current_tenant_id() and public.has_current_role(array[''owner'',''admin'',''team_lead'',''backoffice'']))',t,t);
    execute format('create policy %I_admin_write on public.%I for all to authenticated using (tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id)) with check (tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id))',t,t);
  end loop;
end $$;

alter table public.provider_account_tenants enable row level security;
create policy provider_account_tenants_select on public.provider_account_tenants for select to authenticated
  using ((owner_tenant_id=public.current_tenant_id() or tenant_id=public.current_tenant_id()) and public.is_tenant_member(public.current_tenant_id()));
create policy provider_account_tenants_owner_write on public.provider_account_tenants for all to authenticated
  using (owner_tenant_id=public.current_tenant_id() and public.is_tenant_admin(owner_tenant_id))
  with check (owner_tenant_id=public.current_tenant_id() and public.is_tenant_admin(owner_tenant_id));

create trigger provider_accounts_touch before update on public.provider_accounts for each row execute function public.touch_updated_at();
create trigger provider_permissions_touch before update on public.provider_permissions for each row execute function public.touch_updated_at();
create trigger provider_rate_limits_touch before update on public.provider_rate_limits for each row execute function public.touch_updated_at();
create trigger provider_freshness_touch before update on public.provider_freshness_policies for each row execute function public.touch_updated_at();
create trigger ingestion_jobs_touch before update on public.ingestion_jobs for each row execute function public.touch_updated_at();
create trigger master_entities_touch before update on public.master_entities for each row execute function public.touch_updated_at();
create trigger field_values_touch before update on public.field_values for each row execute function public.touch_updated_at();
create trigger segments_touch before update on public.segments for each row execute function public.touch_updated_at();
create trigger retention_policies_touch before update on public.retention_policies for each row execute function public.touch_updated_at();

-- Protect explicit-tenant directory functions from browser calls. The BFF/API
-- authenticates the request and invokes them with service_role.
revoke all on function public.directory_search_for_tenant(uuid,public.directory_entity_type,text,text,text,text,text,text,integer,integer,boolean,boolean,boolean,integer,integer) from public,anon,authenticated;
revoke all on function public.directory_entity_for_tenant(uuid,uuid) from public,anon,authenticated;
grant execute on function public.directory_search_for_tenant(uuid,public.directory_entity_type,text,text,text,text,text,text,integer,integer,boolean,boolean,boolean,integer,integer) to service_role;
grant execute on function public.directory_entity_for_tenant(uuid,uuid) to service_role;
grant execute on function public.can_access_master_entity(public.master_entities) to authenticated;

commit;
