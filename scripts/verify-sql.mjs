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
  -- pgcrypto is present in hosted Supabase; PGlite has neither the extension nor these two
  -- functions, so the callable surface the migrations use is stubbed for the runtime replay.
  create function public.gen_random_bytes(count integer) returns bytea language sql volatile as $$
    select decode(md5(random()::text || clock_timestamp()::text), 'hex')
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

// Postgres grants EXECUTE to PUBLIC by default and `anon` inherits PUBLIC, so a
// SECURITY DEFINER function that no migration explicitly revoked is reachable
// unauthenticated through PostgREST with the definer's privileges. This gate
// fails the build rather than letting such a function reach a database again.
const anonDefinerFunctions = await db.query(`
  select p.oid::regprocedure::text as signature
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    and has_function_privilege('anon', p.oid, 'execute')
  order by 1
`);
if (anonDefinerFunctions.rows.length > 0) {
  throw new Error(
    `SECURITY DEFINER functions executable by anon: ${anonDefinerFunctions.rows.map((row) => row.signature).join(", ")}`,
  );
}

// A bare auth.uid() inside an RLS qual is re-evaluated per candidate row because
// the function is STABLE, not IMMUTABLE. `(select auth.uid())` becomes a
// once-per-statement InitPlan instead.
const bareAuthUidPolicies = await db.query(`
  select tablename || '.' || policyname as policy
  from pg_policies
  where schemaname = 'public'
    and (coalesce(qual, '') ~ 'auth\\.uid\\(\\)' or coalesce(with_check, '') ~ 'auth\\.uid\\(\\)')
    and (coalesce(qual, '') || coalesce(with_check, '')) !~* 'select\\s+auth\\.uid\\(\\)'
  order by 1
`);
if (bareAuthUidPolicies.rows.length > 0) {
  throw new Error(
    `RLS policies calling auth.uid() per row: ${bareAuthUidPolicies.rows.map((row) => row.policy).join(", ")}`,
  );
}

// Supabase installs pgcrypto in `extensions`, so a SECURITY DEFINER function that
// calls it needs that schema on its fixed search_path. This harness defines its own
// `public.digest`, so a missing search_path entry runs fine here and fails only on
// the hosted project — which is how a `create or replace` silently reverted the
// hardening on the call-reservation path and broke every outbound call. Assert the
// invariant against proconfig so replay catches it instead of production.
const pgcryptoSearchPath = await db.query(`
  select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and pg_get_functiondef(p.oid) ~ '(digest|hmac|gen_salt|crypt|pgp_sym_)\\('
    and not exists (
      select 1 from unnest(coalesce(p.proconfig, array[]::text[])) c
      where c like 'search_path=%' and c like '%extensions%'
    )
  order by 1
`);
if (pgcryptoSearchPath.rows.length > 0) {
  throw new Error(
    `SECURITY DEFINER functions using pgcrypto without 'extensions' on their search_path: ${
      pgcryptoSearchPath.rows.map((row) => row.fn).join(", ")
    }`,
  );
}

console.log(`Executed ${migrations.length} migrations: ${counts.tables} public tables, ${counts.functions} public functions, ${counts.policies} RLS policies.`);
console.log(`Privilege boundary verified: zero anon-executable SECURITY DEFINER functions, zero per-row auth.uid() policies, zero pgcrypto callers without the extensions search path.`);

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
// Listans utgående nummer sätts inte här längre: det väljs med samma formulär
// som teamets och kampanjens, och skrivs direkt till caller_id_phone_number_id.
await db.query(`select public.update_customer_list_configuration($1,'Runtime Dialer','Full runtime path','active','automatic',100,'00:00','23:59:59',7,60,0,'both',true,false,true,'Runtime script','Europe/Stockholm','{1,2,3,4,5,6,7}',true,null,null)`, [runtimeListId]);
await db.query(`update public.customer_lists set caller_id_phone_number_id='00000000-0000-0000-0000-000000000022' where id=$1`, [runtimeListId]);
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

// Två företag, två nummer. Fixturen finns för de prov som följer: att en säljare
// bara har en plats i taget, att ett annat företag inte kan se eller avsluta
// samtalet, och att ett företags nummer aldrig kan lånas av ett annat.
//
// Leverantörens egen inventarielista -- provisionerade användare, registrerade
// enheter, allokerade nummer -- finns inte längre att bygga fixturen av. Det som
// återstår är företagets egna nummer, vilket är hela modellen numera.
await db.exec(`
  select set_config('request.jwt.claim.role','service_role',false);
  update public.telephony_policies set telephony_enabled=true,manual_dialer_enabled=true,
    automatic_dialer_enabled=true,allowed_days='{1,2,3,4,5,6,7}',
    allowed_start_time='00:00',allowed_end_time='23:59:59',
    -- A tenant with no number to present cannot call at all, so the fixture has
    -- to give it one before telephony can be reported ready.
    default_caller_id_phone_number_id='00000000-0000-0000-0000-000000000022'
    where tenant_id='00000000-0000-0000-0000-000000000001';
  insert into auth.users(id,email) values
    ('00000000-0000-0000-0000-000000000050','seller-b@example.test'),
    ('00000000-0000-0000-0000-000000000074','admin-b@example.test');
  insert into public.tenants(id,slug,name,legal_name)
    values('00000000-0000-0000-0000-000000000051','telephony-tenant-b','Telephony Tenant B','Telephony Tenant B AB');
  insert into public.teams(id,tenant_id,name,is_default)
    values('00000000-0000-0000-0000-000000000076','00000000-0000-0000-0000-000000000051','Telephony Tenant B Sales',true);
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
  insert into public.phone_numbers(id,tenant_id,number_e164,supports_voice,supports_sms,status,webhook_token_hash)
    values('00000000-0000-0000-0000-000000000059','00000000-0000-0000-0000-000000000051','+46822222222',true,false,'active','tenant-b-hash')
    on conflict(tenant_id,number_e164) do nothing;
  update public.telephony_policies set telephony_enabled=true,manual_dialer_enabled=true,
    allowed_days='{1,2,3,4,5,6,7}',allowed_start_time='00:00',allowed_end_time='23:59:59',
    default_caller_id_phone_number_id='00000000-0000-0000-0000-000000000059'
    where tenant_id='00000000-0000-0000-0000-000000000051';
`);
// Att ringa företagets eget A-nummer kopplar samtalet tillbaka till samma trunk.
// Det måste vägras redan vid reservationen, så att ingen samtalsrad, inget
// försök och ingen listposition skapas för ett mål som ändå inte kan ringas.
//
// Den gamla varianten prövade också säljarens egen provisionerade linje hos
// leverantören. Den linjen finns inte: webbläsaren är telefonen, och säljaren
// har inget nummer hos leverantören att ringa sig själv på.
await db.exec(`
  select set_config('request.jwt.claim.role','authenticated',false);
  select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
  update public.customers set alternate_phone_e164='+46401234567'
  where id='00000000-0000-0000-0000-000000000025';
`);
const callsBeforeSelfDial = await db.query(`select count(*)::int as count from public.calls`);
let selfDialRefused = false;
try {
  await db.query(`
    select public.reserve_outbound_call(
      '00000000-0000-0000-0000-000000000025',null,'+46401234567',null,null,null,
      gen_random_uuid(),'self-dial-caller-id','customer_service',null,null
    )
  `);
} catch (error) {
  selfDialRefused = String(error).includes("SELF_DIAL_NOT_ALLOWED");
}
if (!selfDialRefused) throw new Error("Reservation allowed a call to the tenant's own caller-ID number.");
const callsAfterSelfDial = await db.query(`select count(*)::int as count from public.calls`);
if (callsAfterSelfDial.rows[0].count !== callsBeforeSelfDial.rows[0].count) {
  throw new Error("A refused self-dial still created a call row.");
}
await db.exec(`
  update public.customers set alternate_phone_e164=null
  where id='00000000-0000-0000-0000-000000000025';
`);
console.log("Executed self-dial guard runtime path: the tenant's own caller-ID number is refused before any call row exists.");

const centralReservation = await db.query(`
  select public.reserve_outbound_call(
    '00000000-0000-0000-0000-000000000025',null,'+46702222225',null,null,null,
    '00000000-0000-0000-0000-000000000060','central-runtime-1','customer_service',null,null
  ) as result
`);
const centralResult = centralReservation.rows[0].result;
// A-numret kommer ur företagets egna nummer, inte ur en allokering hos
// leverantören, och det är numret kunden ser som räknas.
if (!centralResult.callId || !centralResult.attemptId
  || centralResult.callerId !== "+46401234567" || centralResult.callerIdSource !== "tenant_default") {
  throw new Error(`The reservation failed: ${JSON.stringify(centralResult)}`);
}
if (centralResult.purpose !== "direct_marketing") {
  throw new Error(`The purpose was not derived server-side: ${JSON.stringify(centralResult)}`);
}
const centralReplay = await db.query(`
  select public.reserve_outbound_call(
    '00000000-0000-0000-0000-000000000025',null,'+46703333333',null,null,null,
    '00000000-0000-0000-0000-000000000060','central-runtime-1','customer_service',null,null
  ) as result
`);
if (!centralReplay.rows[0].result.idempotentReplay || centralReplay.rows[0].result.callId !== centralResult.callId) {
  throw new Error(`Idempotent replay failed: ${JSON.stringify(centralReplay.rows[0])}`);
}
// Utfallet skrivs av den inloggade säljaren: det är webbläsaren som fick svaret
// från leverantörens klient, och tjänsterollen har ingen tenantkontext att
// skriva i.
await db.query(`select public.finalize_dial($1,$2,'accepted',null,null,null)`, [centralResult.callId, centralResult.attemptId]);
const centralFinal = await db.query(`select c.status call_status,a.status attempt_status
  from public.calls c join public.dial_attempts a on a.call_id=c.id where c.id=$1`, [centralResult.callId]);
if (centralFinal.rows[0].call_status !== "dial_requested" || centralFinal.rows[0].attempt_status !== "dial_requested") {
  throw new Error(`Finalization failed: ${JSON.stringify(centralFinal.rows[0])}`);
}
await db.exec(`
  update public.calls set status='completed',ended_at=now() where id='${centralResult.callId}';
  update public.dial_attempts set status='completed' where id='${centralResult.attemptId}';
`);

// Avsluta ett samtal. The reservation refuses a second dial while an attempt is
// in a non-terminal status, and until now the only thing that ever released
// such an attempt was a service-role janitor with a 15-minute floor. A seller
// whose attempt hung was therefore unable to call anyone, from anywhere in the
// product, for up to an hour.
// Its own reservation, not the shared fixture above: this block deliberately
// leaves a call in a non-terminal state and then ends it, and a `cancelled`
// status is terminal, so reusing the fixture would pin it and break the
// monotonic-projection test further down.
const endTest = await db.query(`
  select public.reserve_outbound_call(
    '00000000-0000-0000-0000-000000000025',null,'+46702222225',null,null,null,
    gen_random_uuid(),'central-end-call','customer_service',null,null
  ) as result
`);
const endTestResult = endTest.rows[0].result;
if (!endTestResult.callId) {
  throw new Error(`End-call fixture reservation failed: ${JSON.stringify(endTestResult)}`);
}
let refusedSecondDialWhileAttemptOpen = false;
try {
  await db.query(`
    select public.reserve_outbound_call(
      '00000000-0000-0000-0000-000000000025',null,'+46702222225',null,null,null,
      gen_random_uuid(),'central-blocked-by-open-attempt','customer_service',null,null
    )
  `);
} catch (error) {
  refusedSecondDialWhileAttemptOpen = String(error).includes('active_call_already_exists');
}
if (!refusedSecondDialWhileAttemptOpen) {
  throw new Error('An open dial attempt no longer blocks a second reservation; the end-call test proves nothing.');
}
// The call belongs to tenant A. A seller in tenant B must not be able to see it,
// let alone end it.
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000050',false)`);
let crossTenantEndRefused = false;
try {
  await db.query(`select public.end_active_call($1,null)`, [endTestResult.callId]);
} catch (error) {
  crossTenantEndRefused = String(error).includes('call_not_found');
}
if (!crossTenantEndRefused) {
  throw new Error("A seller in another tenant was able to end this tenant's call.");
}
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false)`);
const endedUnanswered = await db.query(`select public.end_active_call($1,'Kunden svarade inte') as result`, [endTestResult.callId]);
const endedUnansweredResult = endedUnanswered.rows[0].result;
if (
  endedUnansweredResult.attemptReleased !== true
  || endedUnansweredResult.callClosed !== true
  || endedUnansweredResult.callStatus !== 'cancelled'
) {
  throw new Error(`Ending an unanswered call did not close it: ${JSON.stringify(endedUnansweredResult)}`);
}
const endedUnansweredRow = await db.query(`select c.status call_status,c.ended_at,c.end_cause,a.status attempt_status,a.error_code
  from public.calls c join public.dial_attempts a on a.call_id=c.id where c.id=$1`, [endTestResult.callId]);
if (
  endedUnansweredRow.rows[0].call_status !== 'cancelled'
  || endedUnansweredRow.rows[0].ended_at === null
  || endedUnansweredRow.rows[0].end_cause !== 'cancelled_by_user'
  || endedUnansweredRow.rows[0].attempt_status !== 'failed'
  || endedUnansweredRow.rows[0].error_code !== 'ENDED_BY_SELLER'
) {
  throw new Error(`Ended call row is wrong: ${JSON.stringify(endedUnansweredRow.rows[0])}`);
}
// The point of the whole action: the seat is free again immediately, without
// waiting for the janitor's 15-minute floor.
const dialAfterEnd = await db.query(`
  select public.reserve_outbound_call(
    '00000000-0000-0000-0000-000000000025',null,'+46702222225',null,null,null,
    gen_random_uuid(),'central-after-end','customer_service',null,null
  ) as result
`);
const afterEndResult = dialAfterEnd.rows[0].result;
if (!afterEndResult.callId || afterEndResult.callId === endTestResult.callId) {
  throw new Error(`Ending the call did not free the seller to dial again: ${JSON.stringify(afterEndResult)}`);
}
// An answered call is a different claim. The server cannot drop the leg, so the
// conversation is on a device Kundexa cannot reach; writing a terminal status
// here would freeze the projection (protect_call_projection pins every
// provider field once the rank reaches 100) and discard the duration and
// outcome the provider is about to report. Release the attempt, leave the call.
await db.exec(`update public.calls set status='answered',answered_at=now() where id='${afterEndResult.callId}'`);
const endedAnswered = await db.query(`select public.end_active_call($1,null) as result`, [afterEndResult.callId]);
const endedAnsweredResult = endedAnswered.rows[0].result;
if (
  endedAnsweredResult.attemptReleased !== true
  || endedAnsweredResult.callClosed !== false
  || endedAnsweredResult.answeredWhenEnded !== true
  || endedAnsweredResult.callStatus !== 'answered'
) {
  throw new Error(`Ending an answered call wrongly closed it: ${JSON.stringify(endedAnsweredResult)}`);
}
const answeredRow = await db.query(`select status,ended_at from public.calls where id=$1`, [afterEndResult.callId]);
if (answeredRow.rows[0].status !== 'answered' || answeredRow.rows[0].ended_at !== null) {
  throw new Error(`An answered call was closed by the seller's end action: ${JSON.stringify(answeredRow.rows[0])}`);
}
// The provider's own outcome still lands afterwards, which is the entire reason
// the call row was left open.
await db.exec(`update public.calls set status='completed',ended_at=now(),duration_seconds=61 where id='${afterEndResult.callId}'`);
const providerTruth = await db.query(`select status,duration_seconds from public.calls where id=$1`, [afterEndResult.callId]);
if (providerTruth.rows[0].status !== 'completed' || providerTruth.rows[0].duration_seconds !== 61) {
  throw new Error(`Provider outcome could not land after the seller ended the call: ${JSON.stringify(providerTruth.rows[0])}`);
}
await db.exec(`update public.dial_attempts set status='completed' where call_id='${afterEndResult.callId}';`);

console.log("Executed ending a call: an open attempt blocks the next dial, another tenant may not end the call, ending an unanswered call closes it and frees the seat at once, and ending an answered call releases only the attempt so the provider's duration still lands.");

// --- Webbtelefonens session ---------------------------------------------
// The browser is the call leg here, so a dead tab means dead audio and the
// attempt must be released. The hard part is the boundary: an attempt that
// came from the provider's own /dial has no session, and closing a tab says
// nothing about whether that call is still live. These tests hold that line.
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false)`);
const openedSession = await db.query(`select public.open_webphone_session('sinch','TestAgent/1.0') as result`);
const firstSession = openedSession.rows[0].result;
if (!firstSession.sessionId || firstSession.status !== 'registering' || firstSession.heartbeatSeconds !== 15) {
  throw new Error(`Opening a webphone session returned the wrong shape: ${JSON.stringify(firstSession)}`);
}
// `registered` must mean a SIP registration actually succeeded, not merely that
// a tab is open. Only a heartbeat carrying a registration id may promote it.
const beatWithoutRegistration = await db.query(`select public.heartbeat_webphone_session($1,null) as result`, [firstSession.sessionId]);
if (beatWithoutRegistration.rows[0].result.alive !== true || beatWithoutRegistration.rows[0].result.status !== 'registering') {
  throw new Error(`A heartbeat without a registration id wrongly promoted the session: ${JSON.stringify(beatWithoutRegistration.rows[0].result)}`);
}
const beatWithRegistration = await db.query(`select public.heartbeat_webphone_session($1,'sip-reg-1') as result`, [firstSession.sessionId]);
if (beatWithRegistration.rows[0].result.status !== 'registered' || beatWithRegistration.rows[0].result.registrationId !== 'sip-reg-1') {
  throw new Error(`A registered webphone was not recorded as registered: ${JSON.stringify(beatWithRegistration.rows[0].result)}`);
}
// A second tab replaces the first. Two live registrations would be two phones
// that can both ring, which is exactly what the reservation guard exists to stop.
const secondSession = (await db.query(`select public.open_webphone_session('sinch',null) as result`)).rows[0].result;
const liveSessions = await db.query(`
  select count(*)::int as live from public.webphone_sessions
  where seller_user_id='00000000-0000-0000-0000-000000000002' and status in ('registering','registered')
`);
if (liveSessions.rows[0].live !== 1) {
  throw new Error(`A seller ended up with ${liveSessions.rows[0].live} live webphone sessions; exactly one may be live.`);
}
const replacedRow = await db.query(`select status,close_reason from public.webphone_sessions where id=$1`, [firstSession.sessionId]);
if (replacedRow.rows[0].status !== 'closed') {
  throw new Error(`Opening a new webphone session left the old one live: ${JSON.stringify(replacedRow.rows[0])}`);
}
// Another tenant's seller may not reach this session at all.
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000050',false)`);
let crossTenantSessionRefused = false;
try {
  await db.query(`select public.close_webphone_session($1,'inte min')`, [secondSession.sessionId]);
} catch (error) {
  crossTenantSessionRefused = String(error).includes('webphone_session_not_found');
}
if (!crossTenantSessionRefused) {
  throw new Error("A seller in another tenant was able to close this tenant's webphone session.");
}
// RLS only binds a non-superuser, and `set local role` lives for one
// transaction, so the visibility probe runs inside a DO block like the others.
await db.exec(`grant usage on schema public to authenticated;`);
await db.query(`
do $webphone$
declare
  v_foreign integer;
  v_own integer;
begin
  perform set_config('request.jwt.claim.role','authenticated',true);
  set local role authenticated;

  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000050',true);
  select count(*) into v_foreign from public.webphone_sessions where id='${secondSession.sessionId}';
  if v_foreign <> 0 then
    raise exception 'Another tenant''s seller can read this tenant''s webphone session';
  end if;

  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
  select count(*) into v_own from public.webphone_sessions where id='${secondSession.sessionId}';
  if v_own <> 1 then
    raise exception 'The seller could not read their own webphone session back';
  end if;

  reset role;
end
$webphone$;
`);
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false)`);

// A call carried by the session: closing the session releases the attempt and
// fails the call, because the audio left with the tab.
const webphoneCall = (await db.query(`
  select public.reserve_outbound_call(
    '00000000-0000-0000-0000-000000000025',null,'+46702222225',null,null,null,
    gen_random_uuid(),'webphone-session-call','customer_service'
  ) as result
`)).rows[0].result;
await db.exec(`update public.dial_attempts set webphone_session_id='${secondSession.sessionId}' where call_id='${webphoneCall.callId}'`);
const closedCarrying = (await db.query(`select public.close_webphone_session($1,'Fliken stängdes') as result`, [secondSession.sessionId])).rows[0].result;
if (closedCarrying.releasedAttempts !== 1) {
  throw new Error(`Closing a webphone session did not release the attempt it carried: ${JSON.stringify(closedCarrying)}`);
}
const carriedRow = await db.query(`
  select a.status attempt_status,a.error_code,c.status call_status,c.end_cause
  from public.dial_attempts a join public.calls c on c.id=a.call_id where a.call_id=$1
