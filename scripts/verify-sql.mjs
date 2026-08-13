import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const db = new PGlite({ extensions: { citext, pg_trgm } });
await db.waitReady;

// Minimal Supabase-owned schemas used by the migrations. pgcrypto is present in
// hosted/local Supabase; PGlite already provides gen_random_uuid but not the
// extension control file, so only that CREATE EXTENSION line is omitted here.
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid
  $$;
  create function auth.role() returns text language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.role', true),''), 'authenticated')
  $$;
  create function auth.jwt() returns jsonb language sql stable as $$
    select jsonb_build_object(
      'sub', nullif(current_setting('request.jwt.claim.sub', true),''),
      'role', coalesce(nullif(current_setting('request.jwt.claim.role', true),''), 'authenticated')
    )
  $$;
  create schema storage;
  create table storage.buckets (
    id text primary key, name text not null, public boolean not null default false,
    file_size_limit bigint, allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
    name text not null, owner_id text, metadata jsonb,
    created_at timestamptz default now(), updated_at timestamptz default now()
  );
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as $$
    select regexp_split_to_array(name, '/')
  $$;
  create function public.digest(value text, algorithm text) returns bytea language sql immutable as $$
    select decode(md5(value), 'hex')
  $$;
`);

const migrationDir = join(root, "supabase/migrations");
const migrations = (await readdir(migrationDir)).filter((name) => name.endsWith(".sql")).sort();
const migrationVersions = migrations.map((name) => name.match(/^(\d+)_/)?.[1] ?? "");
if (migrationVersions.some((version) => !version)) throw new Error("Every migration filename must start with a numeric version");
if (new Set(migrationVersions).size !== migrationVersions.length) {
  throw new Error(`Duplicate migration version detected: ${migrationVersions.filter((version, index) => migrationVersions.indexOf(version) !== index).join(", ")}`);
}
for (const migration of migrations) {
  let sql = await readFile(join(migrationDir, migration), "utf8");
  sql = sql.replace(/create extension if not exists pgcrypto;\s*/ig, "");
  try {
    await db.exec(sql);
  } catch (error) {
    throw new Error(`Migration ${migration} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const result = await db.query(`
  select
    (select count(*)::int from pg_tables where schemaname='public') as tables,
    (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public') as functions,
    (select count(*)::int from pg_policies where schemaname in ('public','storage')) as policies
`);
const counts = result.rows[0];
if (!counts || Number(counts.tables) < 100 || Number(counts.functions) < 30 || Number(counts.policies) < 100) {
  throw new Error(`Unexpected schema counts: ${JSON.stringify(counts)}`);
}
const directoryPrivileges = await db.query(`
  select
    has_function_privilege('authenticated','public.directory_search_v2_for_tenant(uuid,jsonb,integer,integer)','EXECUTE') as authenticated_directory_search,
    has_function_privilege('service_role','public.directory_search_v2_for_tenant(uuid,jsonb,integer,integer)','EXECUTE') as service_directory_search,
    has_function_privilege('authenticated','public.refresh_segment_materialization(uuid,uuid)','EXECUTE') as authenticated_segment_refresh,
    has_function_privilege('service_role','public.refresh_segment_materialization_for_tenant(uuid,uuid,uuid)','EXECUTE') as service_segment_refresh,
    has_function_privilege('service_role','public.refresh_segment_materialization(uuid,uuid)','EXECUTE') as unscoped_service_segment_refresh,
    has_function_privilege('authenticated','public.materialize_segment_to_campaign(uuid,uuid,uuid)','EXECUTE') as authenticated_campaign_materialization,
    has_function_privilege('service_role','public.materialize_segment_to_campaign_for_tenant(uuid,uuid,uuid,uuid)','EXECUTE') as service_campaign_materialization,
    has_function_privilege('service_role','public.materialize_segment_to_campaign(uuid,uuid,uuid)','EXECUTE') as unscoped_service_campaign_materialization
`);
const privileges = directoryPrivileges.rows[0];
if (
  privileges.authenticated_directory_search
  || !privileges.service_directory_search
  || !privileges.authenticated_segment_refresh
  || !privileges.service_segment_refresh
  || privileges.unscoped_service_segment_refresh
  || !privileges.authenticated_campaign_materialization
  || !privileges.service_campaign_materialization
  || privileges.unscoped_service_campaign_materialization
) {
  throw new Error(`Directory RPC privilege boundary failed: ${JSON.stringify(privileges)}`);
}
const provisioningPrivileges = await db.query(`
  select
    has_function_privilege('authenticated','public.current_user_security_state()','EXECUTE') as authenticated_security_read,
    has_function_privilege('authenticated','public.tenant_user_security_states()','EXECUTE') as authenticated_admin_security_read,
    has_function_privilege('anon','public.current_user_security_state()','EXECUTE') as anon_security_read,
    has_function_privilege('authenticated','public.provision_user_security_state(uuid,uuid)','EXECUTE') as authenticated_security_write,
    has_function_privilege('service_role','public.provision_user_security_state(uuid,uuid)','EXECUTE') as service_security_write,
    has_function_privilege('authenticated','public.complete_user_password_change(uuid)','EXECUTE') as authenticated_password_completion,
    has_function_privilege('service_role','public.complete_user_password_change(uuid)','EXECUTE') as service_password_completion,
    has_function_privilege('authenticated','public.create_or_resume_platform_tenant_owner(text,text,text,text,text,text,text,timestamptz,text)','EXECUTE') as authenticated_platform_tenant_owner,
    has_function_privilege('anon','public.create_or_resume_platform_tenant_owner(text,text,text,text,text,text,text,timestamptz,text)','EXECUTE') as anon_platform_tenant_owner,
    has_function_privilege('authenticated','public.create_platform_tenant(text,text,text,text,text,text)','EXECUTE') as authenticated_legacy_platform_tenant,
    has_function_privilege('service_role','public.create_platform_tenant(text,text,text,text,text,text)','EXECUTE') as service_legacy_platform_tenant,
    has_function_privilege('authenticated','public.create_managed_team_v2(text,text,text,text,text,boolean,integer,text,uuid)','EXECUTE') as authenticated_team_create_v2,
    has_function_privilege('anon','public.create_managed_team_v2(text,text,text,text,text,boolean,integer,text,uuid)','EXECUTE') as anon_team_create_v2,
    has_function_privilege('authenticated','public.update_tenant_member_v3(uuid,public.membership_role,public.membership_status,uuid,uuid[],uuid,boolean)','EXECUTE') as authenticated_member_update_v3,
    has_function_privilege('anon','public.update_tenant_member_v3(uuid,public.membership_role,public.membership_status,uuid,uuid[],uuid,boolean)','EXECUTE') as anon_member_update_v3
`);
const provisioningPrivilege = provisioningPrivileges.rows[0];
if (
  !provisioningPrivilege.authenticated_security_read
  || !provisioningPrivilege.authenticated_admin_security_read
  || provisioningPrivilege.anon_security_read
  || provisioningPrivilege.authenticated_security_write
  || !provisioningPrivilege.service_security_write
  || provisioningPrivilege.authenticated_password_completion
  || !provisioningPrivilege.service_password_completion
  || !provisioningPrivilege.authenticated_platform_tenant_owner
  || provisioningPrivilege.anon_platform_tenant_owner
  || provisioningPrivilege.authenticated_legacy_platform_tenant
  || !provisioningPrivilege.service_legacy_platform_tenant
  || !provisioningPrivilege.authenticated_team_create_v2
  || provisioningPrivilege.anon_team_create_v2
  || !provisioningPrivilege.authenticated_member_update_v3
  || provisioningPrivilege.anon_member_update_v3
) {
  throw new Error(`Provisioning RPC privilege boundary failed: ${JSON.stringify(provisioningPrivilege)}`);
}

console.log(`Executed ${migrations.length} migrations: ${counts.tables} public tables, ${counts.functions} public functions, ${counts.policies} RLS policies.`);

// Execute the canonical data path, not only DDL parsing: due scheduling -> lease ->
// raw-before-parse -> source facts/master resolution -> licensed search -> segment snapshot.
await db.exec(`
  insert into auth.users(id,email) values('00000000-0000-0000-0000-000000000002','owner@example.test');
  insert into public.tenants(id,slug,name,legal_name) values('00000000-0000-0000-0000-000000000001','verify-tenant','Verify tenant','Verify Tenant AB');
  insert into public.tenant_memberships(tenant_id,user_id,role,status,joined_at) values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','owner','active',now());
  insert into public.data_providers(id,tenant_id,provider,name,status,adapter_key,integration_type,cache_scope,source_class,field_mapping)
  values('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','verify','Verify provider','active','generic_json','api','tenant','licensed_provider','{"canonical_name":"name","organization_number":"org","city":"city","phone_e164":"phone","revenue":"revenue"}');
  insert into public.provider_accounts(id,tenant_id,data_provider_id,name,status,configuration)
  values('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','Verify API','active','{}');
  insert into public.provider_permissions(id,tenant_id,data_provider_id,provider_account_id,permission_name,cache_scope,allowed_domains,allowed_entity_types,allowed_purposes,raw_storage_allowed,tenant_display_allowed,status)
  values('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','Verify permission','tenant','{api.example.test}','{organization}','{prospecting}',true,true,'active');
  insert into public.provider_field_permissions(tenant_id,permission_id,entity_type,field_key,may_fetch,may_store,may_display,may_filter)
  select '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000005','organization',field,true,true,field<>'revenue',true
  from unnest(array['canonical_name','organization_number','city','phone_e164','revenue','municipality','municipality_code','county','county_code','latitude','longitude']) field;
  insert into public.provider_freshness_policies(tenant_id,data_provider_id,entity_type,ttl_days)
  values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','organization',20);
  insert into public.parser_versions(id,tenant_id,data_provider_id,entity_type,version,expected_fields,status)
  values('00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','organization','1','{canonical_name,organization_number,city,phone_e164,revenue}','active');
  insert into public.ingestion_jobs(id,tenant_id,data_provider_id,provider_account_id,permission_id,name,entity_type,max_records,status,next_run_at,adapter_configuration)
  values('00000000-0000-0000-0000-000000000007','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000005','Verify ingestion','organization',5000,'active',now(),'{"endpoint_template":"https://api.example.test/search"}');
  select * from public.schedule_due_ingestion_jobs(10);
`);
const scheduled = await db.query(`select id from public.ingestion_runs where ingestion_job_id='00000000-0000-0000-0000-000000000007'`);
if (scheduled.rows.length !== 1) throw new Error("Ingestion scheduler did not create exactly one run");
const runId = String(scheduled.rows[0].id);
await db.query(`select * from public.claim_ingestion_runs($1,1)`, ["verify-worker"]);
const raw = await db.query(`select public.record_ingestion_raw_payload($1,'page:1','application/json',200,'verify-request','{}',now(),'verify-sha','ciphertext',null,'{}') as id`, [runId]);
const rawId = String(raw.rows[0].id);
const facts = [
  { field_key: "canonical_name", field_value: "Kundexa Verify AB", value_hash: "n1", confidence: 0.9 },
  { field_key: "organization_number", field_value: "5561234567", value_hash: "n2", confidence: 1 },
  { field_key: "city", field_value: "Malmö", value_hash: "n3", confidence: 0.8 },
  { field_key: "phone_e164", field_value: "+46701234567", value_hash: "n4", confidence: 0.8 },
  { field_key: "revenue", field_value: 12000000, value_hash: "n5", confidence: 0.8 },
];
const canonical = { canonical_name: "Kundexa Verify AB", organization_number: "5561234567", city: "Malmö", phone_e164: "+46701234567", revenue: 12000000, country_code: "SE" };
const completed = await db.query(`select public.complete_ingestion_record($1,$2,'verify-company',$3::jsonb,$4::jsonb,null,now()) as result`, [runId, rawId, JSON.stringify(facts), JSON.stringify(canonical)]);
if (completed.rows[0].result?.quarantined) throw new Error("Valid parser fixture was quarantined");
await db.query(`select public.complete_ingestion_run($1,null,'{}')`, [runId]);
const entity = await db.query(`select id,canonical_name,data_quality_score from public.master_entities where organization_number='5561234567'`);
if (entity.rows.length !== 1 || entity.rows[0].canonical_name !== "Kundexa Verify AB") throw new Error("Master entity resolution failed");
const entityId = String(entity.rows[0].id);
const geographyRows = [
  { country_code: 'SE', area_type: 'county', code: '12', name: 'Skåne län', aliases: ['Skåne'], latitude: 55.99, longitude: 13.60 },
  { country_code: 'SE', area_type: 'municipality', code: '1280', name: 'Malmö kommun', parent_code: '12', aliases: ['Malmö'], latitude: 55.605, longitude: 13.0038 },
];
const geoImport = await db.query(`select public.upsert_geographic_reference_batch($1::jsonb,'verify-geography','2026-07') as imported`, [JSON.stringify(geographyRows)]);
if (Number(geoImport.rows[0].imported) !== 2) throw new Error(`Geography reference import failed: ${JSON.stringify(geoImport.rows[0])}`);
const geoNormalized = await db.query(`select public.normalize_master_entity_geography($1) as result`, [entityId]);
if (!geoNormalized.rows[0].result.normalized) throw new Error(`Geography normalization failed: ${JSON.stringify(geoNormalized.rows[0])}`);
const normalizedEntity = await db.query(`select municipality,municipality_code,county,county_code,latitude,longitude from public.master_entities where id=$1`, [entityId]);
if (normalizedEntity.rows[0].municipality !== 'Malmö kommun' || normalizedEntity.rows[0].county_code !== '12') throw new Error(`Geography master fields failed: ${JSON.stringify(normalizedEntity.rows[0])}`);
const visible = await db.query(`select * from public.directory_visible_fields_for_tenant('00000000-0000-0000-0000-000000000001',$1)`, [entityId]);
if (visible.rows.length !== 10 || visible.rows.some((row) => row.field_key === 'revenue')) throw new Error(`Display licensing failed: ${JSON.stringify(visible.rows)}`);
const summary = await db.query(`select public.directory_search_summary_for_tenant('00000000-0000-0000-0000-000000000001','{"entityType":"organization","city":"Malmö"}'::jsonb) as summary`);
if (Number(summary.rows[0].summary.total) !== 1 || Number(summary.rows[0].summary.fresh) !== 1) throw new Error(`Directory summary failed: ${JSON.stringify(summary.rows[0])}`);
const filteredByHiddenField = await db.query(`select public.directory_search_v2_for_tenant('00000000-0000-0000-0000-000000000001','{"entityType":"organization","revenueMin":10000000}'::jsonb,50,0) as data`);
const filteredRows = filteredByHiddenField.rows[0].data;
if (!Array.isArray(filteredRows) || filteredRows.length !== 1 || Object.prototype.hasOwnProperty.call(filteredRows[0], 'revenue')) throw new Error(`Filter/display separation failed: ${JSON.stringify(filteredRows)}`);
const priorities = await db.query(`select count(*)::int as count from public.source_priority_policies where tenant_id='00000000-0000-0000-0000-000000000001'`);
if (Number(priorities.rows[0].count) !== 7) throw new Error(`Tenant source-priority seed failed: ${JSON.stringify(priorities.rows[0])}`);
await db.exec(`insert into public.segments(id,tenant_id,name,entity_type,segment_type,rule_definition) values('00000000-0000-0000-0000-000000000008','00000000-0000-0000-0000-000000000001','Malmö verify','organization','dynamic','{"entityType":"organization","city":"Malmö","countryCode":"SE"}')`);
const segment = await db.query(`select public.refresh_segment_materialization('00000000-0000-0000-0000-000000000008',null) as result`);
if (Number(segment.rows[0].result.memberCount) !== 1) throw new Error(`Segment materialization failed: ${JSON.stringify(segment.rows[0])}`);
const retention = await db.query(`select public.run_retention_maintenance('00000000-0000-0000-0000-000000000001',100) as result`);
if (!retention.rows[0].result.runId) throw new Error("Retention maintenance did not produce a run");

