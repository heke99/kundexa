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
await db.exec(`
  update public.profiles set active_tenant_id='00000000-0000-0000-0000-000000000001' where id='00000000-0000-0000-0000-000000000002';
  select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
  insert into public.import_runs(id,tenant_id,name,source_type,status,uploaded_by,total_rows,simulation,scan_status,scan_provider,scan_sha256,scan_completed_at)
  values('00000000-0000-0000-0000-000000000009','00000000-0000-0000-0000-000000000001','Runtime JSON','json','preview_ready','00000000-0000-0000-0000-000000000002',1,true,'clean','verify','sha',now());
  insert into public.import_rows(tenant_id,import_run_id,row_number,raw_data,normalized_data,decision,errors)
  values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000009',2,'{"name":"Imported Runtime AB"}','{"display_name":"Imported Runtime AB","customer_type":"company","organization_number":"5599999999","city":"Lund","phone_e164":"+46709999999"}','ready','[]');
`);
const imported = await db.query(`select public.process_import_run('00000000-0000-0000-0000-000000000009') as result`);
if (Number(imported.rows[0].result.new) !== 1 || Number(imported.rows[0].result.catalogSynced) !== 1) throw new Error(`Secure import execution failed: ${JSON.stringify(imported.rows[0])}`);
const importedLink = await db.query(`select me.canonical_name,te.customer_id from public.master_entities me join public.tenant_entities te on te.master_entity_id=me.id and te.tenant_id='00000000-0000-0000-0000-000000000001' where me.organization_number='5599999999'`);
if (importedLink.rows.length !== 1 || !importedLink.rows[0].customer_id) throw new Error(`Tenant import catalogue synchronization failed: ${JSON.stringify(importedLink.rows)}`);
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
await db.close();