`, [webphoneCall.callId]);
if (
  carriedRow.rows[0].attempt_status !== 'failed'
  || carriedRow.rows[0].error_code !== 'WEBPHONE_SESSION_ENDED'
  || carriedRow.rows[0].call_status !== 'failed'
  || carriedRow.rows[0].end_cause !== 'webphone_session_lost'
) {
  throw new Error(`A lost webphone session left the call in the wrong state: ${JSON.stringify(carriedRow.rows[0])}`);
}

// The line that matters most. A provider-side /dial attempt has no session, and
// a closed tab is no evidence that its call ended — releasing it would let the
// seller start a second call while the first is still connected.
const providerCall = (await db.query(`
  select public.reserve_outbound_call(
    '00000000-0000-0000-0000-000000000025',null,'+46702222225',null,null,null,
    gen_random_uuid(),'webphone-boundary-dial','customer_service'
  ) as result
`)).rows[0].result;
const boundarySession = (await db.query(`select public.open_webphone_session('sinch',null) as result`)).rows[0].result;
const closedEmpty = (await db.query(`select public.close_webphone_session($1,'Fliken stängdes') as result`, [boundarySession.sessionId])).rows[0].result;
if (closedEmpty.releasedAttempts !== 0) {
  throw new Error(`Closing a webphone session released a provider /dial attempt that it never carried: ${JSON.stringify(closedEmpty)}`);
}
const untouched = await db.query(`select status from public.dial_attempts where call_id=$1`, [providerCall.callId]);
if (!['requested','dial_requested','awaiting_provider_event'].includes(untouched.rows[0].status)) {
  throw new Error(`A provider /dial attempt was released by the webphone session sweeper: ${JSON.stringify(untouched.rows[0])}`);
}

// The sweeper: only service_role, never a bound short enough that a network
// hiccup reads as a dropped call, and it must leave the provider attempt alone.
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false)`);
let sweepRequiresServiceRole = false;
try {
  await db.query(`select public.release_lost_webphone_sessions(interval '2 minutes',200)`);
} catch (error) {
  sweepRequiresServiceRole = String(error).includes('service_role_required');
}
if (!sweepRequiresServiceRole) {
  throw new Error('A signed-in user was able to run the webphone session sweeper.');
}
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
let sweepFloorHeld = false;
try {
  await db.query(`select public.release_lost_webphone_sessions(interval '10 seconds',200)`);
} catch (error) {
  sweepFloorHeld = String(error).includes('webphone_silence_bound_too_short');
}
if (!sweepFloorHeld) {
  throw new Error('The webphone sweeper accepted a silence bound short enough to read a network hiccup as a dropped call.');
}
const silentSession = (await db.query(`
  select set_config('request.jwt.claim.role','authenticated',false),
         public.open_webphone_session('sinch',null) as result
`)).rows[0].result;
await db.exec(`update public.dial_attempts set webphone_session_id='${silentSession.sessionId}' where call_id='${providerCall.callId}' and false`);
await db.exec(`update public.webphone_sessions set last_heartbeat_at=now()-interval '10 minutes' where id='${silentSession.sessionId}'`);
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
const swept = (await db.query(`select public.release_lost_webphone_sessions(interval '1 minute',200) as result`)).rows[0].result;
if (swept.sessionsClosed !== 1) {
  throw new Error(`The webphone sweeper did not close the silent session: ${JSON.stringify(swept)}`);
}
const sweptRow = await db.query(`select status,close_reason from public.webphone_sessions where id=$1`, [silentSession.sessionId]);
if (sweptRow.rows[0].status !== 'lost') {
  throw new Error(`A silent webphone session was not marked lost: ${JSON.stringify(sweptRow.rows[0])}`);
}
const stillUntouched = await db.query(`select status from public.dial_attempts where call_id=$1`, [providerCall.callId]);
if (!['requested','dial_requested','awaiting_provider_event'].includes(stillUntouched.rows[0].status)) {
  throw new Error(`The webphone sweeper released a provider /dial attempt: ${JSON.stringify(stillUntouched.rows[0])}`);
}
await db.exec(`
  select set_config('request.jwt.claim.role','authenticated',false);
  update public.dial_attempts set status='completed' where call_id='${providerCall.callId}';
`);
console.log("Executed the webphone session: a registration is only registered once SIP says so, a second tab replaces the first, another tenant cannot see or close the session, a lost session releases the call leg it carried, and neither closing nor sweeping ever touches a provider /dial attempt.");

// --- Webbtelefonens egen rapport om samtalsbenet -------------------------
// The browser knows first, but it is an interested party. It may move the call
// forward through states it genuinely sees first, and free the seat when the leg
// dies; it may never write a final outcome onto an answered call, because the
// duration and cause are the provider's and a terminal status here would freeze
// the projection before they land.
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false)`);
const legSession = (await db.query(`select public.open_webphone_session('sinch',null) as result`)).rows[0].result;
const legCall = (await db.query(`
  select public.reserve_outbound_call(
    '00000000-0000-0000-0000-000000000025',null,'+46702222225',null,null,null,
    gen_random_uuid(),'webphone-leg-answered','customer_service'
  ) as result
`)).rows[0].result;

// Reporting a leg for a session that is not yours is refused outright.
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000050',false)`);
let foreignLegRefused = false;
try {
  await db.query(`select public.record_webphone_leg_event($1,$2,'ringing',now())`, [legCall.callId, legSession.sessionId]);
} catch (error) {
  foreignLegRefused = String(error).includes('webphone_session_not_found');
}
if (!foreignLegRefused) {
  throw new Error("A seller in another tenant reported a call leg on this tenant's webphone session.");
}
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false)`);

// The first event binds the attempt to the session. Without that binding the
// sweeper could not tell this leg from a provider /dial and would never release
// it when the tab dies.
await db.query(`select public.record_webphone_leg_event($1,$2,'ringing',now())`, [legCall.callId, legSession.sessionId]);
const boundAttempt = await db.query(`select webphone_session_id,status from public.dial_attempts where call_id=$1`, [legCall.callId]);
if (boundAttempt.rows[0].webphone_session_id !== legSession.sessionId) {
  throw new Error(`The first leg event did not bind the attempt to the webphone session: ${JSON.stringify(boundAttempt.rows[0])}`);
}
const legRingingRow = await db.query(`select status from public.calls where id=$1`, [legCall.callId]);
if (legRingingRow.rows[0].status !== 'ringing') {
  throw new Error(`A reported ringing leg did not move the call to ringing: ${JSON.stringify(legRingingRow.rows[0])}`);
}

// answered_at is the whole point: it must stop depending on a webhook that may
// never arrive, while staying honest about where it came from.
const answeredLeg = (await db.query(`select public.record_webphone_leg_event($1,$2,'answered',now()) as result`, [legCall.callId, legSession.sessionId])).rows[0].result;
if (answeredLeg.advancedTo !== 'answered' || answeredLeg.authoritative !== false) {
  throw new Error(`A reported answer was not recorded as a non-authoritative advance: ${JSON.stringify(answeredLeg)}`);
}
const legAnsweredRow = await db.query(`select status,answered_at,metadata->>'answered_at_source' as source from public.calls where id=$1`, [legCall.callId]);
if (
  legAnsweredRow.rows[0].status !== 'answered'
  || legAnsweredRow.rows[0].answered_at === null
  || legAnsweredRow.rows[0].source !== 'webphone_client'
) {
  throw new Error(`A reported answer did not fill answered_at with its provenance: ${JSON.stringify(legAnsweredRow.rows[0])}`);
}
// Every client row is labelled, so reconciliation can always tell a browser's
// word from the provider's.
const legEvents = await db.query(`
  select count(*)::int as total, count(*) filter (where payload->>'source'='client_reported')::int as labelled
  from public.call_events where call_id=$1 and event_type like 'webphone.leg.%'
`, [legCall.callId]);
if (legEvents.rows[0].total !== 2 || legEvents.rows[0].labelled !== 2) {
  throw new Error(`Client-reported leg events are not all labelled: ${JSON.stringify(legEvents.rows[0])}`);
}

// Ending an answered call frees the seat but must not write an outcome.
const endedAnsweredLeg = (await db.query(`select public.record_webphone_leg_event($1,$2,'ended',now()) as result`, [legCall.callId, legSession.sessionId])).rows[0].result;
if (endedAnsweredLeg.attemptReleased !== true || endedAnsweredLeg.advancedTo !== null) {
  throw new Error(`Ending an answered leg wrote an outcome the provider owns: ${JSON.stringify(endedAnsweredLeg)}`);
}
const answeredAfterEnd = await db.query(`select status,ended_at from public.calls where id=$1`, [legCall.callId]);
if (answeredAfterEnd.rows[0].status !== 'answered' || answeredAfterEnd.rows[0].ended_at !== null) {
  throw new Error(`A client ended an answered call instead of leaving it to the provider: ${JSON.stringify(answeredAfterEnd.rows[0])}`);
}
// And the provider's own outcome still lands afterwards, which is why the row
// was left open.
await db.exec(`update public.calls set status='completed',ended_at=now(),duration_seconds=94 where id='${legCall.callId}'`);
const providerAfterLeg = await db.query(`select status,duration_seconds from public.calls where id=$1`, [legCall.callId]);
if (providerAfterLeg.rows[0].status !== 'completed' || providerAfterLeg.rows[0].duration_seconds !== 94) {
  throw new Error(`The provider outcome could not land after a client leg report: ${JSON.stringify(providerAfterLeg.rows[0])}`);
}

// An unanswered call is a different claim: nothing is lost by closing it,
// because there was never a duration or an outcome to lose.
const unansweredCall = (await db.query(`
  select public.reserve_outbound_call(
    '00000000-0000-0000-0000-000000000025',null,'+46702222225',null,null,null,
    gen_random_uuid(),'webphone-leg-unanswered','customer_service'
  ) as result
`)).rows[0].result;
const endedUnansweredLeg = (await db.query(`select public.record_webphone_leg_event($1,$2,'ended',now()) as result`, [unansweredCall.callId, legSession.sessionId])).rows[0].result;
if (endedUnansweredLeg.advancedTo !== 'unanswered' || endedUnansweredLeg.attemptReleased !== true) {
  throw new Error(`Ending an unanswered leg did not close the call: ${JSON.stringify(endedUnansweredLeg)}`);
}
// The seat is free again straight away, which is the point of reporting at all.
const dialAfterLeg = (await db.query(`
  select public.reserve_outbound_call(
    '00000000-0000-0000-0000-000000000025',null,'+46702222225',null,null,null,
    gen_random_uuid(),'webphone-leg-next','customer_service'
  ) as result
`)).rows[0].result;
if (!dialAfterLeg.callId || dialAfterLeg.callId === unansweredCall.callId) {
  throw new Error(`Reporting the leg end did not free the seller to dial again: ${JSON.stringify(dialAfterLeg)}`);
}
await db.exec(`
  update public.dial_attempts set status='completed' where call_id='${dialAfterLeg.callId}';
  select public.close_webphone_session('${legSession.sessionId}','klar');
`);
console.log("Executed the webphone leg report: a foreign session is refused, the first event binds the attempt so the sweeper can see the leg, a reported answer fills answered_at with its provenance, every client row is labelled, ending an answered call frees the seat without writing the provider's outcome, and ending an unanswered one closes it.");

// --- Ett släppt försök stannar släppt ------------------------------------
// A late provider event must never take the seller's seat back. Measured in
// production on 2026-09-15: the seller ended the call at 10:57:21, the attempt
// was releasedAttempt, and the CDR reconciliation set it back to `matched` at 10:59:02
// because the CDR carried no end time. `matched` is a status the reservation
// refuses and the sweeper deliberately will not release, so the seller was locked
// out for ninety minutes.
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false)`);
const terminalCall = (await db.query(`
  select public.reserve_outbound_call(
    '00000000-0000-0000-0000-000000000025',null,'+46702222225',null,null,null,
    gen_random_uuid(),'terminal-attempt-guard','customer_service'
  ) as result
`)).rows[0].result;
await db.query(`select public.end_active_call($1,'klar') as result`, [terminalCall.callId]);
const releasedAttempt = await db.query(`select status,error_code from public.dial_attempts where call_id=$1`, [terminalCall.callId]);
if (releasedAttempt.rows[0].status !== 'failed') {
  throw new Error(`The attempt was not releasedAttempt before the guard was tested: ${JSON.stringify(releasedAttempt.rows[0])}`);
}

// This is the exact write the CDR reconciliation performs.
await db.exec(`
  update public.dial_attempts
  set external_call_id=coalesce(external_call_id,'cdr-late-1'),
      status='matched', updated_at=now()
  where call_id='${terminalCall.callId}';
`);
const afterCdr = await db.query(`select status,error_code,external_call_id from public.dial_attempts where call_id=$1`, [terminalCall.callId]);
if (afterCdr.rows[0].status !== 'failed') {
  throw new Error(`A late provider event took the seller's seat back: ${JSON.stringify(afterCdr.rows[0])}`);
}
// The rest of the write must still land — the provider may enrich the row, it
// just may not reopen it.
if (afterCdr.rows[0].external_call_id !== 'cdr-late-1') {
  throw new Error(`The guard blocked provider enrichment it should have allowed: ${JSON.stringify(afterCdr.rows[0])}`);
}
if (afterCdr.rows[0].error_code !== 'ENDED_BY_SELLER') {
  throw new Error(`The guard lost the reason the attempt was releasedAttempt: ${JSON.stringify(afterCdr.rows[0])}`);
}
// And the seller can dial again, which is the whole point.
const dialAfterGuard = (await db.query(`
  select public.reserve_outbound_call(
    '00000000-0000-0000-0000-000000000025',null,'+46702222225',null,null,null,
    gen_random_uuid(),'terminal-attempt-guard-next','customer_service'
  ) as result
`)).rows[0].result;
if (!dialAfterGuard.callId || dialAfterGuard.callId === terminalCall.callId) {
  throw new Error(`A reopened attempt still blocked the next dial: ${JSON.stringify(dialAfterGuard)}`);
}
// A terminal attempt may still move between terminal statuses; only the way back
// to a seat-holding status is refused.
await db.exec(`update public.dial_attempts set status='completed' where call_id='${terminalCall.callId}';`);
const terminalToTerminal = await db.query(`select status from public.dial_attempts where call_id=$1`, [terminalCall.callId]);
if (terminalToTerminal.rows[0].status !== 'completed') {
  throw new Error(`The guard blocked a legitimate terminal-to-terminal transition: ${JSON.stringify(terminalToTerminal.rows[0])}`);
}
await db.exec(`update public.dial_attempts set status='completed' where call_id='${dialAfterGuard.callId}';`);
console.log("Executed the released-attempt guard: a late CDR cannot take the seller's seat back, the provider may still enrich the row, the release reason survives, the next dial is free, and a terminal-to-terminal transition is still allowed.");




console.log("Executed two-tenant telephony isolation, atomic reservation, idempotent replay, provider finalization and immutable call history runtime paths.");


// A private individual with no legal basis AND no contact-permission row must be
// refused. `v_permission_status` is null in that case, and before the fix the
// three-valued `false or null` made the legal-basis guard evaluate to null and
// silently pass.
await db.exec(`
  select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
  -- Pin the contact-hours window so these probes do not depend on the wall clock.
  insert into public.tenant_settings(tenant_id,compliance)
  values('00000000-0000-0000-0000-000000000001',
    '{"allowed_call_isodow":[1,2,3,4,5,6,7],"call_start_local":"00:00","call_end_local":"23:59"}'::jsonb)
  on conflict(tenant_id) do update set compliance=excluded.compliance;
  insert into public.customers(
    id,tenant_id,customer_type,lifecycle,display_name,phone_e164,marketing_allowed,legal_basis,created_by
  ) values(
    '00000000-0000-0000-0000-000000000080','00000000-0000-0000-0000-000000000001','person','prospect',
    'Legal Basis Probe','+46700000180',null,null,'00000000-0000-0000-0000-000000000002'
  );
  insert into public.tenant_features(tenant_id,feature_key,enabled)
    values('00000000-0000-0000-0000-000000000001','outbound_calls',true)
    on conflict(tenant_id,feature_key) do update set enabled=true;
`);
const noPermissionRow = await db.query(`select public.evaluate_contact_policy_for_tenant(
  '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000080','call','direct_marketing'
) as policy`);
if (
  noPermissionRow.rows[0].policy.allowed !== false
  || noPermissionRow.rows[0].policy.reason !== "legal_basis_required"
) {
  throw new Error(`Legal basis gate did not fire without a contact-permission row: ${JSON.stringify(noPermissionRow.rows[0].policy)}`);
}
// A recorded consent is a legal basis, so the same customer becomes permissible
// up to the independent NIX control.
await db.exec(`
  insert into public.contact_permissions(tenant_id,customer_id,channel,purpose,status,source,valid_from,created_by)
  values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000080','call','direct_marketing','allowed','verify-runtime',now(),'00000000-0000-0000-0000-000000000002');
`);
const withConsent = await db.query(`select public.evaluate_contact_policy_for_tenant(
  '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000080','call','direct_marketing'
) as policy`);
if (withConsent.rows[0].policy.reason === "legal_basis_required") {
  throw new Error(`Recorded consent was not accepted as a legal basis: ${JSON.stringify(withConsent.rows[0].policy)}`);
}
// The NIX control is independent and must still refuse a private individual.
if (withConsent.rows[0].policy.allowed !== false || withConsent.rows[0].policy.reason !== "nix_check_required") {
  throw new Error(`NIX control did not stand on its own: ${JSON.stringify(withConsent.rows[0].policy)}`);
}
console.log("Executed contact-policy legal-basis runtime path: missing consent refused, recorded consent accepted, NIX control independent.");

// NIX screening mode. A tenant that sources pre-screened numbers must be able to
// call them, while a number known to be listed stays refused in every mode.
const setCompliance = (patch) => db.exec(`
  update public.tenant_settings
  set compliance = compliance || '${patch}'::jsonb
  where tenant_id='00000000-0000-0000-0000-000000000001';
`);
const policyFor = async (customerId) => (await db.query(
  `select public.evaluate_contact_policy_for_tenant(
     '00000000-0000-0000-0000-000000000001',$1,'call','direct_marketing') as policy`,
  [customerId],
)).rows[0].policy;

await setCompliance('{"nix_screening_mode":"pre_screened_source"}');
const preScreened = await policyFor("00000000-0000-0000-0000-000000000080");
if (preScreened.allowed !== true) {
  throw new Error(`A pre-screened source must not require an in-app NIX result: ${JSON.stringify(preScreened)}`);
}

// The legal-basis gate still stands on its own for a card with no basis at all.
await db.exec(`
  insert into public.customers(
    id,tenant_id,customer_type,lifecycle,display_name,phone_e164,marketing_allowed,legal_basis,created_by
  ) values(
    '00000000-0000-0000-0000-000000000082','00000000-0000-0000-0000-000000000001','person','prospect',
    'Screening Probe','+46700000182',null,null,'00000000-0000-0000-0000-000000000002'
  );
`);
const withoutBasis = await policyFor("00000000-0000-0000-0000-000000000082");
if (withoutBasis.reason !== "legal_basis_required") {
  throw new Error(`Relaxing NIX must not relax the legal-basis gate: ${JSON.stringify(withoutBasis)}`);
}

// A tenant-wide documented basis satisfies it without touching every card.
await setCompliance('{"default_marketing_legal_basis":"berättigat intresse, tvättad källa"}');
const withTenantBasis = await policyFor("00000000-0000-0000-0000-000000000082");
if (withTenantBasis.allowed !== true) {
  throw new Error(`A tenant-wide legal basis was not accepted: ${JSON.stringify(withTenantBasis)}`);
}

// A recorded listing refuses the call even in the relaxed mode.
await db.exec(`
  insert into public.nix_checks(tenant_id,customer_id,phone_e164,source,result,checked_at,valid_until)
  values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000082','+46700000182',
    'seller_reported','listed',now(),now()+interval '1 year');
`);
const listedInRelaxedMode = await policyFor("00000000-0000-0000-0000-000000000082");
if (listedInRelaxedMode.allowed !== false || listedInRelaxedMode.reason !== "nix_listed") {
  throw new Error(`A known listing must refuse the call in every mode: ${JSON.stringify(listedInRelaxedMode)}`);
}