// Rate limiting gates every authenticated API request, and its counter table is pruned by
// the maintenance worker. Both halves are asserted here: the limit must be enforced exactly
// at the boundary, and pruning must drop only windows outside the retention interval.
const rateLimitTenant = "00000000-0000-0000-0000-000000000001";
const rateLimitDecisions = [];
for (let attempt = 0; attempt < 3; attempt += 1) {
  const consumed = await db.query(
    `select public.consume_rate_limit($1,'verify-bucket',2,60) as allowed`,
    [rateLimitTenant],
  );
  rateLimitDecisions.push(consumed.rows[0].allowed);
}
if (JSON.stringify(rateLimitDecisions) !== JSON.stringify([true, true, false])) {
  throw new Error(`Rate limit did not enforce its boundary exactly: ${JSON.stringify(rateLimitDecisions)}`);
}
await db.exec(`
  insert into public.rate_limit_counters(tenant_id,bucket_key,window_started_at,request_count)
  values('${rateLimitTenant}','verify-stale-bucket',now()-interval '2 hours',5);
`);
const pruned = await db.query(`select public.prune_rate_limit_counters(interval '1 hour',1000) as deleted`);
if (Number(pruned.rows[0].deleted) !== 1) {
  throw new Error(`Rate limit pruning did not delete exactly the stale window: ${JSON.stringify(pruned.rows[0])}`);
}
const survivingCounters = await db.query(
  `select count(*)::int as count from public.rate_limit_counters where tenant_id=$1 and bucket_key='verify-bucket'`,
  [rateLimitTenant],
);
if (Number(survivingCounters.rows[0].count) !== 1) {
  throw new Error(`Rate limit pruning removed the live window: ${JSON.stringify(survivingCounters.rows[0])}`);
}
await db.exec(`
  update public.profiles set active_tenant_id='00000000-0000-0000-0000-000000000001' where id='00000000-0000-0000-0000-000000000002';
  select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
  insert into public.import_runs(id,tenant_id,name,source_type,status,uploaded_by,total_rows,simulation,scan_status,scan_provider,scan_sha256,scan_completed_at)
  values('00000000-0000-0000-0000-000000000009','00000000-0000-0000-0000-000000000001','Runtime JSON','json','preview_ready','00000000-0000-0000-0000-000000000002',1,true,'clean','verify','sha',now());
  insert into public.import_rows(tenant_id,import_run_id,row_number,raw_data,normalized_data,decision,errors)
  values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000009',2,'{"name":"Imported Runtime AB"}','{"display_name":"Imported Runtime AB","customer_type":"company","organization_number":"5599999999","city":"Lund","phone_e164":"+46709999999","contacts":[{"full_name":"Imported Runtime Owner","role":"Ägare","phone_e164":"+46707777777","ownership_percentage":100,"source_external_id":"runtime-owner-1"}]}','ready','[]');
`);
const imported = await db.query(`select public.process_import_run('00000000-0000-0000-0000-000000000009') as result`);
if (Number(imported.rows[0].result.new) !== 1 || Number(imported.rows[0].result.newContacts) !== 1 || Number(imported.rows[0].result.catalogSynced) !== 1) throw new Error(`Secure import execution failed: ${JSON.stringify(imported.rows[0])}`);
const importedLink = await db.query(`select me.canonical_name,te.customer_id from public.master_entities me join public.tenant_entities te on te.master_entity_id=me.id and te.tenant_id='00000000-0000-0000-0000-000000000001' where me.organization_number='5599999999'`);
if (importedLink.rows.length !== 1 || !importedLink.rows[0].customer_id) throw new Error(`Tenant import catalogue synchronization failed: ${JSON.stringify(importedLink.rows)}`);
const importedContact = await db.query(`select full_name,role,phone_e164,ownership_percentage,source_external_id from public.contact_people where tenant_id='00000000-0000-0000-0000-000000000001' and customer_id=$1`, [importedLink.rows[0].customer_id]);
if (importedContact.rows.length !== 1 || importedContact.rows[0].phone_e164 !== '+46707777777' || importedContact.rows[0].source_external_id !== 'runtime-owner-1') throw new Error(`Imported contact-person upsert failed: ${JSON.stringify(importedContact.rows)}`);
await db.exec(`
  update public.tenant_features set enabled=true where tenant_id='00000000-0000-0000-0000-000000000001' and feature_key='outbound_calls';
  insert into public.tenant_settings(tenant_id,compliance) values('00000000-0000-0000-0000-000000000001','{"allowed_call_isodow":[1,2,3,4,5,6,7],"call_start_local":"00:00:00","call_end_local":"23:59:59.999999"}') on conflict(tenant_id) do update set compliance=excluded.compliance;
  insert into public.nix_provider_configurations(id,tenant_id,name,status,endpoint_template,allowed_domains,allowed_paths,result_path,result_mapping,validity_days,created_by)
  values('00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000001','Verify NIX','active','https://nix.example.test/check/{{phone_e164}}','{nix.example.test}','{/check}','result','{"listed":"listed","not_listed":"not_listed","unknown":"unknown"}',60,'00000000-0000-0000-0000-000000000002');
  insert into public.customers(id,tenant_id,customer_type,display_name,phone_e164,lifecycle,marketing_allowed,legal_basis,created_by)
  values('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001','person','NIX Runtime Person','+46701111111','prospect',true,'legitimate_interest','00000000-0000-0000-0000-000000000002');
  insert into public.campaigns(id,tenant_id,name,status,created_by)
  values('00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000001','NIX Runtime Campaign','draft','00000000-0000-0000-0000-000000000002');
  insert into public.campaign_contact_candidates(tenant_id,campaign_id,customer_id,status,policy_reason)
  values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000011','pending_nix','nix_check_required');
`);
const queuedNix = await db.query(`select public.queue_nix_check_for_customer('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000002',false) as id`);
if (!queuedNix.rows[0].id) throw new Error("NIX queue did not return a job");
const claimedNix = await db.query(`select id,status,attempts from public.claim_nix_check_jobs('verify-nix-worker',10)`);
if (claimedNix.rows.length !== 1 || claimedNix.rows[0].status !== 'running') throw new Error(`NIX claim failed: ${JSON.stringify(claimedNix.rows)}`);
await db.query(`select public.complete_nix_check_job($1,'not_listed','verify-v1','{"responseHash":"verify"}'::jsonb)`, [String(claimedNix.rows[0].id)]);
const nixResume = await db.query(`select c.status,c.policy_reason,exists(select 1 from public.campaign_members cm where cm.campaign_id=c.campaign_id and cm.customer_id=c.customer_id) as campaign_member from public.campaign_contact_candidates c where c.campaign_id='00000000-0000-0000-0000-000000000012' and c.customer_id='00000000-0000-0000-0000-000000000011'`);
if (nixResume.rows.length !== 1 || nixResume.rows[0].status !== 'approved' || !nixResume.rows[0].campaign_member) throw new Error(`NIX campaign resume failed: ${JSON.stringify(nixResume.rows)}`);
await db.exec(`insert into public.data_subject_requests(id,tenant_id,request_type,subject_reference,customer_id,status,identity_verified_at,created_by) values('00000000-0000-0000-0000-000000000013','00000000-0000-0000-0000-000000000001','erasure','runtime-person','00000000-0000-0000-0000-000000000011','processing',now(),'00000000-0000-0000-0000-000000000002')`);
const dsarExport = await db.query(`select public.data_subject_export_for_request('00000000-0000-0000-0000-000000000013') as result`);
if (dsarExport.rows[0].result.customer.display_name !== 'NIX Runtime Person') throw new Error(`DSAR export failed: ${JSON.stringify(dsarExport.rows[0])}`);
const dsarErasure = await db.query(`select public.execute_data_subject_erasure('00000000-0000-0000-0000-000000000013','00000000-0000-0000-0000-000000000002') as result`);
if (!dsarErasure.rows[0].result.anonymized) throw new Error(`DSAR erasure failed: ${JSON.stringify(dsarErasure.rows[0])}`);
const erasedCustomer = await db.query(`select display_name,phone_e164,email,deleted_at from public.customers where id='00000000-0000-0000-0000-000000000011'`);
const suppression = await db.query(`select count(*)::int as count from public.compliance_blocks where tenant_id='00000000-0000-0000-0000-000000000001' and phone_e164='+46701111111' and active`);
if (!String(erasedCustomer.rows[0].display_name).startsWith('Raderad kund ') || erasedCustomer.rows[0].phone_e164 !== null || Number(suppression.rows[0].count) !== 1) throw new Error(`DSAR minimization/suppression failed: ${JSON.stringify({erasedCustomer:erasedCustomer.rows,suppression:suppression.rows})}`);
console.log("Executed canonical data-platform runtime path: scheduler, raw payload, resolver, licensed directory, geography, quality, segment, secure import, NIX campaign resume, DSAR and retention.");

// Onboarding must be safe against double-clicks, retries and overlapping tenant bootstrap triggers.
await db.exec(`
  insert into auth.users(id,email,raw_user_meta_data)
  values('00000000-0000-0000-0000-000000000014','platform-owner@example.test','{"full_name":"Platform Owner"}');
  select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000014',false);
`);
const firstTenant = await db.query(`select public.create_tenant_with_owner('Kundexa Control','Kundexa Platform AB','5599990001') as id`);
const secondTenant = await db.query(`select public.create_tenant_with_owner('Should not duplicate','Should not duplicate AB','5599990002') as id`);
const onboardingTenantId = String(firstTenant.rows[0].id);
if (onboardingTenantId !== String(secondTenant.rows[0].id)) throw new Error("Onboarding replay created a second tenant");
const onboardingState = await db.query(`
  select
    (select count(*)::int from public.tenants where id=$1) as tenants,
    (select count(*)::int from public.tenant_memberships where tenant_id=$1 and user_id='00000000-0000-0000-0000-000000000014') as memberships,
    (select count(*)::int from public.teams where tenant_id=$1 and name='Huvudteam') as teams,
    (select count(*)::int from public.tenant_settings where tenant_id=$1) as settings,
    (select count(*)::int from public.tenant_features where tenant_id=$1) as features,
    (select count(*)::int from public.customer_statuses where tenant_id=$1) as statuses,
    (select count(*)::int from public.pipelines where tenant_id=$1 and name='Nyförsäljning') as pipelines,
    (select count(*)::int from public.pipeline_stages where tenant_id=$1) as stages,
    (select count(*)::int from public.tenant_legal_entities where tenant_id=$1 and is_default and active) as legal_entities
`, [onboardingTenantId]);
const os = onboardingState.rows[0];
if (Number(os.tenants)!==1 || Number(os.memberships)!==1 || Number(os.teams)!==1 || Number(os.settings)!==1 || Number(os.features)!==16 || Number(os.statuses)!==9 || Number(os.pipelines)!==1 || Number(os.stages)!==8 || Number(os.legal_entities)!==1) {
  throw new Error(`Idempotent onboarding state invalid: ${JSON.stringify(os)}`);
}

// Seed the first platform owner through trusted SQL, then verify audited role and tenant controls.
await db.exec(`
  insert into public.platform_memberships(user_id,role,status,created_by)
  values('00000000-0000-0000-0000-000000000014','platform_owner','active','00000000-0000-0000-0000-000000000014');
  insert into auth.users(id,email) values('00000000-0000-0000-0000-000000000015','platform-admin@example.test');
`);
await db.query(`select public.set_platform_membership($1,'platform_admin','active','Runtime verifiering av delegerad administration')`, ['00000000-0000-0000-0000-000000000015']);
await db.query(`select public.set_tenant_platform_status($1,'suspended','Runtime verifiering av tenantstyrning')`, [onboardingTenantId]);
const platformState = await db.query(`
  select
    (select status from public.tenants where id=$1) as tenant_status,
    (select role::text from public.platform_memberships where user_id='00000000-0000-0000-0000-000000000015') as delegated_role,
    (select count(*)::int from public.platform_audit_logs where actor_user_id='00000000-0000-0000-0000-000000000014') as audit_count
`, [onboardingTenantId]);
if (platformState.rows[0].tenant_status!=='suspended' || platformState.rows[0].delegated_role!=='platform_admin' || Number(platformState.rows[0].audit_count)!==2) {
  throw new Error(`Platform administration runtime failed: ${JSON.stringify(platformState.rows[0])}`);
}
let lastOwnerProtected = false;
try {
  await db.query(`select public.set_platform_membership($1,'platform_admin','active','Should fail because this is the last owner')`, ['00000000-0000-0000-0000-000000000014']);
} catch (error) {
  lastOwnerProtected = String(error).includes('last_platform_owner_cannot_be_removed');
}
if (!lastOwnerProtected) throw new Error("Last platform owner protection did not trigger");
console.log("Executed idempotent onboarding and audited platform-administration runtime path.");