// A seller report is durable and keyed on the number: a different card created
// later for the same number is refused too.
await db.exec(`
  insert into public.customers(
    id,tenant_id,customer_type,lifecycle,display_name,phone_e164,marketing_allowed,legal_basis,created_by
  ) values(
    '00000000-0000-0000-0000-000000000083','00000000-0000-0000-0000-000000000001','person','prospect',
    'Seller Report Probe','+46700000183',null,'berättigat intresse','00000000-0000-0000-0000-000000000002'
  );
  select public.apply_call_block_disposition(
    '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000083',
    'nix_listed',null,'00000000-0000-0000-0000-000000000002','verify-runtime');
  insert into public.customers(
    id,tenant_id,customer_type,lifecycle,display_name,phone_e164,marketing_allowed,legal_basis,created_by
  ) values(
    '00000000-0000-0000-0000-000000000084','00000000-0000-0000-0000-000000000001','person','prospect',
    'Same Number Later','+46700000183',null,'berättigat intresse','00000000-0000-0000-0000-000000000002'
  );
`);
const reported = await db.query(`select
  (select count(*)::int from public.nix_checks
    where phone_e164='+46700000183' and result='listed' and source='seller_reported') as nix_rows,
  (select count(*)::int from public.compliance_blocks
    where phone_e164='+46700000183' and active and 'call'=any(channels)) as blocks,
  (select do_not_call from public.customers where id='00000000-0000-0000-0000-000000000083') as blocked`);
if (Number(reported.rows[0].nix_rows) !== 1 || Number(reported.rows[0].blocks) !== 1 || reported.rows[0].blocked !== true) {
  throw new Error(`Seller-reported NIX did not record durable evidence: ${JSON.stringify(reported.rows[0])}`);
}
const laterCard = await policyFor("00000000-0000-0000-0000-000000000084");
if (laterCard.allowed !== false) {
  throw new Error(`A number reported as listed was callable again on a new card: ${JSON.stringify(laterCard)}`);
}

// The reservation path carries its own NIX control keyed on the dialled number.
// It must agree with the contact policy: a company is never subject to the consumer
// register, and a private individual follows the tenant's screening mode.
const exactPolicyFor = async (customerId, phone) => (await db.query(
  `select public.evaluate_exact_call_policy(
     '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',
     $1,null,$2,null,null,null,null) as policy`,
  [customerId, phone],
)).rows[0].policy;

await db.exec(`
  select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
  insert into public.customers(
    id,tenant_id,customer_type,lifecycle,display_name,phone_e164,marketing_allowed,legal_basis,created_by
  ) values(
    '00000000-0000-0000-0000-000000000085','00000000-0000-0000-0000-000000000001','company','prospect',
    'Företagsprospekt AB','+46700000185',null,null,'00000000-0000-0000-0000-000000000002'
  );
`);
await setCompliance('{"nix_screening_mode":"provider_check"}');
const companyUnderStrictMode = await exactPolicyFor("00000000-0000-0000-0000-000000000085", "+46700000185");
if (companyUnderStrictMode.allowed !== true) {
  throw new Error(`A company must not need a consumer-register result: ${JSON.stringify(companyUnderStrictMode)}`);
}
const personUnderStrictMode = await exactPolicyFor("00000000-0000-0000-0000-000000000080", "+46700000180");
if (personUnderStrictMode.reason !== "nix_check_required" && personUnderStrictMode.reason !== "target_nix_check_required") {
  throw new Error(`A private individual must still be screened in the default mode: ${JSON.stringify(personUnderStrictMode)}`);
}
await setCompliance('{"nix_screening_mode":"pre_screened_source"}');
const personUnderPreScreened = await exactPolicyFor("00000000-0000-0000-0000-000000000080", "+46700000180");
if (personUnderPreScreened.allowed !== true) {
  throw new Error(`The reservation path ignored the screening mode: ${JSON.stringify(personUnderPreScreened)}`);
}

// Restore the strict default so later probes see unchanged behaviour.
await setCompliance('{"nix_screening_mode":"provider_check"}');
const strictAgain = await policyFor("00000000-0000-0000-0000-000000000080");
if (strictAgain.reason !== "nix_check_required") {
  throw new Error(`The strict default did not survive the round trip: ${JSON.stringify(strictAgain)}`);
}
console.log("Executed NIX screening runtime path: pre-screened source callable, tenant-wide legal basis accepted, known listing refused in every mode, seller report durable per number.");

// Creating a customer goes through PostgREST's `.insert().select()`, which is
// `INSERT ... RETURNING`. SELECT policies apply to RETURNING, so a policy that
// establishes access by selecting the row back out of its own table can never
// pass: a STABLE function cannot see the row the statement is still inserting.
//
// RLS is only enforced for a non-superuser, and `set local role` lives for one
// transaction, so the whole probe runs inside a single DO block.
// Supabase grants table privileges to `authenticated`; this harness creates the
// role bare, so grant what the probe needs before enforcing RLS on it.
await db.exec(`
  grant usage on schema public to authenticated;
  grant select, insert, update on public.customers to authenticated;
`);
await db.query(`
do $probe$
declare
  v_id uuid;
  v_foreign_visible integer;
  v_owner_visible integer;
begin
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  set local role authenticated;

  insert into public.customers(
    tenant_id,customer_type,display_name,phone_e164,lifecycle,created_by,assigned_user_id
  ) values(
    '00000000-0000-0000-0000-000000000001','company','Returning Probe','+46700000181','prospect',
    '00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002'
  ) returning id into v_id;
  if v_id is null then
    raise exception 'INSERT ... RETURNING on customers was blocked by the select policy';
  end if;

  select count(*) into v_owner_visible from public.customers where id=v_id;
  if v_owner_visible <> 1 then
    raise exception 'The creating tenant owner could not read the customer back';
  end if;

  -- A seller with no claim on the row must still be refused.
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000020',true);
  select count(*) into v_foreign_visible from public.customers where id=v_id;
  if v_foreign_visible <> 0 then
    raise exception 'An unrelated seller could read a customer they have no claim on';
  end if;

  reset role;
end
$probe$;
`);
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false)`);
console.log("Executed customer/contract RLS runtime path: INSERT ... RETURNING permitted for the creator, unrelated seller still refused.");

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
  throw new Error(`A late provider start regressed the terminal projection: ${JSON.stringify(monotonicCall.rows[0])}`);
}

console.log('Executed the monotonic call projection: a late lower-rank event cannot regress a terminal call, whichever provider reports it.');

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
console.log("Executed production hardening runtime paths: import truncation, provider buffering/monotonicity, Resend reducer, generation-bound signing finalization and idempotent contract activation.");

// Worker liveness, the seller dial lock and the ParseHub commit tenant context. These
// three gates decide whether telephony and automatic import work at all, and the dial lock
// is the one that strands a real seller when it is wrong.
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);

// A worker run that completed with per-job failures is a live worker. Reporting `degraded`
// must keep proving liveness, or one failing job switches the auto-dialer off everywhere.
await db.query(`select public.record_platform_worker_heartbeat('liveness-probe','probe-1','healthy',now()-interval '2 minutes',now()-interval '2 minutes',1,1,0,0,null,null,'{}'::jsonb)`);
const healthySuccess = await db.query(`select last_success_at from public.platform_worker_heartbeats where worker_key='liveness-probe'`);
await db.query(`select public.record_platform_worker_heartbeat('liveness-probe','probe-2','degraded',now(),now(),2,1,1,1,'JOB_FAILED','one job failed','{}'::jsonb)`);
const degradedSuccess = await db.query(`select status,last_success_at from public.platform_worker_heartbeats where worker_key='liveness-probe'`);
if (degradedSuccess.rows[0].status !== 'degraded'
  || !degradedSuccess.rows[0].last_success_at
  || new Date(degradedSuccess.rows[0].last_success_at) <= new Date(healthySuccess.rows[0].last_success_at)) {
  throw new Error(`A completed worker run reporting degraded did not refresh liveness: ${JSON.stringify(degradedSuccess.rows[0])}`);
}
await db.query(`select public.record_platform_worker_heartbeat('liveness-probe','probe-3','failed',now(),now(),0,0,1,0,'WORKER_FAILED','run aborted','{}'::jsonb)`);
const failedSuccess = await db.query(`select status,last_success_at from public.platform_worker_heartbeats where worker_key='liveness-probe'`);
if (failedSuccess.rows[0].status !== 'failed'
  || new Date(failedSuccess.rows[0].last_success_at).getTime() !== new Date(degradedSuccess.rows[0].last_success_at).getTime()) {
  throw new Error(`A failed worker run must not prove liveness: ${JSON.stringify(failedSuccess.rows[0])}`);
}
await db.query(`delete from public.platform_worker_heartbeats where worker_key='liveness-probe'`);

// The one-active-call lock must outlast a live call and nothing more. An attempt whose
// provider outcome never arrived may not lock the seller out of telephony for good.
await db.exec(`
  insert into public.customers(id,tenant_id,customer_type,lifecycle,display_name,phone_e164,marketing_allowed,legal_basis,created_by)
  values('00000000-0000-0000-0000-000000000094','00000000-0000-0000-0000-000000000001','company','prospect','Dial Lock Prospect','+46706660001',true,'legitimate_interest','00000000-0000-0000-0000-000000000002')
  on conflict(id) do nothing;
  update public.telephony_policies set telephony_enabled=true,manual_dialer_enabled=true,
    allowed_days='{1,2,3,4,5,6,7}',allowed_start_time='00:00',allowed_end_time='23:59:59'
    where tenant_id='00000000-0000-0000-0000-000000000001';
`);
await db.exec(`
  select set_config('request.jwt.claim.role','authenticated',false);
  select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
`);
const lockedReservation = await db.query(`select public.reserve_outbound_call(
  '00000000-0000-0000-0000-000000000094',null,'+46706660001',null,null,null,
  gen_random_uuid(),'dial-lock-1','direct_marketing',null,null) as result`);
const lockedAttemptId = String(lockedReservation.rows[0].result.attemptId);
if (!lockedAttemptId) throw new Error(`Dial lock probe could not reserve a call: ${JSON.stringify(lockedReservation.rows[0])}`);

async function reserveAgain(key) {
  try {
    const result = await db.query(`select public.reserve_outbound_call(
      '00000000-0000-0000-0000-000000000094',null,'+46706660001',null,null,null,
      gen_random_uuid(),$1,'direct_marketing',null,null) as result`, [key]);
    return { reserved: true, attemptId: String(result.rows[0].result.attemptId) };
  } catch (error) {
    return { reserved: false, message: error instanceof Error ? error.message : String(error) };
  }
}

await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.query(`update public.dial_attempts set status='reconciliation_required',requested_at=now() where id=$1`, [lockedAttemptId]);
const releasedNothingYet = await db.query(`select public.release_stale_dial_attempts(interval '1 hour',200) as result`);
if (Number(releasedNothingYet.rows[0].result.released) !== 0) {
  throw new Error(`The release gave up on an attempt that is still within its bound: ${JSON.stringify(releasedNothingYet.rows[0].result)}`);
}
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false)`);
const blockedWhileRecent = await reserveAgain('dial-lock-2');
if (blockedWhileRecent.reserved || !/active_call_already_exists|dial_attempts_one_open_per_seller_uidx/.test(blockedWhileRecent.message)) {
  throw new Error(`A recent unresolved attempt must still hold the dial lock: ${JSON.stringify(blockedWhileRecent)}`);
}

// A call that could still be connected is never released, however old the wait.
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.query(`update public.dial_attempts set status='matched',requested_at=now()-interval '6 hours' where id=$1`, [lockedAttemptId]);
const releasedLiveCall = await db.query(`select public.release_stale_dial_attempts(interval '1 hour',200) as result`);
const liveCallState = await db.query(`select status from public.dial_attempts where id=$1`, [lockedAttemptId]);
if (Number(releasedLiveCall.rows[0].result.released) !== 0 || liveCallState.rows[0].status !== 'matched') {
  throw new Error(`A connected call was released as unresolved: ${JSON.stringify(liveCallState.rows[0])}`);
}

// The provider went silent: release the attempt, keep the call unresolved.
await db.query(`update public.dial_attempts set status='reconciliation_required',requested_at=now()-interval '2 hours' where id=$1`, [lockedAttemptId]);
await db.query(`update public.calls set status='reconciliation_required',provider_status='unknown' where id=(select call_id from public.dial_attempts where id=$1)`, [lockedAttemptId]);
const released = await db.query(`select public.release_stale_dial_attempts(interval '1 hour',200) as result`);
if (Number(released.rows[0].result.released) !== 1) {
  throw new Error(`The stale dial attempt was not released: ${JSON.stringify(released.rows[0].result)}`);
}
const releasedState = await db.query(`
  select a.status attempt_status,a.error_code,c.status call_status,c.provider_status,
    (select count(*)::int from public.call_events e where e.call_id=a.call_id and e.event_type='dial_attempt.released_unresolved') events,
    (select count(*)::int from public.audit_logs l where l.entity_id=a.call_id::text and l.action='telephony.dial_attempt_released') audits
  from public.dial_attempts a join public.calls c on c.id=a.call_id where a.id=$1`, [lockedAttemptId]);
const releasedRow = releasedState.rows[0];
if (releasedRow.attempt_status !== 'failed' || releasedRow.error_code !== 'PROVIDER_OUTCOME_NEVER_REPORTED') {
  throw new Error(`The released attempt was not terminalized with its true reason: ${JSON.stringify(releasedRow)}`);
}
if (releasedRow.call_status !== 'reconciliation_required' || releasedRow.provider_status !== 'unknown') {
  throw new Error(`Releasing the dial lock invented a call outcome: ${JSON.stringify(releasedRow)}`);
}
if (Number(releasedRow.events) !== 1 || Number(releasedRow.audits) !== 1) {
  throw new Error(`The release left no audit trail: ${JSON.stringify(releasedRow)}`);
}
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false)`);
const releasedAfterBound = await reserveAgain('dial-lock-4');
if (!releasedAfterBound.reserved) {
  throw new Error(`An attempt with no provider outcome locked the seller out permanently: ${JSON.stringify(releasedAfterBound)}`);
}
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.query(`update public.dial_attempts set status='failed' where tenant_id='00000000-0000-0000-0000-000000000001' and seller_user_id='00000000-0000-0000-0000-000000000002' and status<>'failed'`);
// A connected call that ENDS must free the seller immediately, without waiting
// for any sweeper. This is the defect that stranded a real seller for three
// days: the call ended `unanswered` on 2026-09-11 and its attempt stayed
// `matched`, so every later dial was refused with "Säljaren eller den valda
// enheten har redan ett aktivt samtal".
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false)`);
const endToEndLock = await reserveAgain('dial-lock-end-to-end');
if (!endToEndLock.reserved) {
  throw new Error(`Could not reserve a call to test the end-of-call release: ${endToEndLock.message}`);
}
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
const liveAttempt = await db.query(`
  select id, call_id from public.dial_attempts
  where tenant_id='00000000-0000-0000-0000-000000000001'
    and seller_user_id='00000000-0000-0000-0000-000000000002'
    and status <> 'failed'
  order by requested_at desc limit 1`);
await db.query(`update public.dial_attempts set status='matched' where id=$1`, [liveAttempt.rows[0].id]);
await db.query(`update public.calls set status='unanswered' where id=$1`, [liveAttempt.rows[0].call_id]);
const attemptAfterCallEnded = await db.query(`select status from public.dial_attempts where id=$1`, [liveAttempt.rows[0].id]);
if (attemptAfterCallEnded.rows[0].status !== 'completed') {
  throw new Error(`A finished call left its dial attempt active, which bricks the seller: ${JSON.stringify(attemptAfterCallEnded.rows[0])}`);
}
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false)`);
const freedAfterCallEnded = await reserveAgain('dial-lock-after-end');
if (!freedAfterCallEnded.reserved) {
  throw new Error(`The seller was still blocked after their call ended: ${freedAfterCallEnded.message}`);
}
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.query(`update public.dial_attempts set status='failed' where tenant_id='00000000-0000-0000-0000-000000000001' and seller_user_id='00000000-0000-0000-0000-000000000002' and status<>'failed'`);
console.log("A call that ends releases its seller immediately; a connected call is never released.");


// Automatic ParseHub commit must take its tenant from the import run, never from whichever
// tenant the profile's creator happens to have selected in the web UI.
await db.exec(`
  insert into auth.users(id,email) values('00000000-0000-0000-0000-000000000095','multi-tenant-creator@example.test')
  on conflict(id) do nothing;
  insert into public.tenant_memberships(tenant_id,user_id,role,status,joined_at) values
    ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000095','admin','active',now()),
    ('00000000-0000-0000-0000-000000000051','00000000-0000-0000-0000-000000000095','admin','active',now())
  on conflict(tenant_id,user_id) do nothing;
  update public.profiles set active_tenant_id='00000000-0000-0000-0000-000000000051'
    where id='00000000-0000-0000-0000-000000000095';
  insert into public.import_profiles(id,tenant_id,name,source_provider,automatic_commit,current_version,active,created_by)
  values('00000000-0000-0000-0000-000000000096','00000000-0000-0000-0000-000000000001','ParseHub tenant context','parsehub',true,1,true,'00000000-0000-0000-0000-000000000095')
  on conflict(id) do nothing;
  insert into public.parsehub_projects(id,tenant_id,project_token_hash,project_name,import_profile_id,webhook_secret_hash,active)
  values('00000000-0000-0000-0000-000000000097','00000000-0000-0000-0000-000000000001','parsehub-project-hash','Tenant context project','00000000-0000-0000-0000-000000000096','parsehub-secret-hash',true)
  on conflict(id) do nothing;
  insert into public.import_runs(
    id,tenant_id,name,source_type,status,uploaded_by,total_rows,source_row_count,parsed_row_count,
    accepted_row_count,rejected_row_count,simulation,scan_status,file_sha256,idempotency_key,
    validation_fingerprint,import_profile_id,source_provider,field_mapping,validation_report
  ) values(
    '00000000-0000-0000-0000-000000000098','00000000-0000-0000-0000-000000000001','ParseHub tenant context run','json','preview_ready',
    '00000000-0000-0000-0000-000000000095',1,1,1,1,0,true,'clean','parsehub-sha','preview:parsehub-tenant-context',
    'parsehub:parsehub-sha','00000000-0000-0000-0000-000000000096','parsehub','{}'::jsonb,'{}'::jsonb
  ) on conflict(id) do nothing;
  insert into public.import_rows(tenant_id,import_run_id,row_number,raw_data,normalized_data,decision,row_status)
  values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000098',2,'{}'::jsonb,
    '{"customer_type":"company","display_name":"ParseHub Tenant Context AB","organization_number":"5560160680","phone_e164":"+46706660002"}'::jsonb,
    'ready','valid');
  insert into public.parsehub_runs(
    id,tenant_id,parsehub_project_id,import_profile_id,import_run_id,run_token_hash,idempotency_key,status
  ) values(
    '00000000-0000-0000-0000-000000000099','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000097',
    '00000000-0000-0000-0000-000000000096','00000000-0000-0000-0000-000000000098','parsehub-run-hash','parsehub-run-key','processing'
  ) on conflict(id) do nothing;
`);
await db.exec(`select set_config('request.jwt.claim.role','service_role',false); select set_config('request.jwt.claim.sub','',false);`);
const parsehubCommit = await db.query(`select public.process_parsehub_import_run('00000000-0000-0000-0000-000000000099') as result`);
if (parsehubCommit.rows[0].result.automaticCommit !== true
  || parsehubCommit.rows[0].result.committedByProfileCreator !== true) {
  throw new Error(`ParseHub automatic commit did not run as the profile creator: ${JSON.stringify(parsehubCommit.rows[0].result)}`);
}
const parsehubCommitted = await db.query(`
  select r.status,r.new_count,
    (select count(*)::int from public.customers c where c.source_import_run_id=r.id and c.tenant_id=r.tenant_id) imported
  from public.import_runs r where r.id='00000000-0000-0000-0000-000000000098'`);
if (!['completed', 'completed_with_warnings'].includes(parsehubCommitted.rows[0].status) || Number(parsehubCommitted.rows[0].imported) !== 1) {
  throw new Error(`ParseHub commit did not import into the run's own tenant: ${JSON.stringify(parsehubCommitted.rows[0])}`);
}
const creatorTenantUnchanged = await db.query(`select active_tenant_id from public.profiles where id='00000000-0000-0000-0000-000000000095'`);
if (String(creatorTenantUnchanged.rows[0].active_tenant_id) !== '00000000-0000-0000-0000-000000000051') {
  throw new Error(`The ParseHub commit changed the creator's own tenant selection: ${JSON.stringify(creatorTenantUnchanged.rows[0])}`);
}
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
console.log("Executed worker liveness, bounded seller dial lock and tenant-bound automatic ParseHub commit runtime paths.");

// A tenant boundary is enforced by the schema, not only by the callers that happen to be
// correct today. Any foreign key between two tenant-owned tables must be composite on
// (tenant_id, id), so a row can never reference another tenant's row.
const crossTenantKeys = await db.query(`
  select rel.relname as child, att.attname as child_column, parent.relname as parent
  from pg_constraint con
  join pg_class rel on rel.oid=con.conrelid
  join pg_namespace n on n.oid=rel.relnamespace and n.nspname='public'
  join pg_class parent on parent.oid=con.confrelid
  join pg_attribute att on att.attrelid=rel.oid and att.attnum=con.conkey[1]
  where con.contype='f' and array_length(con.conkey,1)=1
    and exists(select 1 from pg_attribute a where a.attrelid=rel.oid and a.attname='tenant_id' and a.attnum>0 and not a.attisdropped and a.attnotnull)
    and exists(select 1 from pg_attribute a where a.attrelid=parent.oid and a.attname='tenant_id' and a.attnum>0 and not a.attisdropped)
  order by 1,2
`);
if (crossTenantKeys.rows.length > 0) {
  throw new Error(`Single-column foreign keys between tenant-owned tables let a row point at another tenant: ${crossTenantKeys.rows.map((row) => `${row.child}.${row.child_column} -> ${row.parent}`).join(", ")}`);
}

// And prove the composite key actually refuses the cross-tenant write, rather than only
// looking right in the catalog.
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
let crossTenantWriteRefused = false;
try {
  await db.query(`
    insert into public.legal_holds(tenant_id,customer_id,scope,reason,active,starts_at,created_by)
    values('00000000-0000-0000-0000-000000000051','00000000-0000-0000-0000-000000000094',array['calls'],'cross tenant probe',true,now(),null)
  `);
} catch (error) {
  crossTenantWriteRefused = /foreign key|violates/i.test(error instanceof Error ? error.message : String(error));
}
if (!crossTenantWriteRefused) {
  throw new Error("A legal hold in one tenant accepted another tenant's customer id.");
}
console.log("Verified tenant-scoped reference integrity: every tenant-to-tenant foreign key is composite and a cross-tenant reference is refused.");

// The caller-ID selection that replaced the provider's number model is the same boundary, on a
// column a seller can reach through the UI: the number shown when calling from a team,
// campaign or list. A team must not be able to borrow another tenant's number as its
// caller ID, so prove the composite key refuses it rather than trusting the catalog shape.
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
// callerIdTenantIsolation: ett företags nummer får aldrig lånas av ett annat.
let callerIdTenantIsolation = false;
let foreignCallerIdRefused = false;
try {
  await db.query(`
    update public.teams set caller_id_phone_number_id='00000000-0000-0000-0000-000000000022'
    where id='00000000-0000-0000-0000-000000000076'
  `);
} catch (error) {
  foreignCallerIdRefused = /foreign key|violates/i.test(error instanceof Error ? error.message : String(error));
}
if (!foreignCallerIdRefused) {
  throw new Error("A team accepted another tenant's phone number as its caller ID.");
}
callerIdTenantIsolation = true;

// And the same write inside one tenant has to succeed, or the probe above would pass for
// the wrong reason -- a column nothing can ever be written to refuses everything.
await db.query(`
  update public.teams set caller_id_phone_number_id='00000000-0000-0000-0000-000000000022'
  where id='00000000-0000-0000-0000-000000000026'
`);
const ownCallerId = await db.query(`select caller_id_phone_number_id from public.teams where id='00000000-0000-0000-0000-000000000026'`);
if (ownCallerId.rows[0].caller_id_phone_number_id !== '00000000-0000-0000-0000-000000000022') {
  throw new Error("A team could not take its own tenant's phone number as its caller ID.");
}
await db.exec(`update public.teams set caller_id_phone_number_id=null where id='00000000-0000-0000-0000-000000000026'`);
if (!callerIdTenantIsolation) {
  throw new Error("The caller-ID tenant boundary was never exercised.");
}
console.log("Verified caller-ID selection: a team takes its own tenant's number and is refused another tenant's.");

// Calling hours are a system default, not something set per tenant by hand. A new
// tenant must inherit the window the owner decided on, or the first seller in
// every new company hits a refusal nobody configured.
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
const probeTenant = (await db.query(`
  insert into public.tenants(slug,name,legal_name,status)
  values('calling-hours-probe','Calling Hours Probe','Calling Hours Probe AB','active')
  returning id
`)).rows[0].id;
// The policy row is created for the tenant automatically, so read what the system
// actually gave it rather than inserting one here and testing my own row.
const inherited = await db.query(`
  select allowed_days, allowed_start_time::text as starts, allowed_end_time::text as ends
  from public.telephony_policies where tenant_id=$1
`, [probeTenant]);
if (inherited.rows.length !== 1) {
  throw new Error("A new tenant did not get a telephony policy at all.");
}
if (inherited.rows[0].starts !== '08:00:00' || inherited.rows[0].ends !== '21:00:00') {
  throw new Error(`A new tenant inherited calling hours ${inherited.rows[0].starts}-${inherited.rows[0].ends} instead of 08:00-21:00.`);
}
if ([...inherited.rows[0].allowed_days].sort().join(",") !== "1,2,3,4,5,6,7") {
  throw new Error(`A new tenant inherited calling days ${inherited.rows[0].allowed_days} instead of every day.`);
}

// Widening the default must not overwrite a tenant that deliberately chose its own
// hours. Moving a default and overruling a decision are different things.
//
// The migration's backfill is replayed here on purpose. Asserting after the
// migration has already run would measure nothing: the backfill executed before
// this probe's tenant existed, so any shape of WHERE clause would have left it
// alone. Replaying the statement is what puts the clause itself under test, and
// replacing the clause with `where true` does make this fail.
await db.query(`
  update public.telephony_policies
  set allowed_days='{1,2,3}'::integer[], allowed_start_time='10:00', allowed_end_time='15:00'
  where tenant_id=$1
`, [probeTenant]);
await db.exec(`
  update public.telephony_policies
  set allowed_days = '{1,2,3,4,5,6,7}'::integer[],
      allowed_start_time = '08:00'::time,
      allowed_end_time = '21:00'::time,
      updated_at = now()
  where allowed_days = '{1,2,3,4,5}'::integer[]
    and allowed_start_time = '09:00'::time
    and allowed_end_time = '18:00'::time
`);
const deliberate = await db.query(`
  select allowed_start_time::text as starts, allowed_end_time::text as ends
  from public.telephony_policies where tenant_id=$1
`, [probeTenant]);
if (deliberate.rows[0].starts !== '10:00:00' || deliberate.rows[0].ends !== '15:00:00') {
  throw new Error(`Widening the default overwrote a tenant's own calling hours: ${deliberate.rows[0].starts}-${deliberate.rows[0].ends}`);
}
await db.query(`delete from public.tenants where id=$1`, [probeTenant]);
console.log("Verified calling hours: a new tenant inherits the system default of every day 08:00-21:00, and widening that default leaves a tenant's own choice alone.");

// The neutral dial attempt is the seat model without the provider baked in, and a
// seat that can be held twice is not a seat. Exercise it directly rather than
// through the reservation RPC, so the table's own guarantees are what is measured.
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
const neutralCalls = await db.query(`
  insert into public.calls(tenant_id,customer_id,direction,from_number,to_number,status,callback_token_hash,purpose)
  values
    ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000021','outbound','+46401234567','+46702222241','queued','neutral-probe-a','direct_marketing'),
    ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000021','outbound','+46401234567','+46702222242','queued','neutral-probe-b','direct_marketing')
  returning id
`);
const [neutralCallA, neutralCallB] = neutralCalls.rows.map((row) => row.id);
const neutralSeller = '00000000-0000-0000-0000-000000000020';

const insertNeutralAttempt = (callId, key, status) => db.query(`
  insert into public.dial_attempts(
    tenant_id,call_id,seller_user_id,provider,caller_id_phone_number_id,caller_id_source,
    source_number_e164,destination_number_e164,client_request_id,idempotency_key,status,expires_at)
  values('00000000-0000-0000-0000-000000000001',$1,$2,'sinch',
    '00000000-0000-0000-0000-000000000022','tenant_default','+46401234567','+46702222241',
    gen_random_uuid(),$3,$4,now()+interval '5 minutes')
  returning id
`, [callId, neutralSeller, key, status]);

const firstNeutralAttempt = (await insertNeutralAttempt(neutralCallA, 'neutral-open-1', 'dial_requested')).rows[0].id;

let secondSeatRefused = false;
try {
  await insertNeutralAttempt(neutralCallB, 'neutral-open-2', 'requested');
} catch (error) {
  secondSeatRefused = /duplicate key|unique/i.test(error instanceof Error ? error.message : String(error));
}
if (!secondSeatRefused) {
  throw new Error("A seller held two open dial attempts at once, so the seat is a counter and not a seat.");
}

// Closing the first attempt has to free the seat, or the probe above would pass
// for the wrong reason: a table that refuses every second insert also refuses
// this one.
await db.query(`update public.dial_attempts set status='completed' where id=$1`, [firstNeutralAttempt]);
const secondNeutralAttempt = (await insertNeutralAttempt(neutralCallB, 'neutral-open-2', 'requested')).rows[0].id;

// A late provider event must not take a released seat back. This is the failure
// measured in production on 15 September, where a CDR reopened an attempt that
// had already been released and locked the seller out for ninety minutes.
//
// Close the second attempt first, so the seller has no open attempt at all. That
// matters: with one still open, the unique seat index rejects the reopening on
// its own and the trigger is never reached, so the assertion would pass without
// the guard it claims to measure. Removing the trigger proved exactly that.
await db.query(`update public.dial_attempts set status='completed' where id=$1`, [secondNeutralAttempt]);
await db.query(`update public.dial_attempts set status='matched', external_call_id='late-cdr' where id=$1`, [firstNeutralAttempt]);
const reopened = await db.query(`select status, external_call_id from public.dial_attempts where id=$1`, [firstNeutralAttempt]);
if (reopened.rows[0].status !== 'completed') {
  throw new Error(`A late provider event reopened a closed dial attempt: status is ${reopened.rows[0].status}.`);
}
if (reopened.rows[0].external_call_id !== 'late-cdr') {
  throw new Error("The terminal guard refused the whole write instead of only the seat, so the provider can no longer enrich the row.");
}

// Reading is scoped: a seller sees their own attempts, someone outside the tenant
// sees none, and an admin sees both.
//
// This runs inside a DO block that actually switches role. Setting the JWT claim
// alone leaves the connection as superuser, which bypasses RLS entirely -- and
// then every read returns every row, so the seller and admin assertions pass
// while measuring nothing. The first draft of this probe did exactly that, and
// only the stranger assertion noticed.
await db.exec(`update public.profiles set active_tenant_id='00000000-0000-0000-0000-000000000001' where id in ('00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000002')`);
await db.exec(`
  do $dialattempts$
  declare
    v_own integer;
    v_stranger integer;
    v_admin integer;
  begin
    perform set_config('request.jwt.claim.role','authenticated',true);
    set local role authenticated;

    -- Säljaren ser sina egna försök och bara sina egna. Antalet jämförs mot den
    -- egna raden och inte mot ett fast tal: tidigare block i sviten ringer också,
    -- och ett fast tal hade gjort provet till en räkneövning som går sönder varje
    -- gång ett annat prov läggs till.
    perform set_config('request.jwt.claim.sub','${neutralSeller}',true);
    select count(*) into v_own from public.dial_attempts;
    if v_own <> 2 then
      raise exception 'A seller saw % of their own dial attempts instead of 2', v_own;
    end if;
    if exists(select 1 from public.dial_attempts where seller_user_id <> '${neutralSeller}') then
      raise exception 'A seller could read another seller''s dial attempts';
    end if;

    perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000050',true);
    select count(*) into v_stranger from public.dial_attempts;
    if v_stranger <> 0 then
      raise exception 'Someone outside the tenant read % dial attempts', v_stranger;
    end if;

    -- Administratören ser hela företagets försök, inklusive säljarens två, och
    -- ingenting utanför företaget.
    perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
    select count(*) into v_admin from public.dial_attempts
      where seller_user_id = '${neutralSeller}';
    if v_admin <> 2 then
      raise exception 'A tenant admin saw % of the seller''s dial attempts instead of 2', v_admin;
    end if;
    if exists(select 1 from public.dial_attempts where tenant_id <> '00000000-0000-0000-0000-000000000001') then
      raise exception 'A tenant admin could read another tenant''s dial attempts';
    end if;
  end $dialattempts$;
`);

await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
console.log("Verified the neutral dial attempt: one open seat per seller, the seat frees on close, a late provider event cannot take it back, and reads are scoped to the seller and their admin.");

// The seller's whole journey, executed against the migrated schema: register the call that
// grounds a contract, draft it, send it, let the customer accept on the public page, and
// activate it once the evidence package exists. These are the exact RPCs the application
// calls; before this section the contract path was only checked by matching source text.
const JT = '00000000-0000-0000-0000-000000000001';
const JOWNER = '00000000-0000-0000-0000-000000000002';
const JCUSTOMER = '00000000-0000-0000-0000-0000000000c1';
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.exec(`
  insert into public.customers(id,tenant_id,customer_type,lifecycle,display_name,phone_e164,email,marketing_allowed,legal_basis,created_by)
  values('${JCUSTOMER}','${JT}','company','prospect','Journey Kund AB','+46705550001','journey@example.test',true,'legitimate_interest','${JOWNER}')
  on conflict(id) do nothing;
  insert into public.tenant_legal_entities(id,tenant_id,legal_name,organization_number,address_line1,postal_code,city,country_code,email,phone_e164,active)
  values('00000000-0000-0000-0000-0000000000c2','${JT}','Kundexa Journey AB','5560160680','Gatan 1','21115','Malmö','SE','avtal@example.test','+46401234567',true)
  on conflict(id) do nothing;
  insert into public.contract_templates(id,tenant_id,name,contract_type,audience,active,legal_entity_id)
  values('00000000-0000-0000-0000-0000000000c3','${JT}','Journey-mall','service','B2B',true,'00000000-0000-0000-0000-0000000000c2')
  on conflict(id) do nothing;
  insert into public.contract_template_versions(id,tenant_id,template_id,version,status,title_template,body_template,terms_template,created_by)
  values('00000000-0000-0000-0000-0000000000c4','${JT}','00000000-0000-0000-0000-0000000000c3',1,'draft','Journeyavtal','Brödtext','Villkor','${JOWNER}')
  on conflict(id) do nothing;
  insert into public.tenant_features(tenant_id,feature_key,enabled) values
    ('${JT}','outbound_email',true),('${JT}','contract_delivery_email',true)
  on conflict(tenant_id,feature_key) do update set enabled=true;
  insert into public.tenant_integrations(tenant_id,name,provider_type,provider,status,configuration,credentials_ciphertext)
  values('${JT}','Resend','email','resend','active','{"from_address":"avtal@example.test","account_mode":"tenant_owned"}','cipher')
  on conflict do nothing;
`);
await db.exec(`
  select set_config('request.jwt.claim.role','authenticated',false);
  select set_config('request.jwt.claim.sub','${JOWNER}',false);
`);
await db.exec(`
  update public.contract_template_versions set status='approved',approved_by='${JOWNER}',approved_at=now()
    where id='00000000-0000-0000-0000-0000000000c4';
  update public.contract_templates set current_version_id='00000000-0000-0000-0000-0000000000c4'
    where id='00000000-0000-0000-0000-0000000000c3';
`);

const journeyCall = await db.query(`select public.register_external_manual_call(
  '${JCUSTOMER}','+46705550001','outbound',now()-interval '20 minutes',now()-interval '10 minutes',
  'interested','Journey-samtal',null) as id`);
const journeyCallId = String(journeyCall.rows[0].id);

const journeyContract = await db.query(`select public.create_contract_draft_v3(
  'KX-JOURNEY-1','${JCUSTOMER}',null,null,'00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-0000000000c4',
  '00000000-0000-0000-0000-0000000000c2','Journeyavtal','Brödtext','Villkor','{"currency":"SEK"}'::jsonb,'journey-doc-hash',
  'telephone','{"legal_name":"Kundexa Journey AB"}'::jsonb,'{"display_name":"Journey Kund AB"}'::jsonb,
  '${JOWNER}',null,null,null,null,null,1000,'SEK',now()+interval '7 days') as id`);
const journeyContractId = String(journeyContract.rows[0].id);
await db.query(`update public.contracts set source_call_id=$1,source_type='external_manual_call',prepared_at=now(),status='ready' where id=$2`, [journeyCallId, journeyContractId]);
const journeyDocument = await db.query(`
  insert into public.contract_documents(tenant_id,contract_id,contract_version_id,document_type,file_name,storage_path,mime_type,size_bytes,sha256)
  select '${JT}',id,active_version_id,'generated_pdf','journey.pdf','${JT}/'||id::text||'/journey.pdf','application/pdf',4096,'journey-canonical-sha'
  from public.contracts where id=$1 returning id`, [journeyContractId]);
const journeyDocumentId = String(journeyDocument.rows[0].id);

const journeyDelivery = await db.query(`select public.prepare_contract_delivery_v2(
  $1,'email','Journey Kund AB','journey@example.test',null,'journey-token-hash','journey-token-cipher','ABCD',
  now()+interval '7 days',$2,null,null,'avtal@example.test','Ditt avtal','text','<p>html</p>','[]'::jsonb,null,null) as result`,
  [journeyContractId, journeyDocumentId]);
const journeySent = await db.query(`
  select c.status,c.first_sent_at is not null as sent,c.acceptance_generation,
    (select count(*)::int from public.contract_acceptance_requests r where r.contract_id=c.id and r.status='pending') pending,
    (select count(*)::int from public.contract_recipients cr where cr.contract_id=c.id) recipients,
    (select count(*)::int from public.email_messages m where m.contract_id=c.id) emails,
    (select count(*)::int from public.contract_reminders cr2 where cr2.contract_id=c.id and cr2.status='scheduled') reminders,
    (select locked_at is not null from public.contract_versions v where v.id=c.active_version_id) version_locked
  from public.contracts c where c.id=$1`, [journeyContractId]);
const sentState = journeySent.rows[0];
if (sentState.status !== 'sent' || !sentState.sent || Number(sentState.pending) !== 1
  || Number(sentState.recipients) !== 1 || Number(sentState.emails) !== 1
  || Number(sentState.reminders) < 1 || sentState.version_locked !== true) {
  throw new Error(`Sending a contract did not lock the version and queue the delivery: ${JSON.stringify(sentState)}`);
}
if (!journeyDelivery.rows[0].result.acceptance_request_id) {
  throw new Error(`Contract delivery returned no acceptance request: ${JSON.stringify(journeyDelivery.rows[0].result)}`);
}

// The public acceptance page runs as service role, which is the only role allowed to record
// a decision, and it must bind the acceptance to the exact document it showed.
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
const journeyRequest = await db.query(`select id from public.contract_acceptance_requests where contract_id=$1 and status='pending'`, [journeyContractId]);
const journeyAcceptance = await db.query(`select public.record_contract_acceptance_v3(
  $1,'web','accepted_via_web','WEB_ACCEPT','WEB_ACCEPT','Journey Testsson',null,'127.0.0.1','probe',null,
  'Jag accepterar','{}'::jsonb) as id`, [String(journeyRequest.rows[0].id)]);
const journeyAcceptanceId = String(journeyAcceptance.rows[0].id);
const accepted = await db.query(`
  select c.status,c.accepted_at is not null as accepted,
    (select count(*)::int from public.contract_recipients cr where cr.contract_id=c.id and cr.status='signed') signed_recipients,
    (select count(*)::int from public.outbox_jobs j where j.aggregate_id=c.id and j.job_type='evidence.generate') evidence_jobs,
    (select count(*)::int from public.outbox_jobs j where j.aggregate_id=c.id and j.job_type='contract.confirmation') confirmation_jobs,
    (select count(*)::int from public.contract_reminders cr2 where cr2.contract_id=c.id and cr2.status='scheduled') open_reminders,
    (select a.canonical_document_sha256 from public.contract_acceptances a where a.id=$2) bound_document_hash
  from public.contracts c where c.id=$1`, [journeyContractId, journeyAcceptanceId]);