// Platform list bank -> tenant -> team -> seller, including invitation activation,
// team-level pause/capacity and safe revocation that preserves already-started work.
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000014',false)`);
const distributedBootstrap = await db.query(`
  select public.create_or_resume_platform_tenant_owner(
    'Distributed Verify','Distributed Verify AB','5599000001','SE','Europe/Stockholm','sv-SE',
    'distributed-owner@example.test',now()+interval '7 days','verify-platform-owner'
  ) as result
`);
const distributedTenantId = String(distributedBootstrap.rows[0].result.tenant_id);
const distributedDefaultTeamId = String(distributedBootstrap.rows[0].result.default_team_id);
const distributedOwnerInvitationId = String(distributedBootstrap.rows[0].result.invitation_id);
await db.exec(`
  insert into auth.users(id,email,raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000040','distributed-owner@example.test','{"full_name":"Distributed Owner","provisioned_by_kundexa":true}'),
    ('00000000-0000-0000-0000-000000000041','distributed-seller@example.test','{"full_name":"Distributed Seller"}'),
    ('00000000-0000-0000-0000-000000000042','distributed-lead@example.test','{"full_name":"Distributed Team Lead"}');
`);
await db.query(`select public.provision_user_security_state('00000000-0000-0000-0000-000000000040','00000000-0000-0000-0000-000000000014')`);
await db.query(`select public.mark_tenant_invitation_auth_provisioned($1,'00000000-0000-0000-0000-000000000040',true)`, [distributedOwnerInvitationId]);
await db.query(`select public.finalize_tenant_invitation($1,'00000000-0000-0000-0000-000000000040')`, [distributedOwnerInvitationId]);
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000040',false)`);
const ownerGate = await db.query(`select * from public.current_user_security_state()`);
if (!ownerGate.rows[0]?.must_change_password) throw new Error(`New owner did not receive first-login password gate: ${JSON.stringify(ownerGate.rows)}`);
const ownerBeforePassword = await db.query(`select status,primary_team_id from public.tenant_memberships where tenant_id=$1 and user_id='00000000-0000-0000-0000-000000000040'`, [distributedTenantId]);
if (ownerBeforePassword.rows[0]?.status !== 'invited' || ownerBeforePassword.rows[0]?.primary_team_id) throw new Error(`Owner became operational before password replacement: ${JSON.stringify(ownerBeforePassword.rows)}`);
await db.query(`select public.complete_user_password_change('00000000-0000-0000-0000-000000000040')`);
const activatedOwner = await db.query(`select public.activate_current_user_invitation() as tenant_id`);
if (String(activatedOwner.rows[0].tenant_id) !== distributedTenantId) throw new Error(`Tenant owner invitation activation failed after password replacement: ${JSON.stringify(activatedOwner.rows)}`);
const ownerTenantState = await db.query(`select onboarding_status from public.tenants where id=$1`, [distributedTenantId]);
if (ownerTenantState.rows[0]?.onboarding_status !== 'active') throw new Error(`Owner activation did not activate tenant after password replacement: ${JSON.stringify(ownerTenantState.rows)}`);
let crossTenantSegmentBlocked = false;
try {
  await db.query(`select public.refresh_segment_materialization('00000000-0000-0000-0000-000000000008','00000000-0000-0000-0000-000000000040')`);
} catch (error) {
  crossTenantSegmentBlocked = String(error).includes("segment_not_found");
}
if (!crossTenantSegmentBlocked) throw new Error("Authenticated cross-tenant segment refresh was not blocked");
let crossTenantCampaignBlocked = false;
try {
  await db.query(`select public.materialize_segment_to_campaign('00000000-0000-0000-0000-000000000008','00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000040')`);
} catch (error) {
  crossTenantCampaignBlocked = String(error).includes("segment_or_campaign_not_found");
}
if (!crossTenantCampaignBlocked) throw new Error("Authenticated cross-tenant campaign materialization was not blocked");
let scopedServiceTenantMismatchBlocked = false;
try {
  await db.query(`select public.refresh_segment_materialization_for_tenant($1,'00000000-0000-0000-0000-000000000008',null)`, [distributedTenantId]);
} catch (error) {
  scopedServiceTenantMismatchBlocked = String(error).includes("segment_not_found");
}
if (!scopedServiceTenantMismatchBlocked) throw new Error("Tenant-scoped service segment refresh accepted a foreign segment");
let scopedServiceCampaignMismatchBlocked = false;
try {
  await db.query(`select public.materialize_segment_to_campaign_for_tenant($1,'00000000-0000-0000-0000-000000000008','00000000-0000-0000-0000-000000000012',null)`, [distributedTenantId]);
} catch (error) {
  scopedServiceCampaignMismatchBlocked = String(error).includes("segment_or_campaign_not_found");
}
if (!scopedServiceCampaignMismatchBlocked) throw new Error("Tenant-scoped service campaign materialization accepted foreign resources");
const distributedTeamResult = await db.query(`select public.create_managed_team('Distribution Team','Runtime team','Sales','Malmö','distribution',true,25,'automatic') as id`);
const distributedTeamId = String(distributedTeamResult.rows[0].id);
const ownerAutoManager = await db.query(`select count(*)::int as count from public.team_members where tenant_id=$1 and team_id=$2 and user_id='00000000-0000-0000-0000-000000000040' and role='manager'`, [distributedTenantId, distributedTeamId]);
if (Number(ownerAutoManager.rows[0].count) !== 0) throw new Error(`Owner/admin team creator was incorrectly auto-assigned as manager: ${JSON.stringify(ownerAutoManager.rows)}`);
let missingPrimaryRejected = false;
try {
  await db.query(`select public.reserve_tenant_invitation_v2($1,'no-primary@example.test','sales'::public.membership_role,array[$2]::uuid[],null,null,now()+interval '7 days','verify:no-primary')`, [distributedTenantId, distributedTeamId]);
} catch (error) {
  missingPrimaryRejected = String(error).includes('primary_team_required');
}
if (!missingPrimaryRejected) throw new Error('Sales provisioning without an explicit primary team was not rejected');
await db.query(`select public.register_tenant_invitation($1,'00000000-0000-0000-0000-000000000041','distributed-seller@example.test','sales'::public.membership_role,array[$2]::uuid[],'Seller invite',now()+interval '7 days')`, [distributedTenantId, distributedTeamId]);
await db.query(`select public.register_tenant_invitation($1,'00000000-0000-0000-0000-000000000042','distributed-lead@example.test','team_lead'::public.membership_role,array[$2]::uuid[],'Lead invite',now()+interval '7 days')`, [distributedTenantId, distributedTeamId]);
for (const userId of ['00000000-0000-0000-0000-000000000041','00000000-0000-0000-0000-000000000042']) {
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [userId]);
  const activation = await db.query(`select public.activate_current_user_invitation() as tenant_id`);
  if (String(activation.rows[0].tenant_id) !== distributedTenantId) throw new Error(`Seller/team-lead invitation activation failed for ${userId}`);
}
const explicitPrimaryState = await db.query(`
  select m.user_id,m.role,m.primary_team_id,tm.role as team_role,tm.is_primary
  from public.tenant_memberships m
  join public.team_members tm on tm.tenant_id=m.tenant_id and tm.user_id=m.user_id and tm.team_id=m.primary_team_id
  where m.tenant_id=$1 and m.user_id in ('00000000-0000-0000-0000-000000000041','00000000-0000-0000-0000-000000000042')
  order by m.user_id
`, [distributedTenantId]);
if (explicitPrimaryState.rows.length !== 2 || explicitPrimaryState.rows.some((row) => String(row.primary_team_id) !== distributedTeamId || row.is_primary !== true)) {
  throw new Error(`Explicit primary-team activation failed: ${JSON.stringify(explicitPrimaryState.rows)}`);
}
const leadState = explicitPrimaryState.rows.find((row) => row.role === 'team_lead');
if (!leadState || leadState.team_role !== 'manager') throw new Error(`Team lead was not activated as manager of the explicit primary team: ${JSON.stringify(explicitPrimaryState.rows)}`);
const sellerState = explicitPrimaryState.rows.find((row) => row.role === 'sales');
if (!sellerState || sellerState.team_role !== 'member') throw new Error(`Sales role received an invalid team-manager relation: ${JSON.stringify(explicitPrimaryState.rows)}`);

await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000040',false)`);
const explicitManagerTeam = await db.query(`select public.create_managed_team_v2('Managed Explicitly','Runtime manager assignment','Sales','Malmö','managed-explicit',true,25,'manual','00000000-0000-0000-0000-000000000042') as id`);
const explicitManagerTeamId = String(explicitManagerTeam.rows[0].id);
const explicitManagerState = await db.query(`select role from public.team_members where tenant_id=$1 and team_id=$2 and user_id='00000000-0000-0000-0000-000000000042'`, [distributedTenantId, explicitManagerTeamId]);
if (explicitManagerState.rows.length !== 1 || explicitManagerState.rows[0].role !== 'manager') throw new Error(`Explicit team manager assignment failed: ${JSON.stringify(explicitManagerState.rows)}`);
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000014',false)`);
const platformListResult = await db.query(`
  insert into public.platform_lists(name,source_provider,status,exclusivity_mode,default_exclusive_days,created_by)
  values('Runtime central list','verify','active','exclusive',30,'00000000-0000-0000-0000-000000000014') returning id
`);
const platformListId = String(platformListResult.rows[0].id);
await db.query(`
  insert into public.platform_list_entries(platform_list_id,source_key,organization_number,display_name,company_name,phone_e164,email,city,industry,state,data_hash)
  values
    ($1,'runtime-entry-1','5599000100','Runtime Prospect One','Runtime Prospect One AB','+46700000041','prospect-one@example.test','Malmö','IT','available','runtime-hash-1'),
    ($1,'runtime-entry-2','5599000101','Runtime Prospect Two','Runtime Prospect Two AB','+46700000042','prospect-two@example.test','Malmö','IT','available','runtime-hash-2')
`, [platformListId]);
await db.query(`select public.refresh_platform_list_counts($1)`, [platformListId]);
const allocationResult = await db.query(`select public.allocate_platform_list_to_tenant($1,$2,'Runtime tenant allocation',2,'{"city":"Malmö"}'::jsonb,'exclusive',null,null) as id`, [platformListId, distributedTenantId]);
const allocationId = String(allocationResult.rows[0].id);
const targetListResult = await db.query(`select target_list_id from public.platform_list_allocations where id=$1`, [allocationId]);
const targetListId = String(targetListResult.rows[0].target_list_id);
const materialized = await db.query(`select count(*)::int as members from public.customer_list_members where tenant_id=$1 and list_id=$2`, [distributedTenantId, targetListId]);
if (Number(materialized.rows[0].members) !== 2) throw new Error(`Platform allocation did not materialize two tenant leads: ${JSON.stringify(materialized.rows)}`);

await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000040',false)`);
const childListResult = await db.query(`select public.split_customer_list_to_team($1,$2,'Runtime team allocation',2,'shared_queue') as id`, [targetListId, distributedTeamId]);
const childListId = String(childListResult.rows[0].id);
const relinkedAllocationEntries = await db.query(`
  select count(*)::int as relinked
  from public.platform_list_allocation_entries ae
  join public.customer_list_members lm
    on lm.tenant_id=ae.tenant_id and lm.id=ae.list_member_id
  where ae.allocation_id=$1 and ae.tenant_id=$2 and lm.list_id=$3
`, [allocationId, distributedTenantId, childListId]);
if (Number(relinkedAllocationEntries.rows[0].relinked) !== 2) {
  throw new Error(`Platform allocation trail was not relinked to team members: ${JSON.stringify(relinkedAllocationEntries.rows)}`);
}
await db.query(`update public.customer_lists set status='active' where id=$1`, [childListId]);
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000042',false)`);
await db.query(`select public.set_customer_list_sellers($1,array['00000000-0000-0000-0000-000000000041']::uuid[])`, [childListId]);
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000041',false)`);
const sellerCanWork = await db.query(`select public.can_work_customer_list($1) as allowed`, [childListId]);
if (sellerCanWork.rows[0].allowed !== true) throw new Error(`Team seller could not work assigned list: ${JSON.stringify(sellerCanWork.rows)}`);

await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000040',false)`);
await db.query(`select public.set_managed_team_member($1,'00000000-0000-0000-0000-000000000041','member',true,null,true)`, [distributedTeamId]);
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000041',false)`);
const pausedSeller = await db.query(`select public.can_work_customer_list($1) as allowed`, [childListId]);
if (pausedSeller.rows[0].allowed !== false) throw new Error(`Paused team seller retained dialer access: ${JSON.stringify(pausedSeller.rows)}`);

await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000040',false)`);
await db.query(`select public.set_managed_team_member($1,'00000000-0000-0000-0000-000000000041','member',true,1,false)`, [distributedTeamId]);
await db.query(`update public.customer_list_members set claimed_by='00000000-0000-0000-0000-000000000041',claim_expires_at=now()+interval '10 minutes',state='claimed' where id=(select id from public.customer_list_members where list_id=$1 order by created_at limit 1)`, [childListId]);
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000041',false)`);
const cappedSeller = await db.query(`select public.can_work_customer_list($1) as allowed`, [childListId]);
if (cappedSeller.rows[0].allowed !== false) throw new Error(`Team daily lead limit was not enforced: ${JSON.stringify(cappedSeller.rows)}`);

await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000014',false)`);
const revokedAllocation = await db.query(`select public.revoke_platform_list_allocation($1,'Runtime safe revocation test') as removed`, [allocationId]);
if (Number(revokedAllocation.rows[0].removed) !== 1) throw new Error(`Expected one untouched lead to be reclaimed: ${JSON.stringify(revokedAllocation.rows)}`);
const allocationState = await db.query(`
  select
    (select count(*)::int from public.platform_list_allocation_entries where allocation_id=$1 and status='converted') as converted,
    (select count(*)::int from public.platform_list_allocation_entries where allocation_id=$1 and status='revoked') as revoked,
    (select count(*)::int from public.platform_list_allocation_entries where allocation_id=$1 and tenant_id=$2) as tenant_scoped_entries,
    (select count(*)::int from public.platform_list_allocation_entries where allocation_id=$1 and status='revoked' and list_member_id is null) as safely_detached_entries,
    (select count(*)::int from public.customer_list_members where tenant_id=$2 and list_id=$3) as preserved_members,
    (select count(*)::int from public.customer_lists where tenant_id=$2 and source_platform_allocation_id=$1 and status='paused') as paused_lists,
    (select consumed_entries from public.platform_lists where id=$4) as consumed_entries,
    (select available_entries from public.platform_lists where id=$4) as available_entries
`, [allocationId, distributedTenantId, childListId, platformListId]);
const allocationRuntime = allocationState.rows[0];
if (Number(allocationRuntime.converted)!==1 || Number(allocationRuntime.revoked)!==1 || Number(allocationRuntime.tenant_scoped_entries)!==2 || Number(allocationRuntime.safely_detached_entries)!==1 || Number(allocationRuntime.preserved_members)!==1 || Number(allocationRuntime.paused_lists)!==2 || Number(allocationRuntime.consumed_entries)!==1 || Number(allocationRuntime.available_entries)!==1) {
  throw new Error(`Safe platform allocation revocation failed: ${JSON.stringify(allocationRuntime)}`);
}
await db.exec(`
  select public.provision_user_security_state('00000000-0000-0000-0000-000000000041','00000000-0000-0000-0000-000000000040');
  select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000041',false);
`);
const firstLoginState = await db.query(`select * from public.current_user_security_state()`);
if (firstLoginState.rows.length !== 1 || firstLoginState.rows[0].must_change_password !== true) throw new Error(`First-login password gate state was not set: ${JSON.stringify(firstLoginState.rows)}`);
await db.query(`select public.complete_user_password_change('00000000-0000-0000-0000-000000000041')`);
const completedLoginState = await db.query(`select * from public.current_user_security_state()`);
if (completedLoginState.rows.length !== 1 || completedLoginState.rows[0].must_change_password !== false || !completedLoginState.rows[0].password_changed_at) throw new Error(`Password-change completion state invalid: ${JSON.stringify(completedLoginState.rows)}`);

console.log("Executed platform list bank, tenant invitation, team distribution, seller capacity and safe revocation runtime paths.");