const acceptedState = accepted.rows[0];
if (acceptedState.status !== 'accepted' || !acceptedState.accepted || Number(acceptedState.signed_recipients) !== 1) {
  throw new Error(`A web acceptance did not complete the contract: ${JSON.stringify(acceptedState)}`);
}
if (Number(acceptedState.evidence_jobs) !== 1 || Number(acceptedState.confirmation_jobs) !== 1) {
  throw new Error(`Acceptance did not queue evidence and confirmation exactly once: ${JSON.stringify(acceptedState)}`);
}
if (Number(acceptedState.open_reminders) !== 0) {
  throw new Error(`Reminders kept running after the customer accepted: ${JSON.stringify(acceptedState)}`);
}
if (acceptedState.bound_document_hash !== 'journey-canonical-sha') {
  throw new Error(`The acceptance was not bound to the exact document shown: ${JSON.stringify(acceptedState)}`);
}

// Activation is refused until the evidence package for this generation exists.
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false); select set_config('request.jwt.claim.sub','${JOWNER}',false);`);
let activationRefused = false;
try {
  await db.query(`select public.activate_completed_contract($1)`, [journeyContractId]);
} catch (error) {
  activationRefused = /evidence/.test(error instanceof Error ? error.message : String(error));
}
if (!activationRefused) throw new Error("A contract was activated without a completed evidence package.");

await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.query(`
  insert into public.evidence_packages(tenant_id,contract_id,contract_version_id,acceptance_id,status,manifest,manifest_hash,storage_path,generated_at,canonical_document_id,canonical_document_sha256)
  select '${JT}',id,active_version_id,$2,'completed',jsonb_build_object('generation',acceptance_generation),'journey-manifest','journey/path',now(),$3,'journey-canonical-sha'
  from public.contracts where id=$1`, [journeyContractId, journeyAcceptanceId, journeyDocumentId]);
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false); select set_config('request.jwt.claim.sub','${JOWNER}',false);`);
const activated = await db.query(`select public.activate_completed_contract($1) as result`, [journeyContractId]);
const activatedState = await db.query(`select status,activated_at from public.contracts where id=$1`, [journeyContractId]);
if (activated.rows[0].result.status !== 'active' || activatedState.rows[0].status !== 'active' || !activatedState.rows[0].activated_at) {
  throw new Error(`Contract activation after evidence failed: ${JSON.stringify(activatedState.rows[0])}`);
}
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
console.log("Executed the seller journey: grounding call, contract draft, locked send, public web acceptance bound to the exact document, and evidence-gated activation.");

// A deadline that passes is the ordinary case, not the end of the agreement: the link
// expires, the contract is marked expired, and the seller must be able to send the same
// contract again rather than draft it from scratch.
const JEXPIRE = '00000000-0000-0000-0000-0000000000c8';
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.exec(`
  insert into public.customers(id,tenant_id,customer_type,lifecycle,display_name,phone_e164,email,marketing_allowed,legal_basis,created_by)
  values('${JEXPIRE}','${JT}','company','prospect','Utgången Kund AB','+46705550009','utgangen@example.test',true,'legitimate_interest','${JOWNER}')
  on conflict(id) do nothing;
`);
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false); select set_config('request.jwt.claim.sub','${JOWNER}',false);`);
const expiringCall = await db.query(`select public.register_external_manual_call(
  '${JEXPIRE}','+46705550009','outbound',now()-interval '20 minutes',now()-interval '10 minutes',
  'interested','Utgångssamtal',null) as id`);
const expiringContract = await db.query(`select public.create_contract_draft_v3(
  'KX-JOURNEY-EXPIRE','${JEXPIRE}',null,null,'00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-0000000000c4',
  '00000000-0000-0000-0000-0000000000c2','Utgångsavtal','Brödtext','Villkor','{"currency":"SEK"}'::jsonb,'expire-doc-hash',
  'telephone','{"legal_name":"Kundexa Journey AB"}'::jsonb,'{"display_name":"Utgången Kund AB"}'::jsonb,
  '${JOWNER}',null,null,null,null,null,1000,'SEK',now()+interval '7 days') as id`);
const expiringContractId = String(expiringContract.rows[0].id);
await db.query(`update public.contracts set source_call_id=$1,source_type='external_manual_call',prepared_at=now(),status='ready' where id=$2`, [String(expiringCall.rows[0].id), expiringContractId]);
const expiringDocument = await db.query(`
  insert into public.contract_documents(tenant_id,contract_id,contract_version_id,document_type,file_name,storage_path,mime_type,size_bytes,sha256)
  select '${JT}',id,active_version_id,'generated_pdf','expire.pdf','${JT}/'||id::text||'/expire.pdf','application/pdf',4096,'expire-canonical-sha'
  from public.contracts where id=$1 returning id`, [expiringContractId]);
const expiringDocumentId = String(expiringDocument.rows[0].id);
await db.query(`select public.prepare_contract_delivery_v2(
  $1,'email','Utgången Kund AB','utgangen@example.test',null,'expire-token-hash','expire-token-cipher','ABCD',
  now()+interval '7 days',$2,null,null,'avtal@example.test','Ditt avtal','text','<p>html</p>','[]'::jsonb,null,null)`,
  [expiringContractId, expiringDocumentId]);

// The deadline passes and the scheduled sweep runs.
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.query(`update public.contract_acceptance_requests set expires_at=now()-interval '1 minute' where contract_id=$1 and status='pending'`, [expiringContractId]);
await db.query(`select public.enqueue_due_contract_reminders(100)`);
const expiredState = await db.query(`
  select c.status,
    (select count(*)::int from public.contract_acceptance_requests r where r.contract_id=c.id and r.status='expired') expired_requests,
    (select count(*)::int from public.contract_reminders cr where cr.contract_id=c.id and cr.status='scheduled') open_reminders
  from public.contracts c where c.id=$1`, [expiringContractId]);
if (expiredState.rows[0].status !== 'expired' || Number(expiredState.rows[0].expired_requests) !== 1) {
  throw new Error(`An overdue acceptance link did not expire the contract: ${JSON.stringify(expiredState.rows[0])}`);
}
if (Number(expiredState.rows[0].open_reminders) !== 0) {
  throw new Error(`Reminders kept running for an expired request: ${JSON.stringify(expiredState.rows[0])}`);
}

// The seller sends the same contract again. The version, the canonical PDF and the source
// call are all still valid, so this must not require drafting a new contract.
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false); select set_config('request.jwt.claim.sub','${JOWNER}',false);`);
let resendResult;
try {
  resendResult = await db.query(`select public.prepare_contract_delivery_v2(
    $1,'email','Utgången Kund AB','utgangen@example.test',null,'expire-token-hash-2','expire-token-cipher-2','EFGH',
    now()+interval '7 days',$2,null,null,'avtal@example.test','Ditt avtal igen','text','<p>html</p>','[]'::jsonb,null,null) as result`,
    [expiringContractId, expiringDocumentId]);
} catch (error) {
  throw new Error(`An expired contract could not be sent again, so the seller has to redraft it: ${error instanceof Error ? error.message : String(error)}`);
}
const resent = await db.query(`
  select c.status,c.acceptance_generation,
    (select count(*)::int from public.contract_acceptance_requests r where r.contract_id=c.id and r.status='pending' and r.generation=c.acceptance_generation) pending_current,
    (select count(*)::int from public.contract_acceptance_requests r where r.contract_id=c.id and r.status='expired') expired_kept
  from public.contracts c where c.id=$1`, [expiringContractId]);
const resentState = resent.rows[0];
if (resentState.status !== 'sent' || Number(resentState.pending_current) !== 1) {
  throw new Error(`Sending an expired contract again did not reopen it: ${JSON.stringify(resentState)}`);
}
if (Number(resentState.expired_kept) !== 1) {
  throw new Error(`The expired attempt was erased instead of kept in the audit trail: ${JSON.stringify(resentState)}`);
}

// And the sweep must not drag the freshly sent contract back to expired just because an
// earlier attempt on it expired.
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.query(`select public.enqueue_due_contract_reminders(100)`);
const afterSweep = await db.query(`select status from public.contracts where id=$1`, [expiringContractId]);
if (afterSweep.rows[0].status !== 'sent') {
  throw new Error(`The expiry sweep expired a contract that has a live acceptance link: ${JSON.stringify(afterSweep.rows[0])}`);
}

// The new link accepts, the superseded one does not.
const currentRequest = await db.query(`select id from public.contract_acceptance_requests where contract_id=$1 and status='pending'`, [expiringContractId]);
await db.query(`select public.record_contract_acceptance_v3($1,'web','accepted_via_web','WEB_ACCEPT','WEB_ACCEPT','Utgången Testsson',null,'127.0.0.1','probe',null,'Jag accepterar','{}'::jsonb)`,
  [String(currentRequest.rows[0].id)]);
const acceptedAfterResend = await db.query(`select status from public.contracts where id=$1`, [expiringContractId]);
if (acceptedAfterResend.rows[0].status !== 'accepted') {
  throw new Error(`A contract sent again after expiry could not be accepted: ${JSON.stringify(acceptedAfterResend.rows[0])}`);
}
let expiredLinkRefused = false;
const staleRequest = await db.query(`select id from public.contract_acceptance_requests where contract_id=$1 and status='expired' limit 1`, [expiringContractId]);
try {
  await db.query(`select public.record_contract_acceptance_v3($1,'web','accepted_via_web','WEB_ACCEPT','WEB_ACCEPT','Sen Testsson',null,'127.0.0.1','probe',null,'Jag accepterar','{}'::jsonb)`,
    [String(staleRequest.rows[0].id)]);
} catch (error) {
  expiredLinkRefused = /not_pending|expired|superseded|generation/.test(error instanceof Error ? error.message : String(error));
}
if (!expiredLinkRefused) {
  throw new Error("An expired acceptance link still accepted a decision.");
}
console.log("Executed contract expiry and resend: the overdue link expires the contract and cancels its reminders, the same contract can be sent again as a new generation, the sweep leaves the live link alone, and the expired link no longer accepts.");

// The second signing channel. A contract sent by SMS requires the code from the message, so
// a reply that quotes the wrong code must not sign anything.
const JSMS = '00000000-0000-0000-0000-0000000000c9';
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.exec(`
  insert into public.customers(id,tenant_id,customer_type,lifecycle,display_name,phone_e164,email,marketing_allowed,legal_basis,created_by)
  values('${JSMS}','${JT}','company','prospect','SMS Kund AB','+46705550010','sms@example.test',true,'legitimate_interest','${JOWNER}')
  on conflict(id) do nothing;
  insert into public.tenant_features(tenant_id,feature_key,enabled) values
    ('${JT}','outbound_sms',true),('${JT}','contract_delivery_sms',true)
  on conflict(tenant_id,feature_key) do update set enabled=true;
`);
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false); select set_config('request.jwt.claim.sub','${JOWNER}',false);`);
const smsCall = await db.query(`select public.register_external_manual_call(
  '${JSMS}','+46705550010','outbound',now()-interval '20 minutes',now()-interval '10 minutes',
  'interested','SMS-samtal',null) as id`);
const smsContract = await db.query(`select public.create_contract_draft_v3(
  'KX-JOURNEY-SMS','${JSMS}',null,null,'00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-0000000000c4',
  '00000000-0000-0000-0000-0000000000c2','SMS-avtal','Brödtext','Villkor','{"currency":"SEK"}'::jsonb,'sms-doc-hash',
  'telephone','{"legal_name":"Kundexa Journey AB"}'::jsonb,'{"display_name":"SMS Kund AB"}'::jsonb,
  '${JOWNER}',null,null,null,null,null,1000,'SEK',now()+interval '7 days') as id`);
const smsContractId = String(smsContract.rows[0].id);
await db.query(`update public.contracts set source_call_id=$1,source_type='external_manual_call',prepared_at=now(),status='ready' where id=$2`, [String(smsCall.rows[0].id), smsContractId]);
const smsDocument = await db.query(`
  insert into public.contract_documents(tenant_id,contract_id,contract_version_id,document_type,file_name,storage_path,mime_type,size_bytes,sha256)
  select '${JT}',id,active_version_id,'generated_pdf','sms.pdf','${JT}/'||id::text||'/sms.pdf','application/pdf',4096,'sms-canonical-sha'
  from public.contracts where id=$1 returning id`, [smsContractId]);
await db.query(`select public.prepare_contract_delivery_v2(
  $1,'sms','SMS Kund AB',null,'+46705550010','sms-token-hash','sms-token-cipher','K7T2',
  now()+interval '7 days',$2,'+46401234567','Avtal K7T2',null,null,null,null,'[]'::jsonb,null,null)`,
  [smsContractId, String(smsDocument.rows[0].id)]);
const smsRequest = await db.query(`select id,require_code,method from public.contract_acceptance_requests where contract_id=$1 and status='pending'`, [smsContractId]);
if (smsRequest.rows[0].require_code !== true || smsRequest.rows[0].method !== 'sms') {
  throw new Error(`An SMS delivery did not demand the code from the message: ${JSON.stringify(smsRequest.rows[0])}`);
}
const smsRequestId = String(smsRequest.rows[0].id);

await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
let wrongCodeRefused = false;
try {
  await db.query(`select public.record_contract_acceptance_v3($1,'sms','accepted_via_sms','JA X999','JA X999','JA','X999',null,null,'provider-1','SMS-acceptans','{}'::jsonb)`, [smsRequestId]);
} catch (error) {
  wrongCodeRefused = /acceptance_code_invalid/.test(error instanceof Error ? error.message : String(error));
}
if (!wrongCodeRefused) throw new Error("An SMS reply quoting the wrong code signed the contract.");

let missingCodeRefused = false;
try {
  await db.query(`select public.record_contract_acceptance_v3($1,'sms','accepted_via_sms','JA','JA','JA',null,null,null,'provider-2','SMS-acceptans','{}'::jsonb)`, [smsRequestId]);
} catch (error) {
  missingCodeRefused = /acceptance_code_required/.test(error instanceof Error ? error.message : String(error));
}
if (!missingCodeRefused) throw new Error("An SMS reply without the code signed the contract.");

const smsAcceptance = await db.query(`select public.record_contract_acceptance_v3($1,'sms','accepted_via_sms','JA K7T2','JA K7T2','JA','k7t2',null,null,'provider-3','SMS-acceptans','{}'::jsonb) as id`, [smsRequestId]);
const smsAccepted = await db.query(`
  select c.status,
    (select a.acceptance_code from public.contract_acceptances a where a.id=$2) stored_code,
    (select a.method::text from public.contract_acceptances a where a.id=$2) method,
    (select (a.evidence->>'acceptance_code_verified')::boolean from public.contract_acceptances a where a.id=$2) code_verified
  from public.contracts c where c.id=$1`, [smsContractId, String(smsAcceptance.rows[0].id)]);
const smsState = smsAccepted.rows[0];
if (smsState.status !== 'accepted' || smsState.method !== 'sms' || smsState.code_verified !== true) {
  throw new Error(`An SMS acceptance with the right code did not sign the contract: ${JSON.stringify(smsState)}`);
}
if (smsState.stored_code !== '[verified]') {
  throw new Error(`The acceptance code was stored verbatim instead of as a verification marker: ${JSON.stringify(smsState)}`);
}
console.log("Executed SMS signing: the code from the message is required, a wrong or missing code is refused, a lower-case reply of the right code signs, and the code itself is never stored.");

// Och uppringningen själv, hela vägen: reservera, rapportera att leverantören
// tog emot anropet, avsluta samtalet med efterarbete. Reservationen bär hela
// behörighets- och efterlevnadskedjan, så den prövas i drift och inte bara i
// källkoden.
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.exec(`
  update public.telephony_policies
  set default_caller_id_phone_number_id='00000000-0000-0000-0000-000000000022'
  where tenant_id='00000000-0000-0000-0000-000000000001';
  update public.customers set alternate_phone_e164='+46702222231'
  where id='00000000-0000-0000-0000-000000000025';
`);
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false); select set_config('request.jwt.claim.sub','${JOWNER}',false);`);

const neutralReserved = (await db.query(`
  select public.reserve_outbound_call(
    '00000000-0000-0000-0000-000000000025',null,'+46702222231',null,null,null,
    gen_random_uuid(),'neutral-dial-1','customer_service'
  ) as result
`)).rows[0].result;
if (neutralReserved.idempotentReplay !== false || neutralReserved.status !== 'requested') {
  throw new Error(`The neutral reservation did not open a call: ${JSON.stringify(neutralReserved)}`);
}
if (neutralReserved.callerId !== '+46401234567' || neutralReserved.callerIdSource !== 'tenant_default') {
  throw new Error(`The neutral reservation resolved the wrong caller ID: ${JSON.stringify(neutralReserved)}`);
}

const neutralRow = await db.query(`
  select c.provider, c.from_number, c.status as call_status,
         a.provider as attempt_provider, a.status as attempt_status, a.caller_id_source
  from public.calls c join public.dial_attempts a on a.call_id=c.id
  where c.id=$1
`, [neutralReserved.callId]);
if (neutralRow.rows.length !== 1) throw new Error("The neutral reservation did not write a dial attempt.");
if (neutralRow.rows[0].provider !== 'sinch' || neutralRow.rows[0].attempt_provider !== 'sinch') {
  throw new Error(`The neutral reservation did not record the provider: ${JSON.stringify(neutralRow.rows[0])}`);
}
if (neutralRow.rows[0].from_number !== '+46401234567') {
  throw new Error("The call was not stamped with the resolved caller ID.");
}

// Replaying the same idempotency key returns the same call rather than opening a
// second one, and the seat refuses a genuinely new call while one is open.
const replayed = (await db.query(`
  select public.reserve_outbound_call(
    '00000000-0000-0000-0000-000000000025',null,'+46702222231',null,null,null,
    $1,'neutral-dial-1','customer_service'
  ) as result
`, [neutralReserved.clientRequestId ?? '00000000-0000-0000-0000-0000000000aa'])).rows[0].result;
if (replayed.idempotentReplay !== true || replayed.callId !== neutralReserved.callId) {
  throw new Error(`Replaying the idempotency key opened a second call: ${JSON.stringify(replayed)}`);
}

let seatRefused = false;
try {
  await db.query(`
    select public.reserve_outbound_call(
      '00000000-0000-0000-0000-000000000025',null,'+46702222231',null,null,null,
      gen_random_uuid(),'neutral-dial-2','customer_service'
    )
  `);
} catch (error) {
  seatRefused = String(error).includes("active_call_already_exists");
}
if (!seatRefused) throw new Error("A second call was reserved while the seller already held the seat.");

// Finalising an unknown provider outcome must not close the attempt as failed:
// the call may well be ringing, and releasing the seat would let the seller dial
// over a live call.
const unknownFinalised = (await db.query(
  `select public.finalize_dial($1,$2,'unknown',null,null,null) as result`,
  [neutralReserved.callId, neutralReserved.attemptId],
)).rows[0].result;
if (unknownFinalised.attemptStatus !== 'provider_outcome_unknown') {
  throw new Error(`An unknown provider outcome was not kept open: ${JSON.stringify(unknownFinalised)}`);
}
const stillHeld = await db.query(
  `select public.dial_attempt_holds_seat(status) as held from public.dial_attempts where id=$1`,
  [neutralReserved.attemptId]);
if (stillHeld.rows[0].held !== true) {
  throw new Error("An unknown provider outcome released the seat while the call may still be live.");
}

await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.query(`update public.dial_attempts set status='completed' where id=$1`, [neutralReserved.attemptId]);

// Without a caller ID there is no call at all. Sinch answers a callout with no
// CLI with a call id and never reaches the destination, so a missing number has
// to stop the reservation rather than surface later as a call nobody answered.
await db.exec(`
  update public.telephony_policies set default_caller_id_phone_number_id=null
  where tenant_id='00000000-0000-0000-0000-000000000001'`);
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false); select set_config('request.jwt.claim.sub','${JOWNER}',false);`);
const callsBeforeNoCallerId = await db.query(`select count(*)::int as n from public.calls`);
let callerIdRefused = false;
try {
  await db.query(`
    select public.reserve_outbound_call(
      '00000000-0000-0000-0000-000000000025',null,'+46702222231',null,null,null,
      gen_random_uuid(),'neutral-dial-no-cli','customer_service'
    )
  `);
} catch (error) {
  callerIdRefused = String(error).includes("CALLER_ID_MISSING");
}
if (!callerIdRefused) throw new Error("A call was reserved with no caller ID to present.");
const callsAfterNoCallerId = await db.query(`select count(*)::int as n from public.calls`);
if (callsAfterNoCallerId.rows[0].n !== callsBeforeNoCallerId.rows[0].n) {
  throw new Error("A reservation refused for a missing caller ID still created a call row.");
}

await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.exec(`
  update public.telephony_policies
  set default_caller_id_phone_number_id='00000000-0000-0000-0000-000000000022'
  where tenant_id='00000000-0000-0000-0000-000000000001'`);
console.log("Executed the provider-neutral dial: caller ID resolved from the tenant default, the call and attempt stamped with the provider, the idempotency key replayed instead of doubled, the seat held against a second call, an unknown provider outcome kept open, and a missing caller ID refused before any row was written.");
// "Ring inte igen" must actually block the customer.
//
// The /app/calls after-call form used to write the disposition straight onto the
// call row. Nothing else happened: there is no trigger on `calls` that applies a
// block, so a customer who asked not to be called again was recorded as such and
// stayed fully callable. Only `complete_manual_call_work` reaches
// `apply_call_block_disposition`, so the page now goes through the same RPC the
// dialer does. This pins that consequence.
const BLOCKCUSTOMER = '00000000-0000-0000-0000-0000000000d1';
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.exec(`
  insert into public.customers(id,tenant_id,customer_type,lifecycle,display_name,phone_e164,marketing_allowed,legal_basis,created_by)
  values('${BLOCKCUSTOMER}','${JT}','company','prospect','Spärrkund AB','+46705550077',true,'legitimate_interest','${JOWNER}')
  on conflict(id) do nothing;
`);
// The journey dial above left its attempt in a seat-holding status, which is
// exactly the state that blocks the seller's next call. Close it first — this
// block is about the disposition, not about the seat lock.
await db.query(`update public.dial_attempts set status='completed' where call_id=$1`, [neutralReserved.callId]);
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false); select set_config('request.jwt.claim.sub','${JOWNER}',false);`);
const blockDial = await db.query(`select public.reserve_outbound_call(
  '${BLOCKCUSTOMER}',null,'+46705550077',null,null,null,gen_random_uuid(),'journey-block-1','direct_marketing',null,null) as result`);
const blockCall = blockDial.rows[0].result;
// Utfallet skrivs av den inloggade säljaren, inte av en tjänsteroll: det är
// webbläsaren som rapporterar vad leverantörens klient svarade.
await db.query(`select public.finalize_dial($1,$2,'accepted',null,null,null)`, [blockCall.callId, blockCall.attemptId]);
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.query(`update public.calls set status='completed',answered_at=now()-interval '1 minute',ended_at=now(),duration_seconds=60 where id=$1`, [blockCall.callId]);
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false); select set_config('request.jwt.claim.sub','${JOWNER}',false);`);

const beforeBlock = await db.query(`select do_not_call from public.customers where id=$1`, [BLOCKCUSTOMER]);
if (beforeBlock.rows[0].do_not_call !== false) {
  throw new Error("The block fixture started out blocked, so the assertion below would prove nothing.");
}
// The old behaviour, reproduced exactly: write the disposition onto the call row
// and nothing else. The customer must still be callable afterwards — that is the
// defect, and it is what makes the RPC necessary rather than merely tidier.
await db.query(`update public.calls set disposition='do_not_call' where id=$1`, [blockCall.callId]);
const afterDirectWrite = await db.query(`
  select c.do_not_call,
    (select count(*)::int from public.compliance_blocks b where b.customer_id=c.id and b.active) blocks
  from public.customers c where c.id=$1`, [BLOCKCUSTOMER]);
if (afterDirectWrite.rows[0].do_not_call !== false || Number(afterDirectWrite.rows[0].blocks) !== 0) {
  throw new Error(`Writing the disposition directly now blocks the customer; this test no longer describes the defect: ${JSON.stringify(afterDirectWrite.rows[0])}`);
}
await db.query(`update public.calls set disposition=null where id=$1`, [blockCall.callId]);

await db.query(`select public.complete_manual_call_work_v2($1::uuid,'do_not_call','Kunden bad att inte bli uppringd igen',null,null) as result`, [blockCall.callId]);
const afterBlock = await db.query(`
  select c.do_not_call, c.blocked_reason,
    (select count(*)::int from public.compliance_blocks b
      where b.customer_id=c.id and b.active and 'call'=any(b.channels)) blocks
  from public.customers c where c.id=$1`, [BLOCKCUSTOMER]);
if (afterBlock.rows[0].do_not_call !== true || Number(afterBlock.rows[0].blocks) < 1) {
  throw new Error(`The canonical after-call path did not block the customer: ${JSON.stringify(afterBlock.rows[0])}`);
}
// And the block has to bite: the next reservation for the same customer is refused.
let blockedCustomerRefused = false;
try {
  await db.query(`select public.reserve_outbound_call(
    '${BLOCKCUSTOMER}',null,'+46705550077',null,null,null,gen_random_uuid(),'journey-block-2','direct_marketing',null,null)`);
} catch (error) {
  blockedCustomerRefused = /CUSTOMER_DO_NOT_CALL|CUSTOMER_CHANNEL_BLOCK|COMPLIANCE_BLOCK|exact_call_policy_denied/i
    .test(error instanceof Error ? error.message : String(error));
}
if (!blockedCustomerRefused) {
  throw new Error("A customer blocked by the after-call disposition could still be dialled.");
}
// The disposition set is the function's, not the screen's: an option the page
// once offered ("contract") is refused rather than silently accepted.
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.query(`update public.calls set disposition=null,after_call_completed_at=null where id=$1`, [blockCall.callId]);
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false); select set_config('request.jwt.claim.sub','${JOWNER}',false);`);
let invalidDispositionRefused = false;
try {
  await db.query(`select public.complete_manual_call_work_v2($1::uuid,'contract',null,null,null)`, [blockCall.callId]);
} catch (error) {
  invalidDispositionRefused = /manual_disposition_invalid/.test(error instanceof Error ? error.message : String(error));
}
if (!invalidDispositionRefused) {
  throw new Error("The after-call path accepted a disposition the canonical set does not contain.");
}
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
console.log("Executed the manual after-call path: writing the disposition directly leaves the customer callable, the canonical RPC blocks the customer and files a compliance block, the next dial to them is refused, and a disposition outside the canonical set is refused.");


// The automatic dialer works the list on its own until someone answers: an unanswered call
// records its outcome, releases the prospect with a retry in the future, and the next claim
// hands the seller a different prospect. The client loop depends on all three.
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.exec(`
  insert into public.customers(id,tenant_id,customer_type,lifecycle,display_name,phone_e164,marketing_allowed,legal_basis,created_by)
  values
    ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-000000000001','company','prospect','Auto Loop Ett','+46707770001',true,'legitimate_interest','00000000-0000-0000-0000-000000000002'),
    ('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-000000000001','company','prospect','Auto Loop Två','+46707770002',true,'legitimate_interest','00000000-0000-0000-0000-000000000002')
  on conflict(id) do nothing;
`);
// Callbacks outrank list order in the claim, and earlier sections leave due ones behind.
// Close them so this section measures the plain list loop and nothing else.
await db.query(`update public.activities set status='completed',claimed_by=null,claim_expires_at=null
  where tenant_id='00000000-0000-0000-0000-000000000001' and type='callback' and status in ('open','in_progress')`);
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false); select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);`);
await db.query(`select public.add_customers_to_list($1,array['00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2']::uuid[])`, [runtimeListId]);
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000020',false)`);

const autoSession = await db.query(`select public.start_dialer_session($1) as id`, [runtimeListId]);
const autoSessionId = String(autoSession.rows[0].id);
const firstAuto = await db.query(`select public.claim_next_list_member_with_contacts($1,$2) as claim`, [runtimeListId, autoSessionId]);
const firstAutoClaim = firstAuto.rows[0].claim;
if (firstAutoClaim.empty || !firstAutoClaim.memberId) {
  throw new Error(`The automatic dialer could not claim a prospect: ${JSON.stringify(firstAutoClaim)}`);
}
const firstAutoCall = await db.query(
  `select public.queue_list_outbound_call_target($1,$2,null,null,$3,'auto-loop-hash-1','auto-loop-token-1','+46703333333','auto-loop-call-1','direct_marketing') as id`,
  [autoSessionId, firstAutoClaim.memberId, firstAutoClaim.defaultTarget?.phone ?? firstAutoClaim.customer.phone],
);
const firstAutoCallId = String(firstAutoCall.rows[0].id);

// Nobody picked up. This is the status the provider projection writes for UNANSWERED, and the
// dialer records it without asking the seller.
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.query(`update public.calls set provider='sinch',status='unanswered',ended_at=now() where id=$1`, [firstAutoCallId]);
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false)`);
await db.query(`select public.complete_dialer_work_v2($1::uuid,'no_answer',null,null,null,false,null,null,null,'auto-loop-after-1')`, [firstAutoCallId]);

const releasedMember = await db.query(`
  select state,outcome,attempts,claimed_by,next_attempt_at,completed_at
  from public.customer_list_members where id=$1`, [firstAutoClaim.memberId]);
const releasedRow2 = releasedMember.rows[0];
if (releasedRow2.state !== 'retry' || releasedRow2.outcome !== 'no_answer' || releasedRow2.claimed_by !== null) {
  throw new Error(`An unanswered call did not release the prospect for a later attempt: ${JSON.stringify(releasedRow2)}`);
}
if (!releasedRow2.next_attempt_at || new Date(releasedRow2.next_attempt_at) <= new Date()) {
  throw new Error(`An unanswered prospect was left immediately re-callable, so the dialer would spin on it: ${JSON.stringify(releasedRow2)}`);
}
if (releasedRow2.completed_at !== null) {
  throw new Error(`An unanswered call closed the prospect as worked: ${JSON.stringify(releasedRow2)}`);
}
const preservedStatus = await db.query(`select status from public.calls where id=$1`, [firstAutoCallId]);
if (preservedStatus.rows[0].status !== 'unanswered') {
  throw new Error(`After-work rewrote the true provider status of the call: ${JSON.stringify(preservedStatus.rows[0])}`);
}

// The loop continues on the next prospect rather than the one nobody answered.
const secondAuto = await db.query(`select public.claim_next_list_member_with_contacts($1,$2) as claim`, [runtimeListId, autoSessionId]);
const secondAutoClaim = secondAuto.rows[0].claim;
if (secondAutoClaim.empty || secondAutoClaim.memberId === firstAutoClaim.memberId) {
  throw new Error(`The automatic dialer did not move on to the next prospect: ${JSON.stringify(secondAutoClaim)}`);
}

// An answered call is where it stops: the seller's outcome is what closes the prospect.
const secondAutoCall = await db.query(
  `select public.queue_list_outbound_call_target($1,$2,null,null,$3,'auto-loop-hash-2','auto-loop-token-2','+46703333333','auto-loop-call-2','direct_marketing') as id`,
  [autoSessionId, secondAutoClaim.memberId, secondAutoClaim.defaultTarget?.phone ?? secondAutoClaim.customer.phone],
);
const secondAutoCallId = String(secondAutoCall.rows[0].id);
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.query(`update public.calls set provider='sinch',status='completed',answered_at=now()-interval '1 minute',ended_at=now(),duration_seconds=60 where id=$1`, [secondAutoCallId]);
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false)`);
await db.query(`select public.complete_dialer_work_v2($1::uuid,'not_interested',null,null,null,false,null,null,null,'auto-loop-after-2')`, [secondAutoCallId]);
const answeredMember = await db.query(`select state,outcome,completed_at from public.customer_list_members where id=$1`, [secondAutoClaim.memberId]);
const answered = answeredMember.rows[0];
if (answered.state !== 'completed' || answered.outcome !== 'not_interested' || !answered.completed_at) {
  throw new Error(`A terminal outcome on an answered call did not close the prospect: ${JSON.stringify(answered)}`);
}

// Voicemail and a provider refusal are the other outcomes the provider reports and the seller must
// still be able to file. They were unreachable for the same reason `unanswered` was.
const otherTerminalOutcomes = [
  { status: 'voicemail', disposition: 'voicemail', note: null, phone: '+46707770003', suffix: 'vm' },
  { status: 'blocked', disposition: 'do_not_call', note: 'Kunden vill inte bli uppringd', phone: '+46707770004', suffix: 'blk' },
];
for (const outcome of otherTerminalOutcomes) {
  await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
  const probeCustomer = await db.query(`
    insert into public.customers(tenant_id,customer_type,lifecycle,display_name,phone_e164,marketing_allowed,legal_basis,created_by)
    values('00000000-0000-0000-0000-000000000001','company','prospect',$1,$2,true,'legitimate_interest','00000000-0000-0000-0000-000000000002')
    returning id`, [`Auto Loop ${outcome.suffix}`, outcome.phone]);
  await db.exec(`select set_config('request.jwt.claim.role','authenticated',false); select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);`);
  await db.query(`select public.add_customers_to_list($1,array[$2]::uuid[])`, [runtimeListId, String(probeCustomer.rows[0].id)]);
  await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000020',false)`);
  const probeClaim = (await db.query(`select public.claim_next_list_member_with_contacts($1,$2) as claim`, [runtimeListId, autoSessionId])).rows[0].claim;
  if (probeClaim.empty) throw new Error(`No prospect available to file a ${outcome.status} outcome on.`);
  const probeCall = await db.query(
    `select public.queue_list_outbound_call_target($1,$2,null,null,$3,$4,$5,'+46703333333',$6,'direct_marketing') as id`,
    [autoSessionId, probeClaim.memberId, probeClaim.defaultTarget?.phone ?? probeClaim.customer.phone,
     `auto-loop-hash-${outcome.suffix}`, `auto-loop-token-${outcome.suffix}`, `auto-loop-call-${outcome.suffix}`],
  );
  const probeCallId = String(probeCall.rows[0].id);
  await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
  await db.query(`update public.calls set provider='sinch',status=$2,ended_at=now() where id=$1`, [probeCallId, outcome.status]);
  await db.exec(`select set_config('request.jwt.claim.role','authenticated',false)`);
  try {
    await db.query(`select public.complete_dialer_work_v2($1::uuid,$2,$3,null,null,false,null,null,null,$4)`,
      [probeCallId, outcome.disposition, outcome.note, `auto-loop-after-${outcome.suffix}`]);
  } catch (error) {
    throw new Error(`A ${outcome.status} call could not be given the outcome "${outcome.disposition}": ${error instanceof Error ? error.message : String(error)}`);
  }
  const probeState = await db.query(`
    select m.outcome, c.status from public.customer_list_members m join public.calls c on c.id=$2 where m.id=$1`,
    [probeClaim.memberId, probeCallId]);
  if (probeState.rows[0].outcome !== outcome.disposition || probeState.rows[0].status !== outcome.status) {
    throw new Error(`Filing a ${outcome.status} outcome did not project cleanly: ${JSON.stringify(probeState.rows[0])}`);
  }
}

// Every outcome the automatic dialer records without asking must exist on the list and need
// no extra input, or the client cannot record it and has to stop for the seller.
const unattendedDispositions = await db.query(`
  select key,requires_note,requires_callback,requires_order,terminal,retry_after_minutes
  from public.list_dispositions
  where list_id=$1 and key in ('no_answer','busy','voicemail') and active
  order by key`, [runtimeListId]);
if (unattendedDispositions.rows.length !== 3) {
  throw new Error(`A list is missing the unattended outcomes the automatic dialer records: ${JSON.stringify(unattendedDispositions.rows.map((row) => row.key))}`);
}
for (const row of unattendedDispositions.rows) {
  if (row.requires_note || row.requires_callback || row.requires_order) {
    throw new Error(`Unattended outcome ${row.key} demands input the automatic dialer cannot supply.`);
  }
  if (row.terminal || !row.retry_after_minutes) {
    throw new Error(`Unattended outcome ${row.key} must schedule a retry instead of closing the prospect.`);
  }
}
await db.query(`select public.release_list_member_claim($1,'end')`, [autoSessionId]);
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
console.log("Executed the automatic dialer loop: an unanswered call records its outcome and schedules a retry, the next prospect is claimed automatically, and an answered call stops for the seller's outcome.");

// A dynamic list that stops refreshing used to leave only a number behind:
// {"completed": 8, "failed": 3}, with sqlerrm discarded inside the handler. The
// worker puts that count in its heartbeat, so a list that silently stopped being
// updated looked exactly like one that was never due — while sellers kept working
// it. Catching per list is right; throwing away the reason was not.
{
  await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
  const shape = (await db.query(`select public.refresh_due_dynamic_customer_lists(10) as result`)).rows[0].result;
  for (const key of ["completed", "failed", "failures"]) {
    if (!(key in shape)) throw new Error(`The refresh result is missing "${key}": ${JSON.stringify(shape)}`);
  }
  if (!Array.isArray(shape.failures)) throw new Error("failures must be an array the worker can log");
  // Whatever the fixture state, the count and the detail must agree rather than
  // one of them quietly saying something else.
  if (Number(shape.failed) !== shape.failures.length && shape.failures.length < 20) {
    throw new Error(`failed=${shape.failed} but ${shape.failures.length} reasons were returned`);
  }
  for (const failure of shape.failures) {
    if (!failure.list_id || !failure.error) {
      throw new Error(`A failure must name the list and the reason: ${JSON.stringify(failure)}`);
    }
  }
}
console.log("Executed the dynamic list refresh: the result names which list failed and why instead of returning a bare count, and the count agrees with the detail.");

// The queue filters a worked prospect out on its own — claim_next_list_member only
// looks at pending/retry/callback/skipped — so "inte intresserad" stops being
// offered. What was missing is the way back. These prove the re-queue brings the
// right entries back and refuses the ones that are legal blocks rather than
// sales outcomes.
{
  const owner = "00000000-0000-0000-0000-000000000002";
  const seller = "00000000-0000-0000-0000-000000000020";
  await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);

  // Three worked-through entries with different endings, plus one that asked not
  // to be called. Attempts are maxed so the reset is exercised too.
  const members = (await db.query(
    `select id, customer_id from public.customer_list_members where list_id=$1 order by id limit 4`,
    [runtimeListId],
  )).rows;
  if (members.length < 4) throw new Error(`The re-queue fixture needs four list members, found ${members.length}`);
  const endings = ["not_interested", "not_interested", "wrong_number", "do_not_call"];
  for (const [index, member] of members.entries()) {
    await db.query(
      `update public.customer_list_members
         set state=$2, outcome=$3, attempts=99, completed_at=now() - interval '1 day',
             compliance_status='allowed', claimed_by=null, claim_expires_at=null
       where id=$1`,
      [member.id, endings[index] === "do_not_call" ? "blocked" : "completed", endings[index]],
    );
  }

  await db.exec(`select set_config('request.jwt.claim.role','authenticated',false)`);

  // What a re-queue would bring back, before pressing anything. The blocked one
  // must not be offered.
  await db.exec(`select set_config('request.jwt.claim.sub','${owner}',false)`);
  const candidates = (await db.query(`select * from public.customer_list_requeue_candidates($1)`, [runtimeListId])).rows;
  const byOutcome = Object.fromEntries(candidates.map((row) => [row.outcome, Number(row.members)]));
  if (byOutcome.not_interested !== 2 || byOutcome.wrong_number !== 1) {
    throw new Error(`The re-queue preview miscounted: ${JSON.stringify(candidates)}`);
  }
  if ("do_not_call" in byOutcome) throw new Error("A do-not-call entry was offered for re-queueing");

  // A seller may not re-open a list the team leader closed.
  await db.exec(`select set_config('request.jwt.claim.sub','${seller}',false)`);
  try {
    await db.query(`select public.requeue_customer_list_members($1,null,0,null)`, [runtimeListId]);
    throw new Error("A seller was allowed to re-queue a list");
  } catch (error) {
    if (!String(error.message).includes("list_manage_permission_denied")) throw error;
  }

  await db.exec(`select set_config('request.jwt.claim.sub','${owner}',false)`);
  const requeued = Number((await db.query(
    `select public.requeue_customer_list_members($1,array['not_interested'],180,null) as n`, [runtimeListId],
  )).rows[0].n);
  if (requeued !== 2) throw new Error(`Re-queueing "inte intresserad" moved ${requeued} entries, expected 2`);

  // Scoped to the four rows this block set up, by id. Selecting on `outcome`
  // instead made the assertions depend on what earlier tests happened to leave in
  // the list — a member carrying the same outcome with a different
  // `compliance_status` is skipped by the re-queue and turned this into a test
  // that passed or failed depending on run order.
  const after = (await db.query(
    `select id, outcome, state, attempts, completed_at, next_attempt_at > now() + interval '170 minutes' as forsenad
       from public.customer_list_members where id = any($1::uuid[]) order by id`,
    [members.map((member) => member.id)],
  )).rows;
  for (const row of after) {
    if (row.outcome === "not_interested") {
      if (row.state !== "pending") throw new Error(`A re-queued entry is ${row.state}, expected pending`);
      // Without this the next disposition would close it again immediately.
      if (Number(row.attempts) !== 0) throw new Error(`A re-queued entry kept ${row.attempts} attempts`);
      if (row.completed_at !== null) throw new Error("A re-queued entry is still marked completed");
      if (!row.forsenad) throw new Error("The re-queue delay was not applied to next_attempt_at");
    }
    // Untouched: a different outcome was not asked for, and the block is not a sales outcome.
    if (row.outcome === "wrong_number" && row.state !== "completed") {
      throw new Error("Re-queueing one outcome moved another");
    }
    if (row.outcome === "do_not_call" && row.state !== "blocked") {
      throw new Error("A do-not-call entry was put back into the dialling queue");
    }
  }

  // Even asking for everything must leave the block alone.
  const wrongNumberId = members[2].id;
  const blockedId = members[3].id;
  const stateOf = async (id) => (await db.query(
    `select state from public.customer_list_members where id=$1`, [id],
  )).rows[0].state;
  if (await stateOf(wrongNumberId) !== "completed") throw new Error("The wrong_number fixture was disturbed before the blanket re-queue");
  await db.query(`select public.requeue_customer_list_members($1,null,0,null)`, [runtimeListId]);
  if (await stateOf(wrongNumberId) !== "pending") throw new Error("A blanket re-queue left a completed entry behind");
  if (await stateOf(blockedId) !== "blocked") throw new Error("A blanket re-queue released a do-not-call entry");

  await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
}
console.log("Executed re-queueing a worked list: the preview counts what would come back and hides the do-not-call entries, a seller may not re-open a list, re-queueing one outcome resets its state, attempt counter and completion while leaving other outcomes alone, the delay lands on next_attempt_at, and even a blanket re-queue leaves a compliance block untouched.");