// Execute the canonical prospect -> assigned list -> claim -> call -> after-work -> order path.
await db.exec(`
  select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
  begin;
  set constraints all deferred;
  insert into auth.users(id,email,raw_user_meta_data) values('00000000-0000-0000-0000-000000000020','seller@example.test','{"full_name":"Runtime Seller"}');
  insert into public.tenant_memberships(tenant_id,user_id,role,status,joined_at,primary_team_id) values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000020','sales','active',now(),'00000000-0000-0000-0000-000000000026');
  insert into public.teams(id,tenant_id,name,is_default) values('00000000-0000-0000-0000-000000000026','00000000-0000-0000-0000-000000000001','Runtime Sales Team',true);
  insert into public.team_members(tenant_id,team_id,user_id,role,is_primary)
    values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000026','00000000-0000-0000-0000-000000000020','member',true);
  update public.profiles set active_tenant_id='00000000-0000-0000-0000-000000000001' where id='00000000-0000-0000-0000-000000000020';
  insert into public.customers(id,tenant_id,customer_type,lifecycle,display_name,phone_e164,marketing_allowed,legal_basis,created_by)
  values
    ('00000000-0000-0000-0000-000000000021','00000000-0000-0000-0000-000000000001','company','prospect','Runtime Order Prospect','+46702222221',true,'legitimate_interest','00000000-0000-0000-0000-000000000002'),
    ('00000000-0000-0000-0000-000000000025','00000000-0000-0000-0000-000000000001','company','prospect','Runtime Callback Prospect','+46702222225',true,'legitimate_interest','00000000-0000-0000-0000-000000000002');
  insert into public.contact_people(id,tenant_id,customer_id,full_name,role,phone_e164,is_primary)
  values('00000000-0000-0000-0000-000000000027','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000021','Runtime Owner','Ägare','+46708888888',true);
  insert into public.nix_checks(tenant_id,customer_id,phone_e164,source,source_version,result,checked_at,valid_until,evidence)
  values
    ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000021','+46708888888','runtime','1','not_listed',now(),now()+interval '30 days','{}'),
    ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000025','+46702222225','runtime','1','not_listed',now(),now()+interval '30 days','{}');
  insert into public.phone_numbers(id,tenant_id,number_e164,supports_voice,status,webhook_token_hash)
  values('00000000-0000-0000-0000-000000000022','00000000-0000-0000-0000-000000000001','+46401234567',true,'active','runtime-hash')
  on conflict(tenant_id,number_e164) do nothing;
  insert into public.products(id,tenant_id,name,sku,active) values('00000000-0000-0000-0000-000000000023','00000000-0000-0000-0000-000000000001','Runtime Product','RUNTIME-PRODUCT',true);
  insert into public.product_price_versions(id,tenant_id,product_id,version,currency,setup_fee,recurring_fee,valid_from,active)
  values('00000000-0000-0000-0000-000000000024','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000023',1,'SEK',100,200,current_date,true);
  commit;
`);
const defaultTeam = await db.query(`select id from public.teams where tenant_id='00000000-0000-0000-0000-000000000001' and is_default limit 1`);
const runtimeTeamId = String(defaultTeam.rows[0].id);
const runtimeList = await db.query(`select public.create_managed_customer_list('Runtime Dialer','Full runtime path','static',$1,'automatic',100,'00:00','23:59:59',7,60,0,'both',true,false,'Runtime script') as id`, [runtimeTeamId]);
const runtimeListId = String(runtimeList.rows[0].id);
await db.query(`select public.update_customer_list_configuration($1,'Runtime Dialer','Full runtime path','active','automatic',100,'00:00','23:59:59',7,60,0,'both',true,false,true,'Runtime script','Europe/Stockholm','{1,2,3,4,5,6,7}','00000000-0000-0000-0000-000000000022',true,null,null)`, [runtimeListId]);
await db.query(`select public.set_customer_list_sellers($1,array['00000000-0000-0000-0000-000000000020']::uuid[])`, [runtimeListId]);
await db.query(`select public.add_customers_to_list($1,array['00000000-0000-0000-0000-000000000021','00000000-0000-0000-0000-000000000025']::uuid[])`, [runtimeListId]);
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000020',false)`);
const runtimeSession = await db.query(`select public.start_dialer_session($1) as id`, [runtimeListId]);
const runtimeSessionId = String(runtimeSession.rows[0].id);
const runtimeClaim = await db.query(`select public.claim_next_list_member_with_contacts($1,$2) as claim`, [runtimeListId, runtimeSessionId]);
const firstClaim = runtimeClaim.rows[0].claim;
if (firstClaim.empty || firstClaim.customer?.id !== '00000000-0000-0000-0000-000000000021') throw new Error(`Dialer claim failed: ${JSON.stringify(firstClaim)}`);
const ownerTarget = firstClaim.phoneOptions?.find((option) => option.contactPersonId === '00000000-0000-0000-0000-000000000027' && option.phone === '+46708888888');
if (!ownerTarget || ownerTarget.eligibility !== 'eligible' || firstClaim.contacts?.length !== 1) throw new Error(`Dialer contact targets failed: ${JSON.stringify(firstClaim)}`);
const runtimeCall = await db.query(`select public.queue_list_outbound_call_target($1,$2,null,$3,$4,'runtime-token-hash','runtime-token','+46703333333','runtime-list-call','direct_marketing') as id`, [runtimeSessionId, firstClaim.memberId, ownerTarget.contactPersonId, ownerTarget.phone]);
const runtimeCallId = String(runtimeCall.rows[0].id);
const listCallPolicy = await db.query(`select from_number,to_number,contact_person_id,recording_enabled from public.calls where id=$1`, [runtimeCallId]);
if (listCallPolicy.rows[0].from_number !== '+46401234567' || listCallPolicy.rows[0].to_number !== '+46708888888' || String(listCallPolicy.rows[0].contact_person_id) !== ownerTarget.contactPersonId || listCallPolicy.rows[0].recording_enabled !== true) throw new Error(`List contact target/caller ID/recording policy failed: ${JSON.stringify(listCallPolicy.rows[0])}`);
await db.query(`update public.calls set status='completed',ended_at=now(),duration_seconds=42 where id=$1`, [runtimeCallId]);
const completedDialer = await db.query(`select public.complete_dialer_work($1,'order','Converted in runtime',null,null,true,'00000000-0000-0000-0000-000000000023',1,null,'runtime-after-work') as result`, [runtimeCallId]);
if (!completedDialer.rows[0].result.orderId) throw new Error(`Dialer order completion failed: ${JSON.stringify(completedDialer.rows[0])}`);
const orderState = await db.query(`select o.status,o.total,c.lifecycle,lm.state from public.sales_orders o join public.customers c on c.id=o.customer_id join public.customer_list_members lm on lm.list_id=o.source_list_id and lm.customer_id=o.customer_id where o.source_call_id=$1`, [runtimeCallId]);
if (orderState.rows.length !== 1 || orderState.rows[0].status !== 'confirmed' || Number(orderState.rows[0].total) !== 300 || orderState.rows[0].lifecycle !== 'customer' || orderState.rows[0].state !== 'completed') throw new Error(`Dialer/order canonical state failed: ${JSON.stringify(orderState.rows)}`);
await db.query(`insert into public.activities(tenant_id,customer_id,type,status,title,assigned_team_id,priority,due_at,created_by,list_id,callback_scope) values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000025','callback','open','Runtime Global Callback',$1,'high',now()-interval '1 minute','00000000-0000-0000-0000-000000000020',$2,'global')`, [runtimeTeamId, runtimeListId]);
const callbackClaim = await db.query(`select public.claim_next_list_member($1,$2) as claim`, [runtimeListId, runtimeSessionId]);
if (!callbackClaim.rows[0].claim.callbackActivityId || callbackClaim.rows[0].claim.customer?.id !== '00000000-0000-0000-0000-000000000025') throw new Error(`Global callback priority/claim failed: ${JSON.stringify(callbackClaim.rows[0].claim)}`);
await db.query(`select public.release_list_member_claim($1,'end')`, [runtimeSessionId]);
const releasedCallback = await db.query(`select status,claimed_by from public.activities where id=$1`, [callbackClaim.rows[0].claim.callbackActivityId]);
if (releasedCallback.rows[0].status !== 'open' || releasedCallback.rows[0].claimed_by !== null) throw new Error(`Released list callback remained claimed: ${JSON.stringify(releasedCallback.rows[0])}`);
const manualCallback = await db.query(`insert into public.activities(tenant_id,customer_id,type,status,title,assigned_team_id,priority,due_at,created_by,callback_scope) values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000025','callback','open','Runtime Standalone Callback',$1,'high',now()-interval '1 minute','00000000-0000-0000-0000-000000000020','global') returning id`, [runtimeTeamId]);
const manualCallbackId = String(manualCallback.rows[0].id);
const claimedManual = await db.query(`select public.claim_customer_callback($1) as result`, [manualCallbackId]);
if (claimedManual.rows[0].result.customerId !== '00000000-0000-0000-0000-000000000025') throw new Error(`Standalone callback claim failed: ${JSON.stringify(claimedManual.rows[0])}`);
const manualCall = await db.query(`select public.queue_callback_outbound_call($1,'00000000-0000-0000-0000-000000000025','runtime-manual-token-hash','runtime-manual-token','+46703333333','runtime-manual-callback-call','direct_marketing') as id`, [manualCallbackId]);
const manualCallId = String(manualCall.rows[0].id);
await db.query(`update public.calls set status='completed',ended_at=now(),duration_seconds=17 where id=$1`, [manualCallId]);
await db.query(`select public.complete_manual_call_work($1,'interested','Handled atomically',null,null)`, [manualCallId]);
const manualState = await db.query(`select a.status,c.disposition,c.callback_activity_id,(select count(*) from public.notes n where n.call_id=c.id) as notes from public.activities a join public.calls c on c.callback_activity_id=a.id where a.id=$1`, [manualCallbackId]);
if (manualState.rows[0].status !== 'completed' || manualState.rows[0].disposition !== 'interested' || Number(manualState.rows[0].notes) !== 1) throw new Error(`Manual callback after-work failed: ${JSON.stringify(manualState.rows[0])}`);
console.log("Executed prospecting/list assignment, atomic claim, contact-person target selection, NIX gating, canonical calls, caller-ID/recording policy, order after-work and personal/global callback runtime paths.");

// Rinkel runtime path: tenant-owned connection, seller mapping, transactional
// reservation, idempotent replay, provider finalization and one-device lock.
if (false) {
await db.exec(`
  select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
  select set_config('request.jwt.claim.role','authenticated',false);
  update public.telephony_policies set allowed_days='{1,2,3,4,5,6,7}',allowed_start_time='00:00',allowed_end_time='23:59:59'
    where tenant_id='00000000-0000-0000-0000-000000000001';
  insert into public.customers(id,tenant_id,customer_type,display_name,phone_e164,lifecycle,marketing_allowed,legal_basis,created_by)
  values('00000000-0000-0000-0000-000000000040','00000000-0000-0000-0000-000000000001','company','Rinkel Runtime AB','+46704444444','customer',true,'contract','00000000-0000-0000-0000-000000000002');
  insert into public.tenant_integrations(id,tenant_id,provider_type,provider,name,credentials_ciphertext,status,created_by)
  values('00000000-0000-0000-0000-000000000041','00000000-0000-0000-0000-000000000001','telephony','rinkel','Rinkel Runtime','encrypted-test-value','connected','00000000-0000-0000-0000-000000000002');
  insert into public.rinkel_users(id,tenant_id,connection_id,external_user_id,external_device_id,display_name)
  values('00000000-0000-0000-0000-000000000042','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000041','rinkel-user-runtime','rinkel-device-runtime','Runtime Owner');
  insert into public.rinkel_numbers(id,tenant_id,connection_id,external_number_id,phone_number_e164,display_name,active)
  values('00000000-0000-0000-0000-000000000043','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000041','rinkel-number-runtime','+46855554444','Runtime number',true);
  select public.replace_rinkel_user_mapping(
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000042',
    '00000000-0000-0000-0000-000000000043'
  );
`);
const rinkelAutomaticList = await db.query(`select public.create_managed_customer_list('Rinkel Webhook Gate','Runtime webhook health gate','static',$1,'automatic',100,'00:00','23:59:59',3,60,0,'both',true,false,'Runtime') as id`, [runtimeTeamId]);
const rinkelAutomaticListId = String(rinkelAutomaticList.rows[0].id);
await db.query(`select public.update_customer_list_configuration($1,'Rinkel Webhook Gate','Runtime webhook health gate','active','automatic',100,'00:00','23:59:59',3,60,0,'both',true,false,true,'Runtime','Europe/Stockholm','{1,2,3,4,5,6,7}',null,false,null,null)`, [rinkelAutomaticListId]);
await db.query(`select public.add_customers_to_list($1,array['00000000-0000-0000-0000-000000000040']::uuid[])`, [rinkelAutomaticListId]);
const rinkelAutomaticSession = await db.query(`select public.start_dialer_session($1) as id`, [rinkelAutomaticListId]);
const rinkelAutomaticSessionId = String(rinkelAutomaticSession.rows[0].id);
const rinkelAutomaticClaim = await db.query(`select public.claim_next_list_member($1,$2) as claim`, [rinkelAutomaticListId, rinkelAutomaticSessionId]);
const rinkelAutomaticMemberId = String(rinkelAutomaticClaim.rows[0].claim.memberId);
let unhealthyAutomaticBlocked = false;
try {
  await db.query(`
    select public.rinkel_reserve_outbound_call(
      '00000000-0000-0000-0000-000000000040',null,'+46704444444',$1,$2,null,
      '00000000-0000-0000-0000-000000000047','rinkel-runtime-auto-blocked','customer_service'
    )
  `, [rinkelAutomaticSessionId, rinkelAutomaticMemberId]);
} catch (error) {
  unhealthyAutomaticBlocked = String(error).includes("automatic_dialer_requires_healthy_rinkel_webhooks");
}
if (!unhealthyAutomaticBlocked) throw new Error("Automatic Rinkel dialer bypassed the database webhook health gate");
await db.exec(`
  insert into public.rinkel_capabilities(tenant_id,connection_id,api_access,dial,webhooks)
  values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000041',true,true,true);
  update public.tenant_integrations set webhook_status='active'
  where id='00000000-0000-0000-0000-000000000041';
`);
const healthyAutomatic = await db.query(`
  select public.rinkel_reserve_outbound_call(
    '00000000-0000-0000-0000-000000000040',null,'+46704444444',$1,$2,null,
    '00000000-0000-0000-0000-000000000048','rinkel-runtime-auto-healthy','customer_service'
  ) as result
`, [rinkelAutomaticSessionId, rinkelAutomaticMemberId]);
if (!healthyAutomatic.rows[0].result.callId) throw new Error(`Healthy automatic Rinkel reservation failed: ${JSON.stringify(healthyAutomatic.rows[0])}`);
await db.query(`update public.calls set status='completed',ended_at=now() where id=$1`, [healthyAutomatic.rows[0].result.callId]);
await db.query(`update public.call_attempts set status='completed' where id=$1`, [healthyAutomatic.rows[0].result.attemptId]);
const rinkelFirst = await db.query(`
  select public.rinkel_reserve_outbound_call(
    '00000000-0000-0000-0000-000000000040',null,'+46704444444',null,null,null,
    '00000000-0000-0000-0000-000000000044','rinkel-runtime-1','customer_service'
  ) as result
`);
const rinkelFirstResult = rinkelFirst.rows[0].result;
if (rinkelFirstResult.idempotentReplay !== false || !rinkelFirstResult.callId || !rinkelFirstResult.attemptId) {
  throw new Error(`Rinkel reservation failed: ${JSON.stringify(rinkelFirstResult)}`);
}
const rinkelReplay = await db.query(`
  select public.rinkel_reserve_outbound_call(
    '00000000-0000-0000-0000-000000000040',null,'+46704444444',null,null,null,
    '00000000-0000-0000-0000-000000000044','rinkel-runtime-1','customer_service'
  ) as result
`);
if (rinkelReplay.rows[0].result.idempotentReplay !== true || rinkelReplay.rows[0].result.callId !== rinkelFirstResult.callId) {
  throw new Error(`Rinkel idempotent replay failed: ${JSON.stringify(rinkelReplay.rows[0])}`);
}
let rinkelConcurrentBlocked = false;
try {
  await db.query(`
    select public.rinkel_reserve_outbound_call(
      '00000000-0000-0000-0000-000000000040',null,'+46704444444',null,null,null,
      '00000000-0000-0000-0000-000000000045','rinkel-runtime-2','customer_service'
    )
  `);
} catch (error) {
  rinkelConcurrentBlocked = String(error).includes("active_call_already_exists");
}
if (!rinkelConcurrentBlocked) throw new Error("Rinkel one-device active-call lock failed");
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.query(`select public.rinkel_finalize_dial_request($1,$2,'accepted',null,null)`, [rinkelFirstResult.callId, rinkelFirstResult.attemptId]);
const finalizedRinkel = await db.query(`select c.status call_status,a.status attempt_status from public.calls c join public.call_attempts a on a.call_id=c.id where c.id=$1`, [rinkelFirstResult.callId]);
if (finalizedRinkel.rows[0].call_status !== "dial_requested" || finalizedRinkel.rows[0].attempt_status !== "awaiting_provider_event") {
  throw new Error(`Rinkel dial finalization failed: ${JSON.stringify(finalizedRinkel.rows[0])}`);
}
await db.query(`update public.calls set status='completed',ended_at=now() where id=$1`, [rinkelFirstResult.callId]);
await db.query(`update public.call_attempts set status='completed' where id=$1`, [rinkelFirstResult.attemptId]);
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false)`);
const rinkelNext = await db.query(`
  select public.rinkel_reserve_outbound_call(
    '00000000-0000-0000-0000-000000000040',null,'+46704444444',null,null,null,
    '00000000-0000-0000-0000-000000000046','rinkel-runtime-3','customer_service'
  ) as result
`);
if (!rinkelNext.rows[0].result.callId) throw new Error(`Rinkel lock release failed: ${JSON.stringify(rinkelNext.rows[0])}`);
console.log("Executed Rinkel tenant mapping, automatic webhook health gate, atomic reservation, idempotent replay, provider finalization and one-device lock runtime paths.");
}

// Central Rinkel platform path: one provider inventory, historical tenant
// allocations, tenant-filtered projections and central dial reservation.
await db.exec(`
  select set_config('request.jwt.claim.role','service_role',false);
  update public.platform_integrations set status='connected',webhook_status='verified',
    webhook_last_received_at=now(),capabilities='{"api_access":true,"dial":true,"webhooks":true,"users_catalog":true,"numbers_catalog":true,"dial_configured":true}'::jsonb
    where provider='rinkel' and disabled_at is null;
  insert into public.platform_rinkel_capabilities(
    platform_integration_id,api_access,users_catalog,numbers_catalog,dial_configured,
    core_webhooks_verified,webhooks
  ) select id,true,true,true,true,true,true
    from public.platform_integrations where provider='rinkel' and disabled_at is null
  on conflict(platform_integration_id) do update set
    api_access=true,users_catalog=true,numbers_catalog=true,dial_configured=true,
    core_webhooks_verified=true,webhooks=true;
  update public.telephony_policies set telephony_enabled=true,manual_dialer_enabled=true,
    automatic_dialer_enabled=true,allowed_days='{1,2,3,4,5,6,7}',
    allowed_start_time='00:00',allowed_end_time='23:59:59'
    where tenant_id='00000000-0000-0000-0000-000000000001';
  insert into auth.users(id,email) values
    ('00000000-0000-0000-0000-000000000050','seller-b@example.test'),
    ('00000000-0000-0000-0000-000000000074','admin-b@example.test');
  insert into public.tenants(id,slug,name,legal_name)
    values('00000000-0000-0000-0000-000000000051','rinkel-tenant-b','Rinkel Tenant B','Rinkel Tenant B AB');
  insert into public.teams(id,tenant_id,name,is_default)
    values('00000000-0000-0000-0000-000000000076','00000000-0000-0000-0000-000000000051','Rinkel Tenant B Sales',true);
  insert into public.tenant_memberships(tenant_id,user_id,role,status,joined_at,primary_team_id)
    values
    ('00000000-0000-0000-0000-000000000051','00000000-0000-0000-0000-000000000050','sales','active',now(),'00000000-0000-0000-0000-000000000076'),
    ('00000000-0000-0000-0000-000000000051','00000000-0000-0000-0000-000000000074','admin','active',now(),null);
  insert into public.team_members(tenant_id,team_id,user_id,role,is_primary)
    values('00000000-0000-0000-0000-000000000051','00000000-0000-0000-0000-000000000076','00000000-0000-0000-0000-000000000050','member',true);
  update public.profiles
    set active_tenant_id='00000000-0000-0000-0000-000000000051'
    where id in(
      '00000000-0000-0000-0000-000000000050',
      '00000000-0000-0000-0000-000000000074'
    );
  update public.telephony_policies set telephony_enabled=true,manual_dialer_enabled=true,
    allowed_days='{1,2,3,4,5,6,7}',allowed_start_time='00:00',allowed_end_time='23:59:59'
    where tenant_id='00000000-0000-0000-0000-000000000051';
  insert into public.platform_rinkel_users(
    id,platform_integration_id,external_user_id,external_device_id,display_name
  ) select '00000000-0000-0000-0000-000000000052',id,'platform-user-a','device-a','Platform User A'
    from public.platform_integrations where provider='rinkel' and disabled_at is null;
  insert into public.platform_rinkel_users(
    id,platform_integration_id,external_user_id,external_device_id,display_name
  ) select '00000000-0000-0000-0000-000000000053',id,'platform-user-b','device-b','Platform User B'
    from public.platform_integrations where provider='rinkel' and disabled_at is null;
  insert into public.platform_rinkel_users(
    id,platform_integration_id,external_user_id,external_device_id,display_name,raw_provider_data
  ) select '00000000-0000-0000-0000-000000000075',id,'platform-user-no-device',null,'Platform User No Device',
    '{"_kundexa_sync":{"device_inventory_complete":true,"device_inventory_source":"embedded_devices","device_inventory_error":null}}'::jsonb
    from public.platform_integrations where provider='rinkel' and disabled_at is null;
  insert into public.platform_rinkel_numbers(
    id,platform_integration_id,external_number_id,phone_number_e164,display_name
  ) select '00000000-0000-0000-0000-000000000054',id,'platform-number-a','+46811111111','Platform Number A'
    from public.platform_integrations where provider='rinkel' and disabled_at is null;
  insert into public.platform_rinkel_numbers(
    id,platform_integration_id,external_number_id,phone_number_e164,display_name
  ) select '00000000-0000-0000-0000-000000000055',id,'platform-number-b','+46822222222','Platform Number B'
    from public.platform_integrations where provider='rinkel' and disabled_at is null;
  insert into public.platform_rinkel_devices(
    id,platform_integration_id,platform_rinkel_user_id,provider_device_id,display_name,provider_status,active
  ) select '00000000-0000-0000-0000-000000000072',platform_integration_id,id,'device-a','Device A','active',true
    from public.platform_rinkel_users where id='00000000-0000-0000-0000-000000000052';
  insert into public.platform_rinkel_devices(
    id,platform_integration_id,platform_rinkel_user_id,provider_device_id,display_name,provider_status,active
  ) select '00000000-0000-0000-0000-000000000073',platform_integration_id,id,'device-b','Device B','active',true
    from public.platform_rinkel_users where id='00000000-0000-0000-0000-000000000053';
  insert into public.rinkel_user_allocations(id,rinkel_user_id,tenant_id)
    values
    ('00000000-0000-0000-0000-000000000056','00000000-0000-0000-0000-000000000052','00000000-0000-0000-0000-000000000001'),
    ('00000000-0000-0000-0000-000000000057','00000000-0000-0000-0000-000000000053','00000000-0000-0000-0000-000000000051');
  insert into public.rinkel_number_allocations(id,rinkel_number_id,tenant_id)
    values
    ('00000000-0000-0000-0000-000000000058','00000000-0000-0000-0000-000000000054','00000000-0000-0000-0000-000000000001'),
    ('00000000-0000-0000-0000-000000000059','00000000-0000-0000-0000-000000000055','00000000-0000-0000-0000-000000000051');
  insert into public.rinkel_number_grants(tenant_id,number_allocation_id)
    values
    ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000058'),
    ('00000000-0000-0000-0000-000000000051','00000000-0000-0000-0000-000000000059');
  insert into public.rinkel_user_mappings_v2(
    tenant_id,kundexa_user_id,rinkel_user_allocation_id,default_number_allocation_id,selected_device_id
  ) values
    ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000056','00000000-0000-0000-0000-000000000058','00000000-0000-0000-0000-000000000072');
`);
await db.exec(`
  select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000014',false);
  select set_config('request.jwt.claim.role','authenticated',false);
`);
let rejectedDeviceLessAllocation = false;
try {
  await db.query(`select public.allocate_platform_rinkel_resource(
    'user',
    '00000000-0000-0000-0000-000000000075',
    '00000000-0000-0000-0000-000000000051',
    'runtime device gate test'
  )`);
} catch (error) {
  rejectedDeviceLessAllocation = String(error).includes('RINKEL_USER_DEVICE_MISSING');
}
if (!rejectedDeviceLessAllocation) {
  throw new Error('Platform allocation accepted a Rinkel user without an active synchronized device.');
}
await db.exec(`
  select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000074',false);
  select set_config('request.jwt.claim.role','authenticated',false);
`);
const mappingResult = await db.query(`select public.replace_rinkel_user_mapping_v3(
  '00000000-0000-0000-0000-000000000050',
  '00000000-0000-0000-0000-000000000057',
  '00000000-0000-0000-0000-000000000059',
  '00000000-0000-0000-0000-000000000073'
) as mapping_id`);
if (!mappingResult.rows[0].mapping_id) {
  throw new Error(`Atomic seller mapping did not return an id: ${JSON.stringify(mappingResult.rows)}`);
}
const directSellerGrant = await db.query(`select count(*)::int as count
  from public.rinkel_number_grants
  where tenant_id='00000000-0000-0000-0000-000000000051'
    and number_allocation_id='00000000-0000-0000-0000-000000000059'
    and user_id='00000000-0000-0000-0000-000000000050'
    and team_id is null
    and access_level='dial'
    and active
    and is_default`);
if (Number(directSellerGrant.rows[0].count) !== 1) {
  throw new Error(`Seller mapping did not create exactly one active default dial grant: ${JSON.stringify(directSellerGrant.rows)}`);
}
let rejectedWrongDevice = false;
try {
  await db.query(`select public.replace_rinkel_user_mapping_v3(
    '00000000-0000-0000-0000-000000000050',
    '00000000-0000-0000-0000-000000000057',
    '00000000-0000-0000-0000-000000000059',
    '00000000-0000-0000-0000-000000000072'
  )`);
} catch (error) {
  rejectedWrongDevice = String(error).includes('DEVICE_MISSING');
}
if (!rejectedWrongDevice) {
  throw new Error('Mapping accepted a device belonging to another telephony user.');
}
const mappingAfterRejectedDevice = await db.query(`select count(*)::int as count
  from public.rinkel_user_mappings_v2
  where tenant_id='00000000-0000-0000-0000-000000000051'
    and kundexa_user_id='00000000-0000-0000-0000-000000000050'
    and selected_device_id='00000000-0000-0000-0000-000000000073'
    and active`);
if (Number(mappingAfterRejectedDevice.rows[0].count) !== 1) {
  throw new Error(`Rejected device attempt damaged the valid mapping: ${JSON.stringify(mappingAfterRejectedDevice.rows)}`);
}

let rejectedCrossTenantNumberAllocation = false;
try {
  await db.exec(`
    insert into public.rinkel_number_allocations(id,rinkel_number_id,tenant_id)
    values(
      '00000000-0000-0000-0000-000000000061',
      '00000000-0000-0000-0000-000000000054',
      '00000000-0000-0000-0000-000000000051'
    );
  `);
} catch (error) {
  rejectedCrossTenantNumberAllocation = String(error).includes('RINKEL_NUMBER_TENANT_CONFLICT');
}
if (!rejectedCrossTenantNumberAllocation) {
  throw new Error('Central Rinkel number was incorrectly allowed to have active allocations in multiple tenants.');
}
const singleTenantPlatformAllocation = await db.query(`select count(*)::int as count
  from public.rinkel_number_allocations
  where rinkel_number_id='00000000-0000-0000-0000-000000000054'
    and status='active' and valid_to is null`);
if (Number(singleTenantPlatformAllocation.rows[0].count) !== 1) {
  throw new Error(`Central Rinkel number single-tenant ownership invariant failed: ${JSON.stringify(singleTenantPlatformAllocation.rows)}`);
}
await db.exec(`
  select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
  select set_config('request.jwt.claim.role','authenticated',false);
`);
const tenantAResources = await db.query(`select public.get_tenant_rinkel_resources() as resources`);
if (
  tenantAResources.rows[0].resources.users.length !== 1
  || tenantAResources.rows[0].resources.numbers.length !== 1
  || tenantAResources.rows[0].resources.users[0].displayName !== "Platform User A"
  || tenantAResources.rows[0].resources.users[0].activeDeviceCount !== 1
  || typeof tenantAResources.rows[0].resources.users[0].deviceInventoryComplete !== "boolean"
  || tenantAResources.rows[0].resources.numbers[0].number !== "+46811111111"
) throw new Error(`Tenant A central Rinkel projection leaked, omitted device diagnostics or omitted resources: ${JSON.stringify(tenantAResources.rows[0])}`);
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000050',false)`);
const tenantBCallerIds = await db.query(`select public.get_current_user_rinkel_numbers() as numbers`);
if (
  tenantBCallerIds.rows[0].numbers.length !== 1
  || tenantBCallerIds.rows[0].numbers[0].number !== "+46822222222"
  || tenantBCallerIds.rows[0].numbers.some((item) => item.number === "+46811111111")
) {
  throw new Error(`Tenant B caller-ID projection leaked another tenant's Rinkel number: ${JSON.stringify(tenantBCallerIds.rows[0])}`);
}
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false)`);
const centralStatus = await db.query(`select public.telephony_status_for_current_user() as status`);
if (!centralStatus.rows[0].status.manualReady || !centralStatus.rows[0].status.userMapped) {
  throw new Error(`Central telephony status was not ready: ${JSON.stringify(centralStatus.rows[0])}`);
}
await db.exec(`
  update public.platform_integrations
  set status='unavailable',last_error_code='RINKEL_NETWORK_ERROR',last_error_message='Rinkel kunde inte nås.'
  where provider='rinkel' and disabled_at is null;