// The customer card is its own entry point for a NIX report. A seller learns a
// number is listed in ways that are not a finished call, so the report must not
// depend on one — and it must land in exactly the same place as the dialer's
// report, or the two surfaces drift apart.
await db.exec(`
  select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
  update public.profiles set active_tenant_id='00000000-0000-0000-0000-000000000001'
    where id='00000000-0000-0000-0000-000000000002';
  insert into public.customers(
    id,tenant_id,customer_type,lifecycle,display_name,phone_e164,alternate_phone_e164,
    marketing_allowed,legal_basis,created_by
  ) values(
    '00000000-0000-0000-0000-000000000090','00000000-0000-0000-0000-000000000001','person','prospect',
    'Kortrapporterad NIX','+46700000190','+46700000191',null,'berättigat intresse',
    '00000000-0000-0000-0000-000000000002'
  );
`);

const cardReport = await db.query(
  `select public.report_customer_nix_listing('00000000-0000-0000-0000-000000000090','Kunden uppgav NIX i inkommande samtal') as result`,
);
if (cardReport.rows[0].result.status !== "reported") {
  throw new Error(`The customer card could not file a NIX report: ${JSON.stringify(cardReport.rows[0].result)}`);
}

// Both numbers on the card are blocked, the card is flagged, and the register
// carries a phone-keyed result — the same evidence the dialer produces.
const cardEvidence = await db.query(`select
  (select do_not_call from public.customers where id='00000000-0000-0000-0000-000000000090') as blocked,
  (select count(*)::int from public.compliance_blocks
    where customer_id='00000000-0000-0000-0000-000000000090' and source='seller_reported_nix' and active) as blocks,
  (select count(*)::int from public.nix_checks
    where phone_e164='+46700000190' and result='listed' and source='seller_reported') as nix_rows,
  (select evidence->>'surface' from public.nix_checks where phone_e164='+46700000190') as surface,
  (select count(*)::int from public.audit_logs where action='customer.nix_reported') as audited`);
const evidence = cardEvidence.rows[0];
if (evidence.blocked !== true || Number(evidence.blocks) !== 2 || Number(evidence.nix_rows) !== 1
  || evidence.surface !== "customer_card" || Number(evidence.audited) !== 1) {
  throw new Error(`A NIX report from the customer card left incomplete evidence: ${JSON.stringify(evidence)}`);
}

// Reporting the same card twice must not grow the register with duplicates.
const secondReport = await db.query(
  `select public.report_customer_nix_listing('00000000-0000-0000-0000-000000000090',null) as result`,
);
const afterSecond = await db.query(`select count(*)::int as nix_rows from public.nix_checks
  where phone_e164='+46700000190' and result='listed'`);
if (secondReport.rows[0].result.status !== "already_reported" || Number(afterSecond.rows[0].nix_rows) !== 1) {
  throw new Error(`A repeated report duplicated the screening result: ${JSON.stringify(secondReport.rows[0].result)}`);
}

// The point of a phone-keyed report: the number stays refused even in the relaxed
// mode the pre-screened source runs in, and even on a card created afterwards.
await setCompliance('{"nix_screening_mode":"pre_screened_source"}');
await db.exec(`
  insert into public.customers(
    id,tenant_id,customer_type,lifecycle,display_name,phone_e164,marketing_allowed,legal_basis,created_by
  ) values(
    '00000000-0000-0000-0000-000000000091','00000000-0000-0000-0000-000000000001','person','prospect',
    'Samma nummer senare','+46700000190',null,'berättigat intresse','00000000-0000-0000-0000-000000000002'
  );
`);
const laterCardAfterCardReport = await policyFor("00000000-0000-0000-0000-000000000091");
if (laterCardAfterCardReport.allowed !== false) {
  throw new Error(`A card-reported number was callable on a later card: ${JSON.stringify(laterCardAfterCardReport)}`);
}
await setCompliance('{"nix_screening_mode":"provider_check"}');

// A card with no number at all cannot be reported: there would be nothing to block.
await db.exec(`
  insert into public.customers(id,tenant_id,customer_type,lifecycle,display_name,created_by)
  values('00000000-0000-0000-0000-000000000092','00000000-0000-0000-0000-000000000001','person','prospect',
    'Utan nummer','00000000-0000-0000-0000-000000000002');
`);
let numberlessRefused = false;
try {
  await db.query(`select public.report_customer_nix_listing('00000000-0000-0000-0000-000000000092',null)`);
} catch (error) {
  numberlessRefused = String(error.message).includes("customer_has_no_phone_number");
}
if (!numberlessRefused) throw new Error("A customer card without a phone number accepted a NIX report");
console.log("Executed the customer-card NIX report: both numbers blocked with register evidence, a repeat is a no-op, the number stays refused on a later card, and a card without a number is refused.");

// A team leader authors contract templates; releasing one stays with an owner.
await db.exec(`
  insert into auth.users(id,email) values('00000000-0000-0000-0000-000000000093','lead@example.test');
  -- A trigger on auth.users already created the profile row. The membership has
  -- to exist before that profile may point at the tenant, because
  -- profiles_validate_active_tenant refuses an active tenant the user is not in.
  -- An operational role must belong to a team, so the leader joins the runtime
  -- sales team the earlier fixtures already created.
  insert into public.tenant_memberships(tenant_id,user_id,role,status,joined_at,primary_team_id)
    values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000093','team_lead','active',now(),
      '00000000-0000-0000-0000-000000000026');
  insert into public.team_members(tenant_id,team_id,user_id,role,is_primary)
    values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000026',
      '00000000-0000-0000-0000-000000000093','manager',true);
  update public.profiles set active_tenant_id='00000000-0000-0000-0000-000000000001'
    where id='00000000-0000-0000-0000-000000000093';
  insert into public.tenant_legal_entities(id,tenant_id,legal_name,organization_number,active,is_default)
    values('00000000-0000-0000-0000-000000000094','00000000-0000-0000-0000-000000000001','Kundexa Verify AB','5560000000',true,true)
  on conflict do nothing;
  select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000093',false);
`);
const legalEntity = await db.query(
  `select id from public.tenant_legal_entities where tenant_id='00000000-0000-0000-0000-000000000001' and active limit 1`,
);
const teamLeadVersion = await db.query(
  `select public.create_contract_template_version(
     null,'Teamledarens avtal','Abonnemang','B2C','Skapad av teamledare',$1,
     'Avtal för {{customer.display_name}}',
     'Kund: {{customer.display_name}}, org/pnr: {{customer.organization_number}}, adress: {{customer.address_line1}}, {{customer.postal_code}} {{customer.city}}. Säljare: {{seller.legal_name}}.',
     'Villkoren gäller från {{today}} och avtalet löper med {{price.binding_months}} månaders bindningstid.',
     '[]'::jsonb,'{}'::jsonb,'{}'::jsonb) as version_id`,
  [legalEntity.rows[0].id],
);
const versionId = teamLeadVersion.rows[0].version_id;
const draft = await db.query(`select status from public.contract_template_versions where id=$1`, [versionId]);
if (draft.rows[0].status !== "draft") {
  throw new Error(`A team leader's template version was not created as a draft: ${JSON.stringify(draft.rows[0])}`);
}

// The same team leader must not be able to release it.
let approvalRefused = false;
try {
  await db.query(`select public.approve_contract_template_version($1)`, [versionId]);
} catch (error) {
  approvalRefused = String(error.message).includes("contract_template_approval_permission_required");
}
if (!approvalRefused) throw new Error("A team leader was able to approve their own contract template");

// The owner releases it, and only then is it selectable for a new contract.
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);`);
await db.query(`select public.approve_contract_template_version($1)`, [versionId]);
const approved = await db.query(
  `select v.status, t.current_version_id = v.id as is_current
   from public.contract_template_versions v
   join public.contract_templates t on t.id=v.template_id
   where v.id=$1`,
  [versionId],
);
if (approved.rows[0].status !== "approved" || approved.rows[0].is_current !== true) {
  throw new Error(`The owner's approval did not release the template: ${JSON.stringify(approved.rows[0])}`);
}

// A seller still may not author one.
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000020',false);`);
let sellerRefused = false;
try {
  await db.query(
    `select public.create_contract_template_version(
       null,'Säljarens avtal','Abonnemang','B2C','',$1,'T','Kropp som är tillräckligt lång för validering','Villkor som är tillräckligt långa',
       '[]'::jsonb,'{}'::jsonb,'{}'::jsonb)`,
    [legalEntity.rows[0].id],
  );
} catch (error) {
  sellerRefused = String(error.message).includes("contract_template_permission_required");
}
if (!sellerRefused) throw new Error("A seller was able to author a contract template");
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);`);
// Creating a segment is narrower than managing one, and the directory page now
// only offers each action to the roles that can actually complete it. Pin both
// sets against the database, so the constants in permissions.ts cannot quietly
// stop being true.
// Supabase grants every public table to `authenticated` by default and lets RLS
// do the restricting; the harness only grants what a test needs, so mirror that
// here or the probe measures a missing grant instead of the policy.
await db.exec(`grant select, insert, update, delete on public.segments to authenticated;`);

const trySegmentInsert = async (userId, label) => {
  try {
    await db.exec(`
      do $segment$ begin
        perform set_config('request.jwt.claim.role','authenticated',true);
        perform set_config('request.jwt.claim.sub','${userId}',true);
        set local role authenticated;
        insert into public.segments(tenant_id,name,entity_type,segment_type,rule_definition,owner_user_id,active)
        values('00000000-0000-0000-0000-000000000001','Segment ${label}','organization','dynamic','{}'::jsonb,'${userId}',true);
        reset role;
      end $segment$;`);
    return "allowed";
  } catch (error) {
    return String(error.message);
  }
};

const ownerInsert = await trySegmentInsert("00000000-0000-0000-0000-000000000002", "owner");
if (ownerInsert !== "allowed") throw new Error(`An owner could not create a segment: ${ownerInsert}`);

const leadInsert = await trySegmentInsert("00000000-0000-0000-0000-000000000093", "lead");
if (!leadInsert.includes("row-level security")) {
  throw new Error(`A team leader was allowed to create a segment, so segmentCreateRoles is wrong: ${leadInsert}`);
}
const sellerInsert = await trySegmentInsert("00000000-0000-0000-0000-000000000020", "seller");
if (!sellerInsert.includes("row-level security")) {
  throw new Error(`A seller was allowed to create a segment: ${sellerInsert}`);
}

// Managing an existing one is wider, and the RPC is the authority.
const segmentId = (await db.query(
  `select id from public.segments where tenant_id='00000000-0000-0000-0000-000000000001' order by created_at desc limit 1`,
)).rows[0].id;
const tryRefresh = async (userId) => {
  await db.exec(`select set_config('request.jwt.claim.sub','${userId}',false)`);
  try {
    await db.query(`select public.refresh_segment_materialization($1,null)`, [segmentId]);
    return "allowed";
  } catch (error) {
    return String(error.message);
  }
};
const leadRefresh = await tryRefresh("00000000-0000-0000-0000-000000000093");
if (leadRefresh !== "allowed") throw new Error(`A team leader could not refresh a segment: ${leadRefresh}`);
const sellerRefresh = await tryRefresh("00000000-0000-0000-0000-000000000020");
if (!sellerRefresh.includes("segment_manage_permission_required")) {
  throw new Error(`A seller was allowed to refresh a segment: ${sellerRefresh}`);
}
await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false)`);
console.log("Executed segment authority: only a tenant admin may create one, a team leader may refresh but not create, and a seller may do neither.");

console.log("Executed contract template authorship: a team leader creates a draft, cannot release it, an owner approves it into the current version, and a seller is refused.");

// E-mail is on from the start; switching it off is the deliberate act. The
// subtlety is that three places seed the default and only the trigger's write
// survives, so a change to either of the other two would look right and do
// nothing. These pin the outcome rather than any one of the three.
{
  await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
  const newTenant = (await db.query(
    `insert into public.tenants(slug,name,legal_name,organization_number,status)
     values('epost-default','E-post Default AB','E-post Default AB','5561234567','active') returning id`,
  )).rows[0].id;

  const flagsFor = async (tenantId) => Object.fromEntries((await db.query(
    `select feature_key, enabled from public.tenant_features where tenant_id=$1
       and feature_key in ('outbound_email','contract_delivery_email','outbound_sms','contract_delivery_sms')`,
    [tenantId],
  )).rows.map((row) => [row.feature_key, row.enabled]));

  const seeded = await flagsFor(newTenant);
  if (seeded.outbound_email !== true || seeded.contract_delivery_email !== true) {
    throw new Error(`A new tenant did not get e-mail enabled: ${JSON.stringify(seeded)}`);
  }
  // Only e-mail moved. SMS costs money per message and was never asked for.
  if (seeded.outbound_sms !== false || seeded.contract_delivery_sms !== false) {
    throw new Error(`Enabling e-mail also enabled SMS: ${JSON.stringify(seeded)}`);
  }

  // The tenants that already existed are brought along by the backfill.
  const backfilled = await flagsFor("00000000-0000-0000-0000-000000000001");
  if (backfilled.outbound_email !== true || backfilled.contract_delivery_email !== true) {
    throw new Error(`An existing tenant was not backfilled: ${JSON.stringify(backfilled)}`);
  }

  // And switching it off has to stick — that is the whole point of a default.
  await db.query(
    `update public.tenant_features set enabled=false where tenant_id=$1 and feature_key='outbound_email'`,
    [newTenant],
  );
  const afterOptOut = await flagsFor(newTenant);
  if (afterOptOut.outbound_email !== false) throw new Error("Switching e-mail off did not hold");

  await db.query(`delete from public.tenants where id=$1`, [newTenant]);
}
console.log("Executed the e-mail default: a newly created tenant has outbound e-mail and contract delivery by e-mail on without SMS following along, the tenants that already existed are backfilled, and switching it off stays off.");

// An incoming row that belongs to a customer you already have does not get
// rejected — it silently updates that customer, and all you see afterwards is a
// count. These prove the report names the same collisions the import will act
// on, and names them before the import runs rather than after.
{
  const tenant = "00000000-0000-0000-0000-000000000001";
  const owner = "00000000-0000-0000-0000-000000000002";
  const runId = "00000000-0000-0000-0000-0000000000d1";
  await db.exec(`select set_config('request.jwt.claim.sub','${owner}',false)`);
  await db.exec(`
    insert into public.import_runs(id,tenant_id,name,source_type,status,uploaded_by,total_rows,simulation,scan_status,scan_provider,scan_sha256,scan_completed_at)
    values('${runId}','${tenant}','Ringlista','csv','preview_ready','${owner}',5,true,'clean','verify','sha-dup',now());
    insert into public.import_rows(tenant_id,import_run_id,row_number,raw_data,normalized_data,decision,row_status,errors) values
      ('${tenant}','${runId}',1,'{}','{"display_name":"Nytt Bolag AB","customer_type":"company","phone_e164":"+46701110001"}','ready','valid','[]'),
      ('${tenant}','${runId}',2,'{}','{"display_name":"Nytt Bolag AB igen","customer_type":"company","phone_e164":"+46701110001"}','ready','valid','[]'),
      ('${tenant}','${runId}',3,'{}','{"display_name":"Redan Kund AB","customer_type":"company","phone_e164":"+46709999999"}','ready','valid','[]'),
      ('${tenant}','${runId}',4,'{}','{"display_name":"Trasig rad","customer_type":"company","phone_e164":"+46701110001"}','error','invalid','[]'),
      ('${tenant}','${runId}',5,'{}','{"display_name":"Eget Orgnr AB","customer_type":"company","organization_number":"5566778899","phone_e164":"+46701110001"}','ready','valid','[]');
  `);

  const report = (await db.query(`select * from public.import_run_duplicate_report('${runId}')`)).rows;

  // Row 2 repeats row 1's number inside the same file.
  const withinFile = report.find((row) => Number(row.import_row_number) === 2);
  if (!withinFile || Number(withinFile.duplicate_of_row_number) !== 1 || withinFile.match_value !== "+46701110001") {
    throw new Error(`The within-file duplicate was not reported: ${JSON.stringify(report)}`);
  }
  if (withinFile.matched_customer_id) throw new Error("A within-file duplicate was wrongly attributed to an existing customer");

  // Row 3 repeats a number that is already a customer, from the earlier fixture.
  const existing = report.find((row) => Number(row.import_row_number) === 3);
  if (!existing || !existing.matched_customer_id || existing.matched_customer_name !== "Imported Runtime AB") {
    throw new Error(`The collision with an existing customer was not reported: ${JSON.stringify(report)}`);
  }
  if (existing.duplicate_of_row_number !== null) throw new Error("An existing-customer match was wrongly reported as a within-file duplicate");

  // Row 1 is the first occurrence and hits no customer, so it is not a duplicate.
  if (report.some((row) => Number(row.import_row_number) === 1)) {
    throw new Error(`The first occurrence of a number was reported as a duplicate: ${JSON.stringify(report)}`);
  }
  // Row 4 failed validation, so the import will never insert it and it cannot collide.
  if (report.some((row) => Number(row.import_row_number) === 4)) {
    throw new Error("A row that failed validation was reported as a duplicate");
  }
  // Row 5 carries the same phone as rows 1 and 2, but it also carries its own
  // organisation number — and the import consults phone only when the
  // organisation number is absent. Reporting it would claim a collision the
  // import will not make, which is exactly the mistake this report exists to
  // avoid making in the other direction.
  if (report.some((row) => Number(row.import_row_number) === 5)) {
    throw new Error(`A row with its own organisation number was reported as a phone duplicate: ${JSON.stringify(report)}`);
  }

  // The property that makes the report worth showing: it predicts the commit.
  // A collision does not reject the row — it updates the customer that already
  // exists. That is the fact the report has to convey, so it is the fact the
  // test pins.
  const committed = (await db.query(`select public.process_import_run('${runId}') as result`)).rows[0].result;
  if (Number(committed.updated) !== 2 || Number(committed.new) !== 2) {
    throw new Error(`The import did not act on the reported collisions: ${JSON.stringify(committed)}`);
  }
  const decisions = (await db.query(
    `select row_number, decision from public.import_rows where import_run_id='${runId}' order by row_number`,
  )).rows;
  const reported = new Set(report.map((row) => Number(row.import_row_number)));
  for (const row of decisions) {
    // `updated` and `unchanged` both mean the row landed on an existing customer.
    const hitExistingCustomer = ["updated", "unchanged"].includes(String(row.decision));
    if (hitExistingCustomer !== reported.has(Number(row.row_number))) {
      throw new Error(`The report and the import disagree about row ${row.row_number}: reported=${reported.has(Number(row.row_number))} decision=${row.decision}`);
    }
  }
}
console.log("Executed the import duplicate report: a number repeated inside the file names the earlier row, a number that is already a customer names that customer, a first occurrence and a failed row are not collisions, and every row the report names is exactly the row the import then lands on an existing customer.");