`);
const unavailableCentralStatus = await db.query(`select public.telephony_status_for_current_user() as status`);
if (
  unavailableCentralStatus.rows[0].status.platformReady
  || unavailableCentralStatus.rows[0].status.errorCode !== "RINKEL_UNAVAILABLE"
  || unavailableCentralStatus.rows[0].status.errorMessage !== "Telefonitjänsten kunde inte nås vid den senaste kontrollen."
) {
  throw new Error(`Central telephony diagnostics were not actionable: ${JSON.stringify(unavailableCentralStatus.rows[0])}`);
}
await db.exec(`
  update public.platform_integrations
  set status='connected',last_error_code=null,last_error_message=null
  where provider='rinkel' and disabled_at is null;
`);
const centralReservation = await db.query(`
  select public.rinkel_reserve_platform_outbound_call(
    '00000000-0000-0000-0000-000000000025',null,'+46702222225',null,null,null,
    '00000000-0000-0000-0000-000000000060','central-rinkel-runtime-1','customer_service'
  ) as result
`);
const centralResult = centralReservation.rows[0].result;
if (!centralResult.callId || centralResult.numberId !== "platform-number-a" || centralResult.deviceId !== "device-a") {
  throw new Error(`Central Rinkel reservation failed: ${JSON.stringify(centralResult)}`);
}
if (centralResult.purpose !== "direct_marketing") {
  throw new Error(`Central Rinkel purpose was not derived server-side: ${JSON.stringify(centralResult)}`);
}
const centralReplay = await db.query(`
  select public.rinkel_reserve_platform_outbound_call(
    '00000000-0000-0000-0000-000000000025',null,'+46703333333',null,null,null,
    '00000000-0000-0000-0000-000000000060','central-rinkel-runtime-1','customer_service'
  ) as result
`);
if (!centralReplay.rows[0].result.idempotentReplay || centralReplay.rows[0].result.callId !== centralResult.callId) {
  throw new Error(`Central Rinkel idempotent replay failed: ${JSON.stringify(centralReplay.rows[0])}`);
}
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.query(`select public.rinkel_finalize_platform_dial($1,$2,'accepted',null,null)`, [centralResult.callId, centralResult.attemptId]);
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false)`);
const centralFinal = await db.query(`select c.status call_status,a.status attempt_status
  from public.calls c join public.rinkel_call_attempts_v2 a on a.call_id=c.id where c.id=$1`, [centralResult.callId]);
if (centralFinal.rows[0].call_status !== "dial_requested" || centralFinal.rows[0].attempt_status !== "awaiting_provider_event") {
  throw new Error(`Central Rinkel finalization failed: ${JSON.stringify(centralFinal.rows[0])}`);
}
await db.exec(`
  update public.calls set status='completed',ended_at=now() where id='${centralResult.callId}';
  update public.rinkel_call_attempts_v2 set status='completed' where id='${centralResult.attemptId}';
  update public.rinkel_number_allocations set status='revoked',valid_to=now()
    where id='00000000-0000-0000-0000-000000000058';
`);
const historicalTenant = await db.query(`select tenant_id,metadata->>'number_allocation_id' allocation_id from public.calls where id=$1`, [centralResult.callId]);
if (
  historicalTenant.rows[0].tenant_id !== "00000000-0000-0000-0000-000000000001"
  || historicalTenant.rows[0].allocation_id !== "00000000-0000-0000-0000-000000000058"
) throw new Error(`Historical Rinkel call moved with number allocation: ${JSON.stringify(historicalTenant.rows[0])}`);
console.log("Executed central Rinkel catalog, two-tenant isolation, single-tenant number ownership, rejected cross-tenant allocation, atomic reservation, idempotent replay, provider finalization and immutable call history runtime paths.");

// Performance/scraper operations runtime path: aggregated RPCs, atomic ingestion
// quota reservation, admin run controls, dead-letter re-drive and duplicate-run guards.
await db.exec(`
  select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
  insert into public.pipelines(id,tenant_id,name) values('00000000-0000-0000-0000-000000000030','00000000-0000-0000-0000-000000000001','Verify pipeline');
  insert into public.pipeline_stages(id,tenant_id,pipeline_id,name,sort_order) values('00000000-0000-0000-0000-000000000031','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000030','Verify stage',1);
  insert into public.deals(tenant_id,customer_id,pipeline_id,stage_id,name,value,status) values
    ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000021','00000000-0000-0000-0000-000000000030','00000000-0000-0000-0000-000000000031','Won verify deal',300,'won'),
    ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000021','00000000-0000-0000-0000-000000000030','00000000-0000-0000-0000-000000000031','Open verify deal',100,'open');
`);
const dashboard = await db.query(`select public.dashboard_overview() as overview`);
const overview = dashboard.rows[0].overview;
if (Number(overview.wonDealValue) !== 300 || Number(overview.openDeals) !== 1 || Number(overview.customers) < 3 || Number(overview.callsToday) < 2) {
  throw new Error(`Dashboard aggregation failed: ${JSON.stringify(overview)}`);
}
const listOverview = await db.query(`select * from public.customer_list_overview($1)`, [runtimeListId]);
if (listOverview.rows.length !== 1 || Number(listOverview.rows[0].total_members) !== 2 || Number(listOverview.rows[0].open_members) !== 1 || Number(listOverview.rows[0].active_sellers) !== 1) {
  throw new Error(`Customer list aggregation failed: ${JSON.stringify(listOverview.rows)}`);
}
const candidateCounts = await db.query(`select public.customer_list_candidate_counts($1) as counts`, [runtimeListId]);
if (Number(candidateCounts.rows[0].counts.approved) !== 0 || Number(candidateCounts.rows[0].counts.blocked) !== 0) {
  throw new Error(`Candidate aggregation failed: ${JSON.stringify(candidateCounts.rows[0])}`);
}

// Ingestion quota: one unit per external call inside the configured window.
await db.exec(`
  insert into public.provider_rate_limits(tenant_id,provider_account_id,quota_key,window_seconds,max_units,max_concurrency,minimum_delay_ms,timeout_ms,max_retries)
  values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000004','ingestion',3600,2,1,250,30000,5);
`);
const firstReservation = await db.query(`select public.reserve_provider_ingestion_usage($1,1) as result`, [runId]);
const secondReservation = await db.query(`select public.reserve_provider_ingestion_usage($1,1) as result`, [runId]);
const thirdReservation = await db.query(`select public.reserve_provider_ingestion_usage($1,1) as result`, [runId]);
if (firstReservation.rows[0].result.allowed !== true || secondReservation.rows[0].result.allowed !== true) {
  throw new Error(`Ingestion quota reservation failed: ${JSON.stringify([firstReservation.rows[0], secondReservation.rows[0]])}`);
}
if (thirdReservation.rows[0].result.allowed !== false || Number(thirdReservation.rows[0].result.retryAfterSeconds) < 1) {
  throw new Error(`Ingestion quota exhaustion failed: ${JSON.stringify(thirdReservation.rows[0])}`);
}

// Sellers must not control system-wide ingestion runs; tenant admins may.
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000020',false)`);
let sellerBlocked = false;
try {
  await db.query(`select public.control_ingestion_run($1,'pause')`, [runId]);
} catch (error) {
  sellerBlocked = String(error).includes("admin_required");
}
if (!sellerBlocked) throw new Error("Seller was able to control ingestion runs");
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false)`);
const controlRun = await db.query(`
  insert into public.ingestion_runs(tenant_id,ingestion_job_id,status,requested_records,max_attempts,next_attempt_at,current_page)
  values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000007','scheduled',5000,5,now(),'3') returning id
`);
const controlRunId = String(controlRun.rows[0].id);
// Only one open run per job is allowed: a second open run must be rejected.
let duplicateBlocked = false;
try {
  await db.query(`insert into public.ingestion_runs(tenant_id,ingestion_job_id,status,requested_records) values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000007','scheduled',5000)`);
} catch (error) {
  duplicateBlocked = String(error).includes("ingestion_runs_one_open_per_job_idx");
}
if (!duplicateBlocked) throw new Error("Duplicate open ingestion run was not prevented");
// The scheduler must not create a parallel run while one is open or retryable.
await db.exec(`update public.ingestion_jobs set next_run_at=now() where id='00000000-0000-0000-0000-000000000007'`);
await db.query(`select * from public.schedule_due_ingestion_jobs(10)`);
const openRunCount = await db.query(`select count(*)::int as count from public.ingestion_runs where ingestion_job_id='00000000-0000-0000-0000-000000000007' and status in ('scheduled','running','paused')`);
if (Number(openRunCount.rows[0].count) !== 1) throw new Error(`Scheduler created a duplicate open run: ${JSON.stringify(openRunCount.rows)}`);
await db.query(`select public.control_ingestion_run($1,'pause')`, [controlRunId]);
const pausedRun = await db.query(`select status from public.ingestion_runs where id=$1`, [controlRunId]);
if (pausedRun.rows[0].status !== "paused") throw new Error(`Ingestion pause failed: ${JSON.stringify(pausedRun.rows)}`);
// Terminal failure = dead letter: not claimable until an admin resumes it.
await db.exec(`update public.ingestion_runs set status='failed',completed_at=now(),next_attempt_at=now()-interval '1 minute',attempts=1,locked_at=null where id='${controlRunId}'`);
const deadLetterClaims = await db.query(`select * from public.claim_ingestion_runs('verify-dead-letter-worker',5)`);
if (deadLetterClaims.rows.length !== 0) throw new Error(`Dead-letter run was claimable: ${JSON.stringify(deadLetterClaims.rows)}`);
await db.query(`select public.control_ingestion_run($1,'resume')`, [controlRunId]);
const resumedRun = await db.query(`select status,attempts,completed_at,current_page from public.ingestion_runs where id=$1`, [controlRunId]);
if (resumedRun.rows[0].status !== "scheduled" || Number(resumedRun.rows[0].attempts) !== 0 || resumedRun.rows[0].completed_at !== null || resumedRun.rows[0].current_page !== "3") {
  throw new Error(`Dead-letter resume with checkpoint failed: ${JSON.stringify(resumedRun.rows)}`);
}
const resumedClaims = await db.query(`select id,current_page from public.claim_ingestion_runs('verify-resume-worker',5)`);
if (resumedClaims.rows.length !== 1 || String(resumedClaims.rows[0].id) !== controlRunId || resumedClaims.rows[0].current_page !== "3") {
  throw new Error(`Resumed run claim failed: ${JSON.stringify(resumedClaims.rows)}`);
}
await db.query(`select public.control_ingestion_run($1,'cancel')`, [controlRunId]);
const cancelledRun = await db.query(`select status from public.ingestion_runs where id=$1`, [controlRunId]);
if (cancelledRun.rows[0].status !== "cancelled") throw new Error(`Ingestion cancel failed: ${JSON.stringify(cancelledRun.rows)}`);
const controlAudit = await db.query(`select count(*)::int as count from public.audit_logs where tenant_id='00000000-0000-0000-0000-000000000001' and entity_type='ingestion_run' and action in ('ingestion_run.pause','ingestion_run.resume','ingestion_run.cancel')`);
if (Number(controlAudit.rows[0].count) !== 3) throw new Error(`Ingestion run controls were not audited: ${JSON.stringify(controlAudit.rows)}`);
console.log("Executed dashboard/list aggregation, ingestion quota, run-control, dead-letter resume and duplicate-run protection runtime paths.");

// Production consistency hardening: truncated imports are non-committable,
// provider projections are monotonic and post-sign automation is exactly once.
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.exec(`
  insert into public.import_runs(
    id,tenant_id,name,source_type,status,uploaded_by,total_rows,simulation,scan_status,
    source_row_count,parsed_row_count,accepted_row_count,rejected_row_count,truncated,truncation_reason
  ) values(
    '00000000-0000-0000-0000-000000000080','00000000-0000-0000-0000-000000000001',
    'Truncated verify import','csv','preview_ready','00000000-0000-0000-0000-000000000002',10001,true,'clean',
    10001,10000,10000,0,true,'max_rows_exceeded'
  );
`);
let truncatedCommitBlocked = false;
try {
  await db.exec(`update public.import_runs set status='processing',execution_idempotency_key='verify-truncated-commit' where id='00000000-0000-0000-0000-000000000080'`);
} catch (error) {
  truncatedCommitBlocked = String(error).includes('truncated_import_cannot_be_committed');
}
if (!truncatedCommitBlocked) throw new Error('Truncated import was allowed to enter processing');

await db.exec(`
  -- Timestamps are relative to now() because this call was already finalized with a
  -- now()-stamped provider_state_updated_at earlier in this run. Absolute literals here
  -- silently rot into the past and turn this into a stale-event test instead of the
  -- out-of-order test it is meant to be.
  update public.calls set status='completed',provider_status='ended',provider_outcome='answered',recording_status='available_at_provider',provider_state_updated_at=now()+interval '1 minute'
  where id='${centralResult.callId}';
  -- Late callStart: newer arrival, lower lifecycle rank. Must not regress the terminal projection.
  update public.calls set status='answered',provider_status='connected',provider_outcome=null,recording_status='unavailable',provider_state_updated_at=now()+interval '2 minutes'
  where id='${centralResult.callId}';
`);
const monotonicCall = await db.query(`select status,provider_status,provider_outcome,recording_status from public.calls where id=$1`, [centralResult.callId]);
if (monotonicCall.rows[0].status !== 'completed' || monotonicCall.rows[0].provider_status !== 'ended' || monotonicCall.rows[0].provider_outcome !== 'answered' || monotonicCall.rows[0].recording_status !== 'available_at_provider') {
  throw new Error(`Late Rinkel start regressed terminal projection: ${JSON.stringify(monotonicCall.rows[0])}`);
}

const platformIntegration = await db.query(`select id from public.platform_integrations where provider='rinkel' and disabled_at is null limit 1`);
const platformIntegrationId = String(platformIntegration.rows[0].id);
await db.query(`
  insert into public.platform_rinkel_webhook_events(
    id,platform_integration_id,event_type,external_call_id,provider_event_id,payload_hash,content_type,payload,event_at
  ) values(
    '00000000-0000-0000-0000-000000000081',$1,'callStart','late-correlated-call','verify-rinkel-late-start',
    'verify-hash','application/json','{"userId":"platform-user-a"}','2026-08-01T11:00:00Z'
  )
`, [platformIntegrationId]);
const pendingCorrelation = await db.query(`select public.apply_rinkel_call_event('00000000-0000-0000-0000-000000000081') as result`);
if (pendingCorrelation.rows[0].result.status !== 'pending_correlation') {
  throw new Error(`Uncorrelated Rinkel event was not buffered: ${JSON.stringify(pendingCorrelation.rows[0])}`);
}
await db.exec(`
  insert into public.calls(
    id,tenant_id,customer_id,provider,external_call_id,direction,from_number,to_number,status,initiated_at,callback_token_hash
  ) values(
    '00000000-0000-0000-0000-000000000082','00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000021','rinkel','late-correlated-call','outbound','+46811111111','+46702222221',
    'ringing','2026-08-01T10:59:00Z','verify-late-correlation-token'
  );
`);
const correlatedReplay = await db.query(`select public.apply_rinkel_call_event('00000000-0000-0000-0000-000000000081') as result`);
if (correlatedReplay.rows[0].result.status !== 'processed') throw new Error(`Buffered Rinkel event did not replay: ${JSON.stringify(correlatedReplay.rows[0])}`);
const correlatedCall = await db.query(`select status,provider_status from public.calls where id='00000000-0000-0000-0000-000000000082'`);
if (correlatedCall.rows[0].status !== 'answered' || correlatedCall.rows[0].provider_status !== 'connected') {
  throw new Error(`Replayed Rinkel event did not update the call: ${JSON.stringify(correlatedCall.rows[0])}`);
}

// Provider causes are an open-ended external vocabulary. Unknown but well-formed
// values must be retained raw, projected safely, and must not block recording or
// CDR repair.
await db.query(`
  insert into public.platform_rinkel_webhook_events(
    id,platform_integration_id,event_type,external_call_id,provider_event_id,payload_hash,content_type,payload,event_at
  ) values(
    '00000000-0000-0000-0000-000000000095',$1,'callEnd','late-correlated-call','verify-rinkel-unknown-end',
    'verify-unknown-end-hash','application/json',
    '{"cause":"PROVIDER_ADDED_CAUSE","callRecordingUrl":"https://api.rinkel.com/v1/call-recordings/rec_unknown/stream"}',
    '2026-08-01T11:05:00Z'
  )
`, [platformIntegrationId]);
const unknownCauseResult = await db.query(`select public.apply_rinkel_call_event('00000000-0000-0000-0000-000000000095') as result`);
if (unknownCauseResult.rows[0].result.status !== 'processed') {
  throw new Error(`Unknown Rinkel cause was not processed: ${JSON.stringify(unknownCauseResult.rows[0])}`);
}
const unknownCauseCall = await db.query(`
  select status,provider_status,provider_outcome,provider_cause,recording_status
  from public.calls where id='00000000-0000-0000-0000-000000000082'
`);
if (
  unknownCauseCall.rows[0].status !== 'completed'
  || unknownCauseCall.rows[0].provider_status !== 'ended'
  || unknownCauseCall.rows[0].provider_outcome !== 'unknown'
  || unknownCauseCall.rows[0].provider_cause !== 'PROVIDER_ADDED_CAUSE'
  || unknownCauseCall.rows[0].recording_status !== 'available_at_provider'
) throw new Error(`Unknown Rinkel cause projection failed: ${JSON.stringify(unknownCauseCall.rows[0])}`);
const unknownRecording = await db.query(`
  select provider_recording_id,status from public.call_recordings
  where tenant_id='00000000-0000-0000-0000-000000000001'
    and call_id='00000000-0000-0000-0000-000000000082' and provider='rinkel' and deleted_at is null
`);
if (unknownRecording.rows.length !== 1 || unknownRecording.rows[0].provider_recording_id !== 'rec_unknown' || unknownRecording.rows[0].status !== 'available_at_provider') {
  throw new Error(`Rinkel callEnd recording projection failed: ${JSON.stringify(unknownRecording.rows)}`);
}
const callEndRepairJob = await db.query(`
  select count(*)::int as count from public.platform_rinkel_jobs
  where idempotency_key='rinkel.reconcile_call:call_end:00000000-0000-0000-0000-000000000082'
`);
if (Number(callEndRepairJob.rows[0].count) !== 1) throw new Error('Rinkel callEnd did not enqueue exactly one CDR repair job');

// CDR is the final repair source. Reconciliation must atomically repair the
// provider projection and the recording reference without trusting client state.
await db.exec(`
  insert into public.calls(
    id,tenant_id,customer_id,provider,direction,from_number,to_number,status,provider_status,
    provider_state_updated_at,callback_token_hash
  ) values(
    '00000000-0000-0000-0000-000000000096','00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000021','rinkel','outbound','+46811111111','+46702222221',
    'provider_outcome_unknown','unknown','2026-08-01T11:10:00Z','verify-cdr-repair-token'
  );
`);
const cdrRepair = await db.query(`select public.reconcile_rinkel_call_from_cdr(
  '00000000-0000-0000-0000-000000000096','cdr-repair-call',
  '2026-08-01T11:10:00Z','2026-08-01T11:10:05Z','2026-08-01T11:12:05Z',120,
  'ANSWERED','rec_cdr','{"source":"runtime-verifier"}'::jsonb
) as result`);
if (cdrRepair.rows[0].result.status !== 'reconciled') throw new Error(`CDR reconciliation failed: ${JSON.stringify(cdrRepair.rows[0])}`);
const cdrCall = await db.query(`
  select external_call_id,status,provider_status,provider_outcome,provider_cause,duration_seconds,recording_status
  from public.calls where id='00000000-0000-0000-0000-000000000096'
`);
if (
  cdrCall.rows[0].external_call_id !== 'cdr-repair-call'
  || cdrCall.rows[0].status !== 'completed'
  || cdrCall.rows[0].provider_status !== 'ended'
  || cdrCall.rows[0].provider_outcome !== 'answered'
  || cdrCall.rows[0].provider_cause !== 'ANSWERED'
  || Number(cdrCall.rows[0].duration_seconds) !== 120
  || cdrCall.rows[0].recording_status !== 'available_at_provider'
) throw new Error(`CDR projection was incomplete: ${JSON.stringify(cdrCall.rows[0])}`);
const cdrRecording = await db.query(`
  select provider_recording_id,status from public.call_recordings
  where tenant_id='00000000-0000-0000-0000-000000000001'
    and call_id='00000000-0000-0000-0000-000000000096' and provider='rinkel' and deleted_at is null
`);
if (cdrRecording.rows.length !== 1 || cdrRecording.rows[0].provider_recording_id !== 'rec_cdr') {
  throw new Error(`CDR recording repair failed: ${JSON.stringify(cdrRecording.rows)}`);
}

// The destination number determines the tenant for inbound calls. Matching may
// inspect only that tenant and must remain unlinked when the tenant-local result
// is ambiguous.
await db.exec(`
  insert into public.customers(id,tenant_id,customer_type,lifecycle,display_name,phone_e164,marketing_allowed,legal_basis,created_by)
  values
    ('00000000-0000-0000-0000-000000000097','00000000-0000-0000-0000-000000000001','company','prospect','Cross-tenant same number','+46709999991',true,'legitimate_interest','00000000-0000-0000-0000-000000000002'),
    ('00000000-0000-0000-0000-000000000098','00000000-0000-0000-0000-000000000051','company','prospect','Tenant B inbound match','+46709999991',true,'legitimate_interest','00000000-0000-0000-0000-000000000050');
`);
await db.query(`
  insert into public.platform_rinkel_webhook_events(
    id,platform_integration_id,event_type,external_call_id,provider_event_id,payload_hash,content_type,payload,event_at
  ) values(
    '00000000-0000-0000-0000-000000000099',$1,'incomingCall','inbound-tenant-b-unique','verify-rinkel-inbound-unique',
    'verify-inbound-unique-hash','application/json','{"from":"+46709999991","to":"+46822222222"}',
    '2026-08-01T11:20:00Z'
  )
`, [platformIntegrationId]);
const inboundUnique = await db.query(`select public.correlate_rinkel_incoming_event(
  '00000000-0000-0000-0000-000000000099','00000000-0000-0000-0000-000000000051',
  '00000000-0000-0000-0000-000000000059','00000000-0000-0000-0000-000000000055',
  '+46709999991','+46822222222'
) as result`);
if (inboundUnique.rows[0].result.customer_id !== '00000000-0000-0000-0000-000000000098') {
  throw new Error(`Inbound call crossed tenant boundary or missed unique tenant match: ${JSON.stringify(inboundUnique.rows[0])}`);
}
const inboundUniqueCall = await db.query(`select tenant_id,customer_id,provider_status from public.calls where id=$1`, [inboundUnique.rows[0].result.call_id]);
if (
  inboundUniqueCall.rows[0].tenant_id !== '00000000-0000-0000-0000-000000000051'
  || inboundUniqueCall.rows[0].customer_id !== '00000000-0000-0000-0000-000000000098'
  || inboundUniqueCall.rows[0].provider_status !== 'initiated'
) throw new Error(`Inbound tenant projection failed: ${JSON.stringify(inboundUniqueCall.rows[0])}`);

await db.exec(`
  insert into public.customers(id,tenant_id,customer_type,lifecycle,display_name,phone_e164,marketing_allowed,legal_basis,created_by)
  values('00000000-0000-0000-0000-000000000100','00000000-0000-0000-0000-000000000051','company','prospect','Tenant B ambiguous match','+46709999991',true,'legitimate_interest','00000000-0000-0000-0000-000000000050');
`);
await db.query(`
  insert into public.platform_rinkel_webhook_events(
    id,platform_integration_id,event_type,external_call_id,provider_event_id,payload_hash,content_type,payload,event_at
  ) values(
    '00000000-0000-0000-0000-000000000101',$1,'incomingCall','inbound-tenant-b-ambiguous','verify-rinkel-inbound-ambiguous',
    'verify-inbound-ambiguous-hash','application/json','{"from":"+46709999991","to":"+46822222222"}',
    '2026-08-01T11:21:00Z'
  )
`, [platformIntegrationId]);
const inboundAmbiguous = await db.query(`select public.correlate_rinkel_incoming_event(
  '00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000051',
  '00000000-0000-0000-0000-000000000059','00000000-0000-0000-0000-000000000055',
  '+46709999991','+46822222222'
) as result`);
if (inboundAmbiguous.rows[0].result.customer_id !== null) {
  throw new Error(`Ambiguous inbound call was guessed instead of left unmatched: ${JSON.stringify(inboundAmbiguous.rows[0])}`);
}
console.log('Executed Rinkel monotonic lifecycle, unknown cause, recording, CDR repair and tenant-safe inbound correlation runtime paths.');

await db.exec(`
  insert into public.email_messages(
    id,tenant_id,customer_id,provider_message_id,from_address,to_addresses,subject,status
  ) values(
    '00000000-0000-0000-0000-000000000083','00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000021','verify-resend-message','verify@kundexa.test','{customer@example.test}',
    'Verify delivery reducer','sent'
  );
`);
const deliveredProjection = await db.query(`select public.apply_resend_delivery_event(
  '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000083',
  'verify-resend-delivered','email.delivered','delivered','2026-08-01T12:00:00Z','{}',null
) as result`);
if (!deliveredProjection.rows[0].result.applied) throw new Error(`Initial Resend projection was not applied: ${JSON.stringify(deliveredProjection.rows[0])}`);
const olderOpened = await db.query(`select public.apply_resend_delivery_event(
  '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000083',
  'verify-resend-older-open','email.opened','opened','2026-08-01T11:59:00Z','{}',null
) as result`);
if (olderOpened.rows[0].result.applied || olderOpened.rows[0].result.reason !== 'older_provider_event') {
  throw new Error(`Older Resend event changed the projection: ${JSON.stringify(olderOpened.rows[0])}`);
}
const openedProjection = await db.query(`select public.apply_resend_delivery_event(
  '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000083',
  'verify-resend-opened','email.opened','opened','2026-08-01T12:01:00Z','{}',null
) as result`);
if (!openedProjection.rows[0].result.applied) throw new Error(`Newer Resend open was not applied: ${JSON.stringify(openedProjection.rows[0])}`);
const regressiveDelivered = await db.query(`select public.apply_resend_delivery_event(
  '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000083',
  'verify-resend-regressive-delivered','email.delivered','delivered','2026-08-01T12:02:00Z','{}',null
) as result`);
if (regressiveDelivered.rows[0].result.applied || regressiveDelivered.rows[0].result.reason !== 'regressive_provider_event') {
  throw new Error(`Newer but lower Resend event regressed the projection: ${JSON.stringify(regressiveDelivered.rows[0])}`);
}
const finalEmailProjection = await db.query(`select status from public.email_messages where id='00000000-0000-0000-0000-000000000083'`);
if (finalEmailProjection.rows[0].status !== 'opened') throw new Error(`Resend projection did not remain opened: ${JSON.stringify(finalEmailProjection.rows[0])}`);