// Duplicate detection has always run during ingestion — two master entities that
// share an identity key become a pending candidate — but nothing read the queue
// and nothing could act on it. These prove the whole loop: detection produces a
// candidate, an admin resolves it, and the resolution can be undone.
{
  const owner = "00000000-0000-0000-0000-000000000002";
  const seller = "00000000-0000-0000-0000-000000000020";
  await db.exec(`select set_config('request.jwt.claim.sub','${owner}',false)`);

  // A second record for the same company name, with a different organisation
  // number and no phone. The resolver matches on organisation number, source id,
  // phone or email — none of which hit here, so it becomes its own entity — while
  // identity keys also cover name+postcode, which is what raises the candidate.
  // That is the ordinary duplicate: one company arriving twice from two sources,
  // once with the wrong number. A shared phone would not do: the resolver treats
  // that as the same company and unifies the two before detection ever sees them.
  await db.exec(`select * from public.schedule_due_ingestion_jobs(10)`);
  const secondRun = (await db.query(
    `select id from public.ingestion_runs where ingestion_job_id='00000000-0000-0000-0000-000000000007' and id<>$1 order by created_at desc limit 1`,
    [runId],
  )).rows[0];
  if (!secondRun) throw new Error("The duplicate fixture could not schedule a second ingestion run");
  const secondRunId = String(secondRun.id);
  await db.query(`select * from public.claim_ingestion_runs($1,1)`, ["verify-duplicate-worker"]);
  const secondRaw = await db.query(
    `select public.record_ingestion_raw_payload($1,'page:2','application/json',200,'verify-request-2','{}',now(),'verify-sha-2','ciphertext',null,'{}') as id`,
    [secondRunId],
  );
  const duplicateFacts = [
    { field_key: "canonical_name", field_value: "Kundexa Verify AB", value_hash: "d1", confidence: 0.9 },
    { field_key: "organization_number", field_value: "5567654321", value_hash: "d2", confidence: 1 },
    { field_key: "city", field_value: "Malmö", value_hash: "d3", confidence: 0.8 },
  ];
  const duplicateCanonical = {
    canonical_name: "Kundexa Verify AB", organization_number: "5567654321",
    city: "Malmö", country_code: "SE",
  };
  await db.query(
    `select public.complete_ingestion_record($1,$2,'verify-duplicate',$3::jsonb,$4::jsonb,null,now()) as result`,
    [secondRunId, String(secondRaw.rows[0].id), JSON.stringify(duplicateFacts), JSON.stringify(duplicateCanonical)],
  );
  await db.query(`select public.complete_ingestion_run($1,null,'{}')`, [secondRunId]);

  const candidate = (await db.query(
    `select id,left_entity_id,right_entity_id,match_method,confidence,status
       from public.duplicate_candidates where tenant_id='00000000-0000-0000-0000-000000000001'`,
  )).rows;
  if (candidate.length !== 1) {
    const diag = (await db.query(`select id,canonical_name,organization_number from public.master_entities order by created_at`)).rows;
    const keys = (await db.query(`select key_type,normalized_value,master_entity_id from public.identity_keys order by key_type`)).rows;
    throw new Error(`Duplicate detection produced ${candidate.length} candidates, expected 1. entities=${JSON.stringify(diag)} keys=${JSON.stringify(keys)}`);
  }
  if (candidate[0].match_method !== "name_postal" || Number(candidate[0].confidence) !== 0.8) {
    throw new Error(`Duplicate candidate has the wrong provenance: ${JSON.stringify(candidate[0])}`);
  }
  const target = String(candidate[0].left_entity_id);
  const source = String(candidate[0].right_entity_id);

  // From here the assertions are about who may act, so the session has to look
  // like a signed-in user. Both functions skip their admin check for
  // `service_role`, which is the ambient role in this harness — leaving it set
  // would make every refusal below pass for the wrong reason.
  await db.exec(`select set_config('request.jwt.claim.role','authenticated',false)`);

  // A seller must not be able to merge, even though the RPC is granted to
  // `authenticated` — the admin branch inside the function is the authority.
  await db.exec(`select set_config('request.jwt.claim.sub','${seller}',false)`);
  try {
    await db.query(`select public.merge_master_entities('00000000-0000-0000-0000-000000000001',$1,$2,'${seller}')`, [target, source]);
    throw new Error("A seller was allowed to merge two directory entities");
  } catch (error) {
    if (!String(error.message).includes("admin_required")) throw error;
  }

  await db.exec(`select set_config('request.jwt.claim.sub','${owner}',false)`);
  const decision = await db.query(
    `select public.merge_master_entities('00000000-0000-0000-0000-000000000001',$1,$2,'${owner}') as id`,
    [target, source],
  );
  const decisionId = String(decision.rows[0].id);

  const merged = (await db.query(`select merged_into_id from public.master_entities where id=$1`, [source])).rows[0];
  if (String(merged.merged_into_id) !== target) throw new Error("The merged entity does not point at the survivor");
  const resolvedCandidate = (await db.query(`select status from public.duplicate_candidates where id=$1`, [candidate[0].id])).rows[0];
  if (resolvedCandidate.status !== "merged") throw new Error(`The candidate was not closed by the merge: ${resolvedCandidate.status}`);
  const movedLinks = (await db.query(`select count(*)::int as n from public.entity_source_links where master_entity_id=$1`, [source])).rows[0];
  if (movedLinks.n !== 0) throw new Error("Source links were left on the merged entity");

  // The undo is the reason the merge button is safe to offer. It was granted to
  // service_role only, which made every merge irreversible from the application
  // even though the function's own body checks for a tenant admin.
  await db.exec(`select set_config('request.jwt.claim.sub','${seller}',false)`);
  try {
    await db.query(`select public.undo_master_entity_merge($1,'${seller}')`, [decisionId]);
    throw new Error("A seller was allowed to undo a merge");
  } catch (error) {
    if (!String(error.message).includes("admin_required")) throw error;
  }

  await db.exec(`select set_config('request.jwt.claim.sub','${owner}',false)`);
  await db.query(`select public.undo_master_entity_merge($1,'${owner}')`, [decisionId]);
  const restored = (await db.query(`select merged_into_id from public.master_entities where id=$1`, [source])).rows[0];
  if (restored.merged_into_id !== null) throw new Error("Undo did not restore the merged entity");
  const undone = (await db.query(`select decision,undone_by from public.merge_decisions where id=$1`, [decisionId])).rows[0];
  if (undone.decision !== "undone" || String(undone.undone_by) !== owner) {
    throw new Error(`Undo did not record who reversed it: ${JSON.stringify(undone)}`);
  }
  await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
}
console.log("Executed directory duplicate review: ingestion raises a name+postcode candidate, a seller may neither merge nor undo, an owner merges so the survivor keeps the links and the candidate closes, and the undo restores the entity and records who reversed it.");

// The seller's organisation number is printed on every contract. Nothing
// validated it, so production holds an eleven-digit and a nine-digit value where
// a Swedish organisationsnummer has ten. These prove the write path now refuses
// what would end up on a legally binding document, and that it agrees with the
// normalizer the customer import has always used.
{
  const owner = "00000000-0000-0000-0000-000000000002";
  await db.exec(`select set_config('request.jwt.claim.sub','${owner}',false)`);

  const saveEntity = async (organizationNumber, countryCode = "SE") => {
    try {
      const result = await db.query(
        `select public.upsert_tenant_legal_entity(null,$1,$2,null,null,null,$3,null,null,null,false) as id`,
        [`Testbolag ${organizationNumber}-${countryCode}`, organizationNumber, countryCode],
      );
      return { id: result.rows[0].id };
    } catch (error) {
      return { error: String(error.message) };
    }
  };

  // The exact values sitting in production today.
  for (const rejected of ["5594616-7149", "559333333"]) {
    const attempt = await saveEntity(rejected);
    if (!attempt.error?.includes("organization_number_invalid")) {
      throw new Error(`An invalid seller organisation number was accepted (${rejected}): ${attempt.error ?? "saved"}`);
    }
  }
  // A ten-digit number that fails Luhn is the subtler case: right shape, wrong number.
  const luhnFailure = await saveEntity("556461-6149");
  if (!luhnFailure.error?.includes("organization_number_invalid")) {
    throw new Error(`A seller organisation number failing the Luhn check was accepted: ${luhnFailure.error ?? "saved"}`);
  }

  // Every spelling of the same real number must land in one canonical form.
  for (const accepted of ["556123-4567", "5561234567", "SE556123456701", "165561234567"]) {
    const attempt = await saveEntity(accepted);
    if (attempt.error) throw new Error(`A valid seller organisation number was refused (${accepted}): ${attempt.error}`);
    const stored = (await db.query(
      `select organization_number from public.tenant_legal_entities where id=$1`, [attempt.id],
    )).rows[0].organization_number;
    if (stored !== "556123-4567") {
      throw new Error(`A valid seller organisation number was not normalised (${accepted} stored as ${stored})`);
    }
  }

  // An enskild firma signs with a personnummer, and refusing it would lock a
  // real Swedish business out of its own contracts.
  const soleTrader = await saveEntity("19121212-1212".slice(2));
  if (soleTrader.error) throw new Error(`A sole trader's personnummer was refused: ${soleTrader.error}`);

  // A foreign entity has a different national format; guessing at one would
  // refuse a legitimate company.
  const foreign = await saveEntity("NO 987 654 321 MVA", "NO");
  if (foreign.error) throw new Error(`A non-Swedish organisation number was refused: ${foreign.error}`);

  // The rows that already hold an invalid number must stay writable — a CHECK
  // constraint here would have made them impossible to correct.
  await db.exec(`
    insert into public.tenant_legal_entities(tenant_id,legal_name,organization_number,country_code,active,is_default)
    values('00000000-0000-0000-0000-000000000001','Historiskt bolag','5594616-7149','SE',true,false);`);
  await db.exec(`
    update public.tenant_legal_entities set active=true
    where tenant_id='00000000-0000-0000-0000-000000000001' and organization_number='5594616-7149';`);

  // And the admin screen must be able to mark them without seeing another tenant.
  const probe = await db.query(
    `select public.is_valid_organization_number('5594616-7149','SE') as bad,
            public.is_valid_organization_number('556123-4567','SE') as good,
            public.is_valid_organization_number('987654321','NO') as foreign_ok`);
  if (probe.rows[0].bad !== false || probe.rows[0].good !== true || probe.rows[0].foreign_ok !== true) {
    throw new Error(`is_valid_organization_number disagrees with the write path: ${JSON.stringify(probe.rows[0])}`);
  }
}
console.log("Executed seller organisation number validation: the two values production actually holds are refused, a Luhn failure is refused, every spelling of a real number normalises to one form, a sole trader and a foreign company are accepted, and an already-invalid row stays writable so it can be corrected.");

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

// Duplicate foreign keys are invisible in Postgres and fatal in PostgREST: asked
// to embed one table in another it finds two candidate relationships and refuses
// with PGRST201, which the pages then rendered as an empty table. Nine pairs
// existed in production and broke /app/calls, /app/sms, /app/email,
// /app/contracts and /app/documents without one error reaching the screen.
const duplicateForeignKeys = await db.query(`
  select from_table, to_table
  from (
    select c.conrelid::regclass::text as from_table,
           c.confrelid::regclass::text as to_table,
           regexp_replace(pg_get_constraintdef(c.oid), ' ON DELETE.*$', '') as cols
    from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace
    where c.contype = 'f' and n.nspname = 'public'
  ) fks
  group by from_table, to_table, cols
  having count(*) > 1
`);
if (duplicateForeignKeys.rows.length > 0) {
  throw new Error(`Duplicate foreign keys make PostgREST embeds ambiguous: ${
    duplicateForeignKeys.rows.map((row) => `${row.from_table}->${row.to_table}`).join(", ")}`);
}

// Every `profiles:<column>(...)` embed in the application needs a foreign key to
// public.profiles on the table it reads. Without one PostgREST answers PGRST200
// and the whole query fails -- when the query is parsed, not per row, so an empty
// table does not save it.
//
// This used to assert only tenant_memberships, which is how notes.created_by
// slipped through: it points at auth.users, public.profiles was never linked, and
// every customer card in production was unreachable with digest 1819667757 --
// taking "Ring ett nytt nummer" with it, since that lands on the same card.
//
// So assert the rule rather than the one case. Read the embeds out of the source
// and require the key for each.
const { readdirSync: listDir, readFileSync: readSource } = await import("node:fs");
const sourceRoot = new URL("../src/", import.meta.url).pathname;
const sourceFiles = [];
const walkSource = (dir) => {
  for (const entry of listDir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walkSource(`${dir}${entry.name}/`);
    else if (/\.tsx?$/.test(entry.name)) sourceFiles.push(`${dir}${entry.name}`);
  }
};
walkSource(sourceRoot);

const profileEmbeds = new Map();
for (const file of sourceFiles) {
  const source = readSource(file, "utf8");
  // .from("table") ... .select("... profiles:column(...) ...") on one statement.
  for (const match of source.matchAll(/\.from\(\s*["'`](\w+)["'`]\s*\)[\s\S]{0,400}?\.select\(\s*["'`]([^"'`]*)["'`]/g)) {
    const [, table, selection] = match;
    for (const embed of selection.matchAll(/profiles\s*[:!]\s*(\w+)\s*\(/g)) {
      profileEmbeds.set(`${table}.${embed[1]}`, { table, column: embed[1], file: file.slice(sourceRoot.length) });
    }
  }
}
if (profileEmbeds.size === 0) {
  throw new Error("No profiles embeds were found in the source, so this invariant is measuring nothing.");
}

const profileLinks = await db.query(`
  select c.conrelid::regclass::text as table_name,
         (select string_agg(a.attname, ',') from unnest(c.conkey) k
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k) as cols
  from pg_constraint c
  join pg_namespace n on n.oid = c.connamespace
  where n.nspname = 'public' and c.contype = 'f' and c.confrelid = 'public.profiles'::regclass
`);
const linked = new Set(profileLinks.rows.map((row) => `${row.table_name.replace(/^public\./, "")}.${row.cols}`));
const unresolvable = [...profileEmbeds.values()]
  .filter((embed) => !linked.has(`${embed.table}.${embed.column}`))
  .map((embed) => `${embed.table}.${embed.column} (${embed.file})`);
if (unresolvable.length > 0) {
  throw new Error(`PostgREST cannot embed profiles for: ${unresolvable.join(", ")} -- the query fails with PGRST200 and the whole page with it`);
}
console.log(`Schema relationships are unambiguous, and all ${profileEmbeds.size} profiles embeds resolve to a foreign key.`);


// Deleting a contract is narrow on purpose, and two separate things enforce it.
// `contracts_admin_delete` limits the status to draft or cancelled; six child
// tables then refuse the delete outright, because they are the record of what
// was sent and what the customer answered. A contract that produced any of them
// can never be deleted — not even after it is cancelled.
//
// The register computes `deletable` from exactly that, so the Radera button only
// appears where the database will actually go through with it. Writing this test
// is what caught the first version promising otherwise.
{
  await db.exec(`select set_config('request.jwt.claim.role','authenticated',false)`);
  await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false)`);

  const sentContract = '00000000-0000-0000-0000-000000000086';
  const sentDelete = await db.query(`
    with gone as (
      delete from public.contracts
      where id=$1 and status in ('draft','cancelled')
      returning id
    ) select count(*)::int as removed from gone`, [sentContract]);
  if (Number(sentDelete.rows[0].removed) !== 0) {
    throw new Error("A contract past draft was deletable; an answered agreement must not be destroyable.");
  }

  // Cancelling it does not make its history disappear, so it still cannot go.
  await db.query(`update public.contracts set status='cancelled' where id=$1`, [sentContract]);
  let cancelledStillBlocked = false;
  try {
    await db.query(`delete from public.contracts where id=$1`, [sentContract]);
  } catch (error) {
    cancelledStillBlocked = /foreign key|violates/i.test(String(error?.message ?? ""));
  }
  if (!cancelledStillBlocked) {
    throw new Error("A cancelled contract with an evidence package was deleted; the record of what happened was destroyed.");
  }

  // A draft that never produced anything is the one case that may be removed.
  await db.query(`
    insert into public.contracts(id,tenant_id,contract_number,customer_id,owner_user_id,audience,status,title)
    values('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-000000000001','VERIFY-DRAFT-DEL',
           '10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','B2B','draft','Raderbart utkast')`);
  const draftDelete = await db.query(`
    with gone as (
      delete from public.contracts where id='00000000-0000-0000-0000-0000000000d1' returning id
    ) select count(*)::int as removed from gone`);
  if (Number(draftDelete.rows[0].removed) !== 1) {
    throw new Error("An untouched draft could not be deleted, so nothing can ever be cleaned up.");
  }
  console.log("Only an untouched draft is deletable; anything that was sent or answered stays.");
}

// Avtalet hör till produkten: en produkt har ett aktivt avtal, avtalet används
// bara med sin produkt, och en annan tenants produkt går inte att koppla.
{
  const T = "00000000-0000-0000-0000-000000000001";
  const PRODUCT = "00000000-0000-0000-0000-000000000023";
  await db.exec(`
    insert into public.products(id,tenant_id,name,active)
      values('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-000000000051','Tenant B elavtal',true);
    insert into public.products(id,tenant_id,name,active)
      values('00000000-0000-0000-0000-0000000000e2','${T}','Annan produkt',true);
    select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000093',false);
  `);
  const entity = (await db.query(`select id from public.tenant_legal_entities where tenant_id=$1 and active limit 1`, [T])).rows[0].id;
  const author = (productId, templateId = null, name = "Elavtal rörligt") => db.query(
    `select public.create_product_contract_template_version(
       $1,$2,$3,'Elavtal','B2C','',$4,'{{contract.title}}',
       'Avtal för {{customer.display_name}}, e-post {{customer.email?}}.',
       'Villkoren gäller från {{today}} och är tillräckligt långa.',
       '[]'::jsonb,'{}'::jsonb,'{}'::jsonb) as version_id`,
    [productId, templateId, name, entity]);
  const refusal = async (fn) => { try { await fn(); return "allowed"; } catch (error) { return String(error.message); } };

  // En teamledare lägger avtalet i produkten, i samma transaktion.
  const linked = (await author(PRODUCT)).rows[0].version_id;
  const linkedTemplate = (await db.query(
    `select t.id,t.product_id from public.contract_templates t join public.contract_template_versions v on v.template_id=t.id where v.id=$1`,
    [linked])).rows[0];
  if (linkedTemplate.product_id !== PRODUCT) throw new Error(`The contract was not placed under its product: ${JSON.stringify(linkedTemplate)}`);

  // En ny version av samma avtal är tillåten; ett andra avtal på produkten är det inte.
  await author(PRODUCT, linkedTemplate.id);
  const second = await refusal(() => author(PRODUCT, null, "Elavtal rörligt 2"));
  if (!second.includes("product_already_has_contract")) throw new Error(`A product accepted a second active contract: ${second}`);

  // Negativt tvåtenanttest: tenant B:s produkt ser ut som en som inte finns.
  const foreign = await refusal(() => author("00000000-0000-0000-0000-0000000000e1", null, "Stulen koppling"));
  if (!foreign.includes("product_not_found")) throw new Error(`Another tenant's product could be given a contract: ${foreign}`);

  // Säljaren använder avtalet men skriver det inte.
  await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000020',false);`);
  const seller = await refusal(() => author("00000000-0000-0000-0000-0000000000e2", null, "Säljarens"));
  if (!seller.includes("contract_template_permission_required")) throw new Error(`A seller authored a product contract: ${seller}`);
  await db.exec(`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);`);

  // Databasen, inte formuläret, håller ihop produkt och avtal.
  const insertContract = (number, productId, templateId) => refusal(() => db.query(
    `insert into public.contracts(tenant_id,contract_number,customer_id,owner_user_id,audience,status,title,product_id,template_id)
     values($1,$2,'10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','B2C','draft','Prov',$3,$4)`,
    [T, number, productId, templateId]));
  const wrongProduct = await insertContract("VERIFY-PROD-1", "00000000-0000-0000-0000-0000000000e2", linkedTemplate.id);
  if (!wrongProduct.includes("contract_template_belongs_to_other_product")) throw new Error(`A product's contract was used with another product: ${wrongProduct}`);
  const noTemplate = await insertContract("VERIFY-PROD-2", PRODUCT, null);
  if (!noTemplate.includes("contract_product_requires_its_contract")) throw new Error(`A product with a contract was sold without it: ${noTemplate}`);
  const matching = await insertContract("VERIFY-PROD-3", PRODUCT, linkedTemplate.id);
  if (matching !== "allowed") throw new Error(`A product sold with its own contract was refused: ${matching}`);
  await db.query(`delete from public.contracts where contract_number='VERIFY-PROD-3'`);
  console.log("A product carries one contract; it is authored by the right roles, cannot reach another tenant's product, and the database refuses a mismatched product and contract.");
}

await db.close();