await db.exec(`
  insert into public.customers(
    id,tenant_id,customer_type,lifecycle,display_name,phone_e164,marketing_allowed,legal_basis,created_by
  ) values(
    '10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',
    'company','prospect','Signing Runtime Prospect','+46702222999',true,'legitimate_interest',
    '00000000-0000-0000-0000-000000000002'
  );
  insert into public.contract_templates(id,tenant_id,name,contract_type,audience)
  values('00000000-0000-0000-0000-000000000084','00000000-0000-0000-0000-000000000001','Signing verify','sales','B2B');
  insert into public.contract_template_versions(
    id,tenant_id,template_id,version,title_template,body_template,signature_policy,created_by
  ) values(
    '00000000-0000-0000-0000-000000000085','00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000084',1,'Verify','Verify body',
    '{"method":"external_esign","identityAssuranceLevel":"high","orderedSigning":true,"requireFinalProviderDocument":true}',
    '00000000-0000-0000-0000-000000000002'
  );
  insert into public.contracts(
    id,tenant_id,contract_number,customer_id,template_id,owner_user_id,audience,status,title
  ) values(
    '00000000-0000-0000-0000-000000000086','00000000-0000-0000-0000-000000000001','VERIFY-SIGN-1',
    '10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000084',
    '00000000-0000-0000-0000-000000000002','B2B','ready','Signing verify contract'
  );
  insert into public.contract_versions(
    id,tenant_id,contract_id,version,template_version_id,title,rendered_body,document_hash,created_by
  ) values(
    '00000000-0000-0000-0000-000000000087','00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000086',1,'00000000-0000-0000-0000-000000000085',
    'Signing verify contract','Rendered body','source-sha-256','00000000-0000-0000-0000-000000000002'
  );
  update public.contracts set active_version_id='00000000-0000-0000-0000-000000000087'
    where id='00000000-0000-0000-0000-000000000086';
  insert into public.contract_documents(
    id,tenant_id,contract_id,contract_version_id,document_type,file_name,storage_path,mime_type,sha256,size_bytes
  ) values(
    '00000000-0000-0000-0000-000000000088','00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000086','00000000-0000-0000-0000-000000000087',
    'signed_pdf','signed.pdf','contracts/verify/signed.pdf','application/pdf','final-signed-sha-256',2048
  );
  insert into public.contract_recipients(
    id,tenant_id,contract_id,full_name,email,role,signing_order,required,status,identity_assurance_level,signed_at
  ) values(
    '00000000-0000-0000-0000-000000000089','00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000086','Required Signer','signer@example.test','signer',1,true,'signed','high',now()
  );
  insert into public.contract_recipients(
    id,tenant_id,contract_id,full_name,email,role,signing_order,required,status,identity_assurance_level
  ) values(
    '00000000-0000-0000-0000-000000000093','00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000086','Second Required Signer','second-signer@example.test','signer',2,true,'pending','high'
  );
  update public.contracts set status='accepted' where id='00000000-0000-0000-0000-000000000086';
  insert into public.signing_envelopes(
    id,tenant_id,contract_id,contract_version_id,provider,provider_envelope_id,signature_policy,status,created_by
  ) values(
    '00000000-0000-0000-0000-000000000090','00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000086','00000000-0000-0000-0000-000000000087',
    'verify-provider','verify-envelope-1',
    '{"method":"external_esign","identityAssuranceLevel":"high","orderedSigning":true,"requireFinalProviderDocument":true}',
    'partially_signed','00000000-0000-0000-0000-000000000002'
  );
  insert into public.signing_recipients(
    id,tenant_id,envelope_id,contract_recipient_id,required,role,signing_order,status,identity_assurance_level,signed_at
  ) values(
    '00000000-0000-0000-0000-000000000091','00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000090','00000000-0000-0000-0000-000000000089',
    true,'signer',1,'signed','high',now()
  );
  insert into public.signing_events(
    id,tenant_id,envelope_id,signing_recipient_id,provider,provider_event_id,event_type,event_at,verified,processing_status,payload
  ) values(
    '00000000-0000-0000-0000-000000000092','00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000090','00000000-0000-0000-0000-000000000091',
    'verify-provider','verify-signing-event-1','recipient.signed',now(),true,'processed','{}'
  );
`);
const partialSigningState = await db.query(`select status from public.contracts where id='00000000-0000-0000-0000-000000000086'`);
if (partialSigningState.rows[0].status !== 'signing') {
  throw new Error(`A single recipient acceptance completed a multi-recipient contract: ${JSON.stringify(partialSigningState.rows[0])}`);
}
await db.exec(`
  update public.contract_recipients set status='signed',signed_at=now()
  where id='00000000-0000-0000-0000-000000000093';
  insert into public.signing_recipients(
    id,tenant_id,envelope_id,contract_recipient_id,required,role,signing_order,status,identity_assurance_level,signed_at
  ) values(
    '00000000-0000-0000-0000-000000000094','00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000090','00000000-0000-0000-0000-000000000093',
    true,'signer',2,'signed','high',now()
  );
`);
const firstFinalize = await db.query(`select public.finalize_signing_envelope(
  '00000000-0000-0000-0000-000000000090','00000000-0000-0000-0000-000000000088','{"verified":true}'
) as result`);
if (firstFinalize.rows[0].result.status !== 'signed' || firstFinalize.rows[0].result.idempotent_replay === true) {
  throw new Error(`Signing finalization did not complete the canonical signed state: ${JSON.stringify(firstFinalize.rows[0])}`);
}
const replayFinalize = await db.query(`select public.finalize_signing_envelope(
  '00000000-0000-0000-0000-000000000090','00000000-0000-0000-0000-000000000088','{"verified":true}'
) as result`);
if (replayFinalize.rows[0].result.status !== 'signed' || replayFinalize.rows[0].result.idempotent_replay !== true) {
  throw new Error(`Signing finalization replay was not idempotent: ${JSON.stringify(replayFinalize.rows[0])}`);
}
const preActivation = await db.query(`
  select
    (select status from public.contracts where id='00000000-0000-0000-0000-000000000086') contract_status,
    (select lifecycle from public.customers where id='10000000-0000-0000-0000-000000000001') customer_lifecycle
`);
if (preActivation.rows[0].contract_status !== 'signed' || preActivation.rows[0].customer_lifecycle !== 'prospect') {
  throw new Error(`Signing finalization bypassed explicit contract activation: ${JSON.stringify(preActivation.rows[0])}`);
}
await db.exec(`
  select set_config('request.jwt.claim.role','authenticated',false);
  select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
`);
const firstActivation = await db.query(`select public.activate_completed_contract('00000000-0000-0000-0000-000000000086') as result`);
if (firstActivation.rows[0].result.status !== 'active' || firstActivation.rows[0].result.already_active === true) {
  throw new Error(`Completed contract activation failed: ${JSON.stringify(firstActivation.rows[0])}`);
}
const replayActivation = await db.query(`select public.activate_completed_contract('00000000-0000-0000-0000-000000000086') as result`);
if (replayActivation.rows[0].result.status !== 'active' || replayActivation.rows[0].result.already_active !== true) {
  throw new Error(`Contract activation replay was not idempotent: ${JSON.stringify(replayActivation.rows[0])}`);
}
const postSignState = await db.query(`
  select
    (select status from public.contracts where id='00000000-0000-0000-0000-000000000086') contract_status,
    (select lifecycle from public.customers where id='10000000-0000-0000-0000-000000000001') customer_lifecycle,
    (select count(*)::int from public.activities where metadata->>'post_sign_contract_id'='00000000-0000-0000-0000-000000000086') onboarding_activities,
    (select count(*)::int from public.signing_documents where envelope_id='00000000-0000-0000-0000-000000000090' and document_role='final_signed') final_documents,
    (select count(*)::int from public.evidence_packages where contract_id='00000000-0000-0000-0000-000000000086' and status='completed' and manifest->>'generation'='0') evidence_packages,
    (select count(*)::int from public.outbox_jobs where idempotency_key='contract.signed.confirmation:00000000-0000-0000-0000-000000000086:0') confirmation_jobs,
    (select count(*)::int from public.contract_events where contract_id='00000000-0000-0000-0000-000000000086' and event_type='contract.activated') activation_events,
    (select count(*)::int from public.audit_logs where entity_type='contract' and entity_id='00000000-0000-0000-0000-000000000086' and action='contract.activated') activation_audits
`);
const postSign = postSignState.rows[0];
if (
  postSign.contract_status !== 'active'
  || postSign.customer_lifecycle !== 'customer'
  || Number(postSign.onboarding_activities) !== 1
  || Number(postSign.final_documents) !== 1
  || Number(postSign.evidence_packages) !== 1
  || Number(postSign.confirmation_jobs) !== 1
  || Number(postSign.activation_events) !== 1
  || Number(postSign.activation_audits) !== 1
) {
  throw new Error(`Finalize/activate exactly-once state invalid: ${JSON.stringify(postSign)}`);
}
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
console.log("Executed production hardening runtime paths: import truncation, Rinkel buffering/monotonicity, Resend reducer, generation-bound signing finalization and idempotent contract activation.");

// Generated-type drift. `types:verify` only asserts that a hand-maintained list of names is
// present, so a table or column added by a migration and never regenerated into
// database.types.ts passes it unnoticed and only surfaces as a runtime error. The migrated
// schema is already in hand here, so compare it directly against the checked-in types.
const schemaColumns = await db.query(`
  select c.relname as table_name, a.attname as column_name
  from pg_class c
  join pg_namespace n on n.oid=c.relnamespace
  join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
  where n.nspname='public' and c.relkind in ('r','v','m')
`);
const schemaTables = new Map();
for (const row of schemaColumns.rows) {
  if (!schemaTables.has(row.table_name)) schemaTables.set(row.table_name, new Set());
  schemaTables.get(row.table_name).add(row.column_name);
}

// PostGIS ships these in a real Supabase project but PGlite has no PostGIS, so they are
// legitimately present in the generated types and absent here.
const postgisProvided = new Set(["spatial_ref_sys", "geography_columns", "geometry_columns"]);

const generatedTypes = await readFile(join(root, "src/lib/supabase/database.types.ts"), "utf8");
const typedTables = new Map();
const tableBlock = /^      (\w+): \{\n        Row: \{\n([\s\S]*?)\n        \}/gm;
for (let match = tableBlock.exec(generatedTypes); match; match = tableBlock.exec(generatedTypes)) {
  const columns = new Set();
  for (const line of match[2].split("\n")) {
    const column = line.match(/^\s{10}(\w+)\??:/);
    if (column) columns.add(column[1]);
  }
  typedTables.set(match[1], columns);
}
if (typedTables.size < 100) {
  throw new Error(`Could not parse database.types.ts (only ${typedTables.size} tables parsed)`);
}

const untypedTables = [...schemaTables.keys()].filter((table) => !typedTables.has(table)).sort();
if (untypedTables.length > 0) {
  throw new Error(`Migrations define tables missing from database.types.ts (run npm run types:generate): ${untypedTables.join(", ")}`);
}
const phantomTables = [...typedTables.keys()].filter((table) => !schemaTables.has(table) && !postgisProvided.has(table)).sort();
if (phantomTables.length > 0) {
  throw new Error(`database.types.ts declares tables no migration creates: ${phantomTables.join(", ")}`);
}
const columnDrift = [];
for (const [table, columns] of schemaTables) {
  const typed = typedTables.get(table);
  const untyped = [...columns].filter((column) => !typed.has(column));
  const phantom = [...typed].filter((column) => !columns.has(column));
  if (untyped.length > 0 || phantom.length > 0) {
    columnDrift.push(`${table} (missing from types: ${untyped.join(", ") || "none"}; not in schema: ${phantom.join(", ") || "none"})`);
  }
}
if (columnDrift.length > 0) {
  throw new Error(`Generated types drifted from the migrated schema (run npm run types:generate): ${columnDrift.join(" | ")}`);
}
console.log(`Verified generated types match the migrated schema: ${schemaTables.size} tables, zero column drift.`);

// SECURITY DEFINER execute-grant boundary.
//
// PostgreSQL grants EXECUTE to PUBLIC by default, so any SECURITY DEFINER routine
// created without an explicit REVOKE becomes callable by the unauthenticated `anon`
// role through PostgREST. This is a standing invariant rather than a name list, so a
// newly added function that forgets its REVOKE fails the gate immediately.
//
// RLS predicate helpers (can_*, is_*, has_*, current_*) are exempt: they are evaluated
// inside policies that apply to PUBLIC, so revoking EXECUTE would convert row filtering
// into a hard permission error. They are read-only and yield null/false without a session.
// Trigger-returning functions are exempt: PostgreSQL rejects a direct call and trigger
// firing never consults EXECUTE privileges.
const anonExecutable = await db.query(`
  select p.proname, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
  where n.nspname = 'public'
    and p.prosecdef
    and d.objid is null
    and p.prorettype <> 'trigger'::regtype
    and has_function_privilege('anon', p.oid, 'EXECUTE')
    and p.proname !~ '^(can|is|has|current)_'
  order by p.proname
`);
if (anonExecutable.rows.length > 0) {
  const names = anonExecutable.rows.map((row) => `${row.proname}(${row.args})`).join(", ");
  throw new Error(`SECURITY DEFINER functions are executable by anon (add an explicit revoke): ${names}`);
}

// Service-only routines take explicit tenant/entity parameters instead of deriving
// tenant from the session, so they must never be reachable from a browser session.
const serviceOnlyPrivileges = await db.query(`
  select
    has_function_privilege('authenticated','public.merge_master_entities(uuid,uuid,uuid,uuid)','EXECUTE') as authenticated_merge,
    has_function_privilege('anon','public.merge_master_entities(uuid,uuid,uuid,uuid)','EXECUTE') as anon_merge,
    has_function_privilege('authenticated','public.undo_master_entity_merge(uuid,uuid)','EXECUTE') as authenticated_undo_merge,
    has_function_privilege('service_role','public.undo_master_entity_merge(uuid,uuid)','EXECUTE') as service_undo_merge,
    has_function_privilege('authenticated','public.rebuild_master_entity(uuid)','EXECUTE') as authenticated_rebuild,
    has_function_privilege('service_role','public.rebuild_master_entity(uuid)','EXECUTE') as service_rebuild,
    has_function_privilege('authenticated','public.recalculate_data_quality(uuid)','EXECUTE') as authenticated_quality,
    has_function_privilege('authenticated','public.source_priority_for(uuid,text,text)','EXECUTE') as authenticated_source_priority,
    has_function_privilege('authenticated','public.customer_has_legal_retention(uuid,uuid)','EXECUTE') as authenticated_legal_retention
`);
const serviceOnlyPrivilege = serviceOnlyPrivileges.rows[0];
if (
  !serviceOnlyPrivilege.authenticated_merge
  || serviceOnlyPrivilege.anon_merge
  || serviceOnlyPrivilege.authenticated_undo_merge
  || !serviceOnlyPrivilege.service_undo_merge
  || serviceOnlyPrivilege.authenticated_rebuild
  || !serviceOnlyPrivilege.service_rebuild
  || serviceOnlyPrivilege.authenticated_quality
  || serviceOnlyPrivilege.authenticated_source_priority
  || serviceOnlyPrivilege.authenticated_legal_retention
) {
  throw new Error(`Service-only RPC privilege boundary failed: ${JSON.stringify(serviceOnlyPrivilege)}`);
}

// Every SECURITY DEFINER routine must pin search_path.
const mutableSearchPath = await db.query(`
  select p.proname
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
  where n.nspname = 'public' and d.objid is null and p.prokind = 'f' and p.proconfig is null
    -- public.digest is the harness shim for pgcrypto; on Supabase the real function is
    -- extension-owned in the extensions schema and already excluded by pg_depend.
    and p.proname <> 'digest'
  order by p.proname
`);
if (mutableSearchPath.rows.length > 0) {
  throw new Error(`Functions with a mutable search_path: ${mutableSearchPath.rows.map((row) => row.proname).join(", ")}`);
}

// The merge guard must reject an unauthenticated caller rather than falling through
// the historic `auth.uid() is null` service-context bypass.
const mergeGuard = await db.query(`
  select public.merge_master_entities is not null as present,
         pg_get_functiondef(p.oid) ~ 'auth\\.uid\\(\\) is not null' as has_legacy_bypass
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('merge_master_entities','undo_master_entity_merge')
`).catch(async () => db.query(`
  select pg_get_functiondef(p.oid) ~ 'auth\\.uid\\(\\) is not null' as has_legacy_bypass
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('merge_master_entities','undo_master_entity_merge')
`));
if (mergeGuard.rows.some((row) => row.has_legacy_bypass)) {
  throw new Error("merge_master_entities/undo_master_entity_merge still carry the auth.uid() service-context bypass");
}
console.log(
  `Verified SECURITY DEFINER execute boundary: no anon-executable RPCs, service-only routines restricted, ${mutableSearchPath.rows.length} functions with mutable search_path.`,
);

await db.close();
