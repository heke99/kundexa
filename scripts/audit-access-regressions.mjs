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
      'aal', coalesce(nullif(current_setting('request.jwt.claim.aal', true),''),'aal2'),
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
const nativeOnly = process.env.KUNDEXA_NATIVE_ONLY_MIGRATIONS === "1";
const migrations = (await readdir(migrationDir)).filter((name) => name.endsWith(".sql")
  && !(nativeOnly && name === "202610150004_docuseal_orchestration.sql")).sort();
const migrationVersions = migrations.map((name) => name.match(/^(\d+)_/)?.[1] ?? "");
if (migrationVersions.some((version) => !version)) throw new Error("Every migration filename must start with a numeric version");
if (new Set(migrationVersions).size !== migrationVersions.length) {
  throw new Error(`Duplicate migration version detected: ${migrationVersions.filter((version, index) => migrationVersions.indexOf(version) !== index).join(", ")}`);
}
for (const migration of migrations) {
  if (migration === '20261117010000_contract_readiness_boundary.sql') {
    // A real pre-upgrade fixture: approved instruction text without product,
    // created under the old schema. Never disable the new guard to fabricate it.
    await db.exec(`insert into auth.users(id,email) values('90000000-0000-4000-8000-000000000002','legacy-owner@example.test');
      insert into public.tenants(id,slug,name,legal_name) values('90000000-0000-4000-8000-000000000001','legacy-readiness','Legacy','Legacy');
      insert into public.tenant_memberships(tenant_id,user_id,role,status,joined_at) values('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000002','owner','active',now());
      update public.profiles set active_tenant_id='90000000-0000-4000-8000-000000000001' where id='90000000-0000-4000-8000-000000000002';
      insert into public.products(id,tenant_id,name) values('90000000-0000-4000-8000-000000000003','90000000-0000-4000-8000-000000000001','Legacy product');
      insert into public.product_price_versions(tenant_id,product_id,version) values('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000003',1);
      insert into public.contract_templates(id,tenant_id,name,contract_type,audience) values('90000000-0000-4000-8000-000000000004','90000000-0000-4000-8000-000000000001','Legacy unlinked','service','BOTH');
      insert into public.contract_template_versions(id,tenant_id,template_id,version,title_template,body_template,terms_template,status) values('90000000-0000-4000-8000-000000000005','90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000004',1,'Legacy','Body','Här ska slutvillkoren skrivas.','draft');
      select set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000002',false);
      select public.approve_contract_template_version('90000000-0000-4000-8000-000000000005');`);
  }
  let sql = await readFile(join(migrationDir, migration), "utf8");
  sql = sql.replace(/create extension if not exists pgcrypto;\s*/ig, "");
  try {
    await db.exec(sql);
  } catch (error) {
    throw new Error(`Migration ${migration} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}


const T='40000000-0000-4000-8000-000000000001',A='40000000-0000-4000-8000-000000000002',B='40000000-0000-4000-8000-000000000003',V='40000000-0000-4000-8000-000000000004';
await db.exec(`insert into auth.users(id,email) values('${A}','audit-a@example.test'),('${B}','audit-b@example.test'),('${V}','audit-v@example.test');
insert into public.tenants(id,slug,name,legal_name) values('${T}','audit-fix','Audit','Audit');
insert into public.tenant_memberships(tenant_id,user_id,role,status,joined_at) values('${T}','${A}','backoffice','active',now()),('${T}','${B}','owner','active',now()),('${T}','${V}','viewer','active',now());
update public.profiles set active_tenant_id='${T}' where id in ('${A}','${B}','${V}');grant usage on schema public,auth to authenticated;`);
const personal=(await db.query(`insert into public.activities(tenant_id,type,title,status,callback_scope,assigned_user_id,created_by,due_at) values($1,'callback','Audit','open','personal',$2,$2,now()-interval '1 hour') returning id`,[T,B])).rows[0].id;
const global=(await db.query(`insert into public.activities(tenant_id,type,title,status,callback_scope,created_by,due_at) values($1,'callback','Audit','open','global',$2,now()-interval '1 hour') returning id`,[T,B])).rows[0].id;
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${A}',false);select set_config('request.jwt.claim.role','authenticated',false);`);
async function denied(sql,args){let failed=false;try{await db.query(sql,args);}catch{failed=true;}if(!failed)throw Error('Expected permission denial');}
await denied("select public.snooze_customer_callback($1,now()+interval '1 day')",[personal]);
await denied("select public.complete_customer_callback($1,null)",[personal]);
await db.exec(`select set_config('request.jwt.claim.sub','${V}',false);`);
await denied('select public.claim_customer_callback($1)',[global]);
await db.exec(`select set_config('request.jwt.claim.sub','${B}',false);`);
await db.query('select public.complete_customer_callback($1,null)',[personal]);
console.log('PASS: NULL-safe callback denial, viewer claim denial, legitimate owner completion.');

await db.exec('reset role;');
const team=(await db.query(`insert into public.teams(tenant_id,name) values($1,'Audit team') returning id`,[T])).rows[0].id;
await db.exec('begin;');
await db.query(`update public.tenant_memberships set role='sales',primary_team_id=$1 where tenant_id=$2 and user_id=$3`,[team,T,A]);
await db.query(`insert into public.team_members(tenant_id,team_id,user_id,role,is_primary) values($1,$2,$3,'member',true)`,[T,team,A]);
await db.exec('commit;');
const customer=(await db.query(`insert into public.customers(tenant_id,customer_type,display_name,email,assigned_user_id,created_by) values($1,'company','Audit customer','audit@example.test',$2,$2) returning id`,[T,B])).rows[0].id;
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${A}',false);`);
await denied("select public.queue_email_message($1,'subject','body','audit-denied','customer_service')",[customer]);
await denied("select public.queue_sms_message($1,'body','audit-denied','customer_service')",[customer]);
await db.exec('reset role;');
const run=(await db.query(`insert into public.import_runs(tenant_id,name,source_type,status,uploaded_by,total_rows,simulation,scan_status) values($1,'Audit completed','csv','completed',$2,0,false,'clean') returning id`,[T,B])).rows[0].id;
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${B}',false);`);
await denied("select public.apply_import_row_normalization($1,'[]'::jsonb)",[run]);
await db.exec('reset role;');
const req=(await db.query(`insert into public.data_subject_requests(tenant_id,customer_id,request_type,subject_reference,status,identity_verified_at,created_by) values($1,$2,'erasure','Audit','processing',now(),$3) returning id`,[T,customer,B])).rows[0].id;
await db.exec("set role service_role;select set_config('request.jwt.claim.sub','',false);select set_config('request.jwt.claim.role','service_role',false);");
await denied('select public.execute_data_subject_erasure($1,$2)',[req,A]);
console.log('PASS: email/SMS object denial, completed remap denial, erasure actor denial.');

await db.exec('reset role;');
await db.query(`update public.tenant_features set enabled=true where tenant_id=$1 and feature_key='outbound_email'`,[T]);
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${B}',false);select set_config('request.jwt.claim.role','authenticated',false);`);
const queued=(await db.query("select public.queue_email_message($1,'Audit','Body','audit-replay-test','customer_service') as id",[customer])).rows[0].id;
const replay=(await db.query("select public.queue_email_message($1,'Audit','Body','audit-replay-test','customer_service') as id",[customer])).rows[0].id;
if(queued!==replay)throw Error('Replay not stable');
await denied("select public.queue_email_message($1,'Changed','Body','audit-replay-test','customer_service')",[customer]);
await db.exec('reset role;');
await db.query(`insert into public.notes(tenant_id,customer_id,body,visibility,created_by) values($1,$2,'Audit export marker','private',$3)`,[T,customer,B]);
await db.query(`insert into public.activities(tenant_id,customer_id,type,title,created_by) values($1,$2,'task','Personal audit marker',$3)`,[T,customer,B]);
await db.query(`insert into public.legal_holds(tenant_id,customer_id,reason,scope,created_by) values($1,$2,'Audit hold','{all}',$3)`,[T,customer,B]);
await db.exec("set role service_role;select set_config('request.jwt.claim.sub','',false);select set_config('request.jwt.claim.role','service_role',false);");
const exported=(await db.query('select public.data_subject_export_for_request($1) as r',[req])).rows[0].r;
if(!JSON.stringify(exported.notes).includes('Audit export marker'))throw Error('Notes missing');
const held=(await db.query("select public.anonymize_customer_record($1,$2,'audit',$3) as r",[T,customer,B])).rows[0].r;
if(held.anonymized!==false)throw Error('Hold ignored');
await db.exec('reset role;');await db.query('update public.legal_holds set active=false where customer_id=$1',[customer]);
await db.exec('set role service_role;');await db.query("select public.anonymize_customer_record($1,$2,'audit',$3)",[T,customer,B]);
await db.exec('reset role;');
const titles=(await db.query('select title from public.activities where customer_id=$1',[customer])).rows;
if(titles.some(x=>x.title.includes('Personal')))throw Error('Residual title');
await db.exec("set role service_role;");
const hb=async(id,status,start)=>db.query("select public.record_platform_worker_heartbeat('data-worker',$1,$2,$3::timestamptz,now(),0,0,0,0,null,null,$4::jsonb)",[id,status,start,JSON.stringify(status==='running'?{scheduler:'test'}:{delivery:{platformEmailConfigured:true}})]);
await hb('new','healthy','2026-11-16T20:02Z');await hb('old','failed','2026-11-16T20:01Z');await hb('newer','running','2026-11-16T20:03Z');
await db.exec('reset role;');
const heartbeat=(await db.query("select worker_id,metadata from public.platform_worker_heartbeats where worker_key='data-worker'")).rows[0];
if(heartbeat.worker_id!=='newer'||!heartbeat.metadata.delivery)throw Error('Heartbeat generation/metadata regression');
console.log('PASS: message payload binding, export notes, hold protection, title erasure, heartbeat ordering and metadata.');

await db.exec('reset role;');
await db.query("update public.outbox_jobs set status='processing',attempts=2,max_attempts=1,locked_at=now()-interval '6 minutes' where aggregate_id=$1",[queued]);
await db.exec('set role service_role;');await db.query("select * from public.claim_outbox_jobs('budget-audit',1)");await db.exec('reset role;');
const budget=(await db.query('select status,attempts from public.outbox_jobs where aggregate_id=$1',[queued])).rows[0];
if(budget.status!=='dead_letter'||budget.attempts!==2)throw Error('Crash budget not enforced');
console.log('PASS: exhausted processing claim moves to dead-letter without another attempt.');

await db.exec('reset role;');
const otherTeam=(await db.query(`insert into public.teams(tenant_id,name) values($1,'Hidden team') returning id`,[T])).rows[0].id;
await db.query(`insert into public.team_members(tenant_id,team_id,user_id,role) values($1,$2,$3,'manager')`,[T,otherTeam,B]);
const isolatedTenant=(await db.query("insert into public.tenants(slug,name,legal_name) values('isolated-audit','Isolated','Isolated') returning id")).rows[0].id;
const isolatedTeam=(await db.query("insert into public.teams(tenant_id,name) values($1,'Other tenant team') returning id",[isolatedTenant])).rows[0].id;
await db.exec(`grant select on public.teams,public.team_members to authenticated;set role authenticated;select set_config('request.jwt.claim.sub','${A}',false);select set_config('request.jwt.claim.role','authenticated',false);`);
if((await db.query('select id from public.teams where id=$1',[otherTeam])).rows.length)throw Error('Foreign team readable');
if((await db.query('select user_id from public.team_members where team_id=$1',[otherTeam])).rows.length)throw Error('Foreign membership readable');
if((await db.query('select id from public.teams where id=$1',[team])).rows.length!==1)throw Error('Own team not readable');
if((await db.query('select id from public.teams where id=$1',[isolatedTeam])).rows.length)throw Error('Other tenant team readable');
await db.exec(`select set_config('request.jwt.claim.sub','${B}',false);`);
if((await db.query('select id from public.teams where id=$1',[otherTeam])).rows.length!==1)throw Error('Tenant owner lost team visibility');
await db.exec('reset role;');
const atomicCustomer=(await db.query(`insert into public.customers(tenant_id,customer_type,display_name,created_by) values($1,'company','Before atomic',$2) returning id`,[T,B])).rows[0].id;
await db.exec(`create function private.reject_audit_fixture() returns trigger language plpgsql as $$ begin if new.action='customer.updated_atomic' then raise exception 'injected_audit_failure'; end if;return new;end $$;create trigger audit_fixture_failure before insert on public.audit_logs for each row execute function private.reject_audit_fixture();`);
await denied("update public.customers set display_name='Must rollback' where id=$1",[atomicCustomer]);
if((await db.query('select display_name from public.customers where id=$1',[atomicCustomer])).rows[0].display_name!=='Before atomic')throw Error('Audit failure did not roll back');
await db.exec('drop trigger audit_fixture_failure on public.audit_logs;');
await db.query("update public.customers set display_name='After atomic' where id=$1",[atomicCustomer]);
if(!(await db.query("select id from public.audit_logs where entity_id=$1 and action='customer.updated_atomic'",[atomicCustomer])).rows.length)throw Error('Atomic audit missing');
await db.query("update public.import_runs set status='validating',validation_report='{\"normalization_token\":\"new-attempt\"}' where id=$1",[run]);
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${B}',false);`);
await denied("select public.apply_import_row_normalization($1,'[{\"normalization_token\":\"old-attempt\"}]'::jsonb)",[run]);
console.log('PASS: hidden team/member denied, audit failure rolls back update, successful update includes audit, stale normalization denied.');
await db.exec('reset role;');
const pl=(await db.query("insert into public.platform_lists(name,status,created_by) values('Contact fixture','active',$1) returning id",[B])).rows[0].id;
const pe=(await db.query(`insert into public.platform_list_entries(platform_list_id,display_name,data_hash,metadata) values($1,'Company','fixturecontacts','{"contacts":[{"full_name":"Anna","phone_e164":"+46700000001"},{"full_name":"Bo","phone_e164":"+46700000002"},{"full_name":"Anna","phone_e164":"+46700000001"}]}') returning id`,[pl])).rows[0].id;
const pa=(await db.query("insert into public.platform_list_allocations(platform_list_id,tenant_id,name,requested_count,created_by,exclusivity_mode) values($1,$2,'Contacts',1,$3,'shared') returning id",[pl,T,B])).rows[0].id;
await db.query('insert into public.platform_list_allocation_entries(allocation_id,platform_entry_id,tenant_id,customer_id) values($1,$2,$3,$4)',[pa,pe,T,atomicCustomer]);
if((await db.query('select id from public.contact_people where tenant_id=$1 and customer_id=$2',[T,atomicCustomer])).rows.length!==2)throw Error('Imported contact materialization lost or duplicated contacts');
console.log('PASS: allocation materializes distinct imported contacts within canonical customer tenant.');
await db.exec('reset role;');
await db.query("update public.tenant_features set enabled=true where tenant_id=$1 and feature_key='outbound_sms'",[T]);
const fencedSms=(await db.query(`insert into public.sms_messages(tenant_id,customer_id,direction,from_number,to_number,body,status,purpose) values($1,$2,'outbound','+46700000001','+46700000002','Fence fixture','queued','customer_service') returning id`,[T,atomicCustomer])).rows[0].id;
const fencedJob=(await db.query(`insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,idempotency_key,status,attempts,locked_by,locked_at,payload) values($1,'sms.send','sms_message',$2,'fence-fixture','processing',2,'current-worker',now(),'{}'::jsonb) returning id`,[T,fencedSms])).rows[0].id;
await db.exec('set role service_role;');
await denied("select public.prepare_sms_submission($1,$2,$3,'old-worker',1)",[T,fencedSms,fencedJob]);
await db.query("select public.prepare_sms_submission($1,$2,$3,'current-worker',2)",[T,fencedSms,fencedJob]);
await denied("select public.prepare_sms_submission($1,$2,$3,'current-worker',2)",[T,fencedSms,fencedJob]);
await db.exec('reset role;');
await db.query("update public.outbox_jobs set locked_by='successor',attempts=3 where id=$1",[fencedJob]);
await db.exec('set role service_role;');
await denied("select public.prepare_sms_submission($1,$2,$3,'successor',3)",[T,fencedSms,fencedJob]);
console.log('PASS: SMS fence rejects stale attempt, repeated submission and successor replay of uncertain effect.');
await db.exec('reset role;');
// Storage metadata fixtures: omit unrelated ingestion/provider graph, not the retention implementation.
await db.exec("set session_replication_role=replica;");
const rawFile=(await db.query(`insert into public.raw_payloads(tenant_id,ingestion_run_id,permission_id,content_type,payload_sha256,payload_ciphertext,storage_path,retention_until) values($1,gen_random_uuid(),gen_random_uuid(),'application/json','fixture','encrypted-fixture','tenant/raw/fixture.json',now()-interval '1 day') returning id`,[T])).rows[0].id;
const recordingFile=(await db.query(`insert into public.call_recordings(tenant_id,call_id,storage_path,retention_until,status) values($1,gen_random_uuid(),'tenant/recording/fixture.wav',now()-interval '1 day','available') returning id`,[T])).rows[0].id;
await db.exec('set session_replication_role=origin;set role service_role;');
const retention=(await db.query('select public.run_retention_maintenance($1,10) as r',[T])).rows[0].r;
if(retention.status!=='failed'||retention.pendingRawFiles!==1||retention.recordingsPurged!==0)throw Error('Retention falsely acknowledged physical deletion');
await db.exec('reset role;');
const rawAfter=(await db.query('select storage_path,payload_ciphertext from public.raw_payloads where id=$1',[rawFile])).rows[0];
const recordingAfter=(await db.query('select storage_path,status,retention_delete_at from public.call_recordings where id=$1',[recordingFile])).rows[0];
if(!rawAfter.storage_path||!rawAfter.payload_ciphertext||!recordingAfter.storage_path||recordingAfter.status==='purged'||!recordingAfter.retention_delete_at)throw Error('Retention forgot physical locator');
console.log('PASS: retention preserves physical locators, schedules legacy recording due date and reports unresolved raw cleanup.');
await db.exec('reset role;');
const ingestionProvider=(await db.query("insert into public.data_providers(tenant_id,provider,name) values($1,'fixture','Fenced source') returning id",[T])).rows[0].id;
const ingestionPermission=(await db.query("insert into public.provider_permissions(tenant_id,data_provider_id,permission_name,cache_scope,status) values($1,$2,'Fixture permission','tenant','active') returning id",[T,ingestionProvider])).rows[0].id;
const ingestionJob=(await db.query("insert into public.ingestion_jobs(tenant_id,data_provider_id,permission_id,name,entity_type) values($1,$2,$3,'Fenced job','organization') returning id",[T,ingestionProvider,ingestionPermission])).rows[0].id;
const fencedIngestion=(await db.query(`insert into public.ingestion_runs(tenant_id,ingestion_job_id,status,attempts,max_attempts,locked_at,locked_by,metadata) values($1,$2,'running',1,3,now()-interval '16 minutes','old-ingestion','{"execution_token":"old-token"}') returning id`,[T,ingestionJob])).rows[0].id;
await db.query(`insert into public.crawl_checkpoints(tenant_id,ingestion_run_id,last_successful_step) values($1,$2,'before')`,[T,fencedIngestion]);
await db.exec("set role service_role;select set_config('request.jwt.claim.sub','',false);select set_config('request.jwt.claim.role','service_role',false);");
const takeover=(await db.query("select * from public.claim_ingestion_runs('current-ingestion',25)")).rows.find(r=>r.id===fencedIngestion);
if(!takeover||takeover.attempts!==2||takeover.metadata.execution_token==='old-token')throw Error('Ingestion abandoned run not recovered with new generation');
async function rejectedAs(sql,args,reason){let error;try{await db.query(sql,args)}catch(e){error=e}if(!error||!String(error.message).includes(reason))throw Error('Expected '+reason+', got '+error?.message);}
for(const op of ['checkpoint','record_ingestion_raw_payload','complete_ingestion_record','reserve_provider_ingestion_usage','complete_ingestion_run','fail_ingestion_run','raw_status'])await rejectedAs("select public.ingestion_command($1,'old-ingestion',1,'old-token',$2,'{}')",[fencedIngestion,op],'ingestion_lease_lost');
await rejectedAs("select public.ingestion_command($1,'current-ingestion',2,'old-token','checkpoint','{}')",[fencedIngestion],'ingestion_lease_lost');
await db.query("select public.ingestion_command($1,'current-ingestion',2,$2,'checkpoint','{\"page\":\"7\",\"remaining\":2,\"fingerprint\":\"fixture\"}')",[fencedIngestion,takeover.metadata.execution_token]);
await db.exec('reset role;');
if((await db.query('select current_page from public.ingestion_runs where id=$1',[fencedIngestion])).rows[0].current_page!=='7')throw Error('Current ingestion checkpoint failed');
await db.query("update public.ingestion_runs set status='cancelled',completed_at=now(),locked_at=null,locked_by=null where id=$1",[fencedIngestion]);
await db.exec('set role service_role;');
await rejectedAs("select public.ingestion_command($1,'current-ingestion',2,$2,'complete_ingestion_run','{}')",[fencedIngestion,takeover.metadata.execution_token],'ingestion_lease_lost');
await rejectedAs("select public.complete_ingestion_run($1,null,'{}')",[fencedIngestion],'permission denied');
console.log('PASS: abandoned ingestion gets fresh generation; every stale command and post-cancel completion denied; unfenced legacy RPC denied.');

await db.exec('reset role;');
const parseImport=(await db.query(`insert into public.import_runs(tenant_id,name,source_type,status,uploaded_by,total_rows,simulation,scan_status,source_run_id) values($1,'Fenced ParseHub','json','validating',$2,2,true,'clean','fixture-run-hash') returning id`,[T,B])).rows[0].id;
const parseProject=(await db.query("insert into public.parsehub_projects(tenant_id,project_token_hash,project_name,webhook_secret_hash,active) values($1,'fixture-project-token','Fence project','fixture-secret',true) returning id",[T])).rows[0].id;
const parseRun=(await db.query(`insert into public.parsehub_runs(tenant_id,parsehub_project_id,run_token_hash,idempotency_key,run_token_ciphertext,status,attempts,locked_by,locked_at,metadata) values($1,$2,'fixture-run-hash','fenced-parse-fixture','encrypted','processing',1,'old-parse',now()-interval '16 minutes','{"execution_token":"old-parse-token"}') returning id`,[T,parseProject])).rows[0].id;
await db.exec('set role service_role;');
let parseClaim=(await db.query("select * from public.claim_parsehub_runs('current-parse',25)")).rows.find(r=>r.id===parseRun);
if(!parseClaim||parseClaim.attempts!==2)throw Error('ParseHub abandoned run not recovered');
for(const op of ['ping','bind_import','create_import','clear_rows','insert_rows','finalize_import','link','commit','complete','fail'])await rejectedAs("select public.parsehub_command($1,'old-parse',1,'old-parse-token',$2,'{}')",[parseRun,op],'parsehub_lease_lost');
await db.exec('reset role;');
const wrongImport=(await db.query("insert into public.import_runs(tenant_id,name,source_type,status,uploaded_by,total_rows,simulation,scan_status,source_run_id) values($1,'Foreign fixture','json','validating',$2,0,true,'clean','fixture-run-hash') returning id",[isolatedTenant,B])).rows[0].id;
await db.exec('set role service_role;');
await rejectedAs("select public.parsehub_command($1,'current-parse',2,$2,'bind_import',jsonb_build_object('id',$3::text))",[parseRun,parseClaim.metadata.execution_token,wrongImport],'parsehub_import_scope_mismatch');
await db.query("select public.parsehub_command($1,'current-parse',2,$2,'bind_import',jsonb_build_object('id',$3::text))",[parseRun,parseClaim.metadata.execution_token,parseImport]);
const parseRows=[1,2].map(n=>({tenant_id:T,import_run_id:parseImport,row_number:n,raw_data:{name:'Fixture'+n},normalized_data:{},decision:'ready',row_status:'valid',errors:[],warning_codes:[]}));
await rejectedAs("select public.parsehub_command($1,'current-parse',2,$2,'insert_rows',$3)",[parseRun,parseClaim.metadata.execution_token,JSON.stringify({rows:[{...parseRows[0],tenant_id:isolatedTenant}]})],'parsehub_row_scope_mismatch');
await db.query("select public.parsehub_command($1,'current-parse',2,$2,'insert_rows',$3)",[parseRun,parseClaim.metadata.execution_token,JSON.stringify({rows:parseRows.slice(0,1)})]);
await rejectedAs("select public.parsehub_command($1,'current-parse',2,$2,'finalize_import','{\"total_rows\":2,\"validation_report\":{}}')",[parseRun,parseClaim.metadata.execution_token],'parsehub_row_count_mismatch');
await db.query("select public.parsehub_command($1,'current-parse',2,$2,'insert_rows',$3)",[parseRun,parseClaim.metadata.execution_token,JSON.stringify({rows:parseRows.slice(1)})]);
await db.query("select public.parsehub_command($1,'current-parse',2,$2,'finalize_import','{\"total_rows\":2,\"validation_report\":{}}')",[parseRun,parseClaim.metadata.execution_token]);
await db.query("select public.parsehub_command($1,'current-parse',2,$2,'complete','{}')",[parseRun,parseClaim.metadata.execution_token]);
await rejectedAs("select public.parsehub_command($1,'current-parse',2,$2,'fail','{\"error\":\"late\"}')",[parseRun,parseClaim.metadata.execution_token],'parsehub_lease_lost');
console.log('PASS: abandoned ParseHub recovery, stale writes/commit/fail denied, partial batch cannot finalize and complete resists late failure.');

await db.exec('reset role;create table public.spatial_ref_sys(srid integer primary key);grant all on public.spatial_ref_sys to anon,authenticated;create function public.st_estimatedextent(text,text) returns integer language sql security definer as $$select 1$$;grant execute on function public.st_estimatedextent(text,text) to public;');
await db.exec(await readFile(join(migrationDir,'20261117004000_audit_postgis_effective_acl.sql'),'utf8'));
await db.exec('set role anon;');
await rejectedAs("insert into public.spatial_ref_sys values(1)",[],'permission denied');
await rejectedAs("select public.st_estimatedextent('public','customers')",[],'permission denied');
await db.exec('reset role;');
console.log('PASS: effective PostGIS fixture ACL denies anonymous writes and privileged extent execution.');
// Explicit AAL1 is denied at direct RLS and SECURITY DEFINER command boundaries.
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${B}',false);select set_config('request.jwt.claim.role','authenticated',false);select set_config('request.jwt.claim.aal','aal1',false);`);
if((await db.query('select public.current_tenant_id() as id')).rows[0].id!==null)throw Error('MFA AAL1 tenant context bypass');
if(!(await db.query('select public.current_user_mfa_required() as required')).rows[0].required)throw Error('Admin MFA not required');
if((await db.query('select id from public.teams where id=$1',[otherTeam])).rows.length)throw Error('MFA AAL1 direct RLS bypass');
await rejectedAs("select public.queue_email_message($1,'MFA','fixture','mfa-aal1-fixture','customer_service')",[atomicCustomer],'authentication_required');
await db.exec("select set_config('request.jwt.claim.aal','aal2',false);");
if((await db.query('select public.current_tenant_id() as id')).rows[0].id!==T)throw Error('Verified MFA lost legitimate tenant');
if((await db.query('select id from public.teams where id=$1',[otherTeam])).rows.length!==1)throw Error('Verified MFA lost legitimate owner access');
console.log('PASS: administrator AAL1 denied by tenant context, direct RLS and RPC; AAL2 restores legitimate tenant access.');
await db.exec('reset role;');
const physicalRaw=(await db.query(`insert into public.raw_payloads(tenant_id,ingestion_run_id,permission_id,content_type,payload_sha256,payload_ciphertext,storage_path,retention_until,metadata) values($1,$2,$3,'application/json','physical-fixture','encrypted-fixture',$4,now()-interval '1 day','{"storage_bucket":"raw-payloads"}') returning id`,[T,fencedIngestion,ingestionPermission,T+'/raw/physical-fixture.json'])).rows[0].id;
await db.exec("set role service_role;select set_config('request.jwt.claim.role','service_role',false);");
await db.query('select public.queue_raw_payload_file_deletions($1,100)',[T]);
await db.exec('reset role;');
const deletionJob=(await db.query("select id from public.outbox_jobs where aggregate_id=$1 and job_type='storage.raw_payload_delete'",[physicalRaw])).rows[0].id;
await db.query("update public.outbox_jobs set status='processing',attempts=1,locked_by='deletion-worker',locked_at=now() where id=$1",[deletionJob]);
await db.query("insert into public.legal_holds(tenant_id,customer_id,reason,scope,created_by) values($1,$2,'Deletion hold fixture','{all}',$3)",[T,atomicCustomer,B]);
await db.exec('set role service_role;');
await rejectedAs("select public.raw_payload_deletion_command($1,'old-worker',1,'prepare')",[deletionJob],'outbox_lease_lost');
await rejectedAs("select public.raw_payload_deletion_command($1,'deletion-worker',1,'prepare')",[deletionJob],'raw_payload_legal_hold');
await db.exec('reset role;');
await db.query('update public.legal_holds set active=false where tenant_id=$1',[T]);
await db.exec('set role service_role;');
const preparedRaw=(await db.query("select public.raw_payload_deletion_command($1,'deletion-worker',1,'prepare') as r",[deletionJob])).rows[0].r;
if(preparedRaw.path!==T+'/raw/physical-fixture.json')throw Error('Raw deletion wrong locator');
await db.exec('reset role;');
await rejectedAs("insert into public.legal_holds(tenant_id,customer_id,reason,scope,created_by) values($1,$2,'Concurrent hold','{all}',$3)",[T,atomicCustomer,B],'in_flight_requires_reconciliation');
if(!(await db.query('select storage_path from public.raw_payloads where id=$1',[physicalRaw])).rows[0].storage_path)throw Error('Locator cleared before acknowledgement');
await db.exec('set role service_role;');
await db.query("select public.raw_payload_deletion_command($1,'deletion-worker',1,'acknowledge')",[deletionJob]);
const deletionReplay=(await db.query("select public.raw_payload_deletion_command($1,'deletion-worker',1,'prepare') as r",[deletionJob])).rows[0].r;
if(!deletionReplay.completed)throw Error('Deletion replay not idempotent');
await db.exec('reset role;');
if((await db.query('select storage_path from public.raw_payloads where id=$1',[physicalRaw])).rows[0].storage_path!==null)throw Error('Acknowledged locator not cleared');
console.log('PASS: durable physical deletion intent, lease/hold gates, hold/submission serialization and post-ack locator clearing.');
await db.exec('reset role;');
await db.exec(`create table public.audit_policy_fixture(id integer primary key,tenant_id uuid,owner_uid uuid,visible boolean,value integer default 0);alter table public.audit_policy_fixture enable row level security;grant select on public.audit_policy_fixture to anon,authenticated;grant insert,update,delete on public.audit_policy_fixture to authenticated;
create policy fixture_public on public.audit_policy_fixture for select to public using(visible);
create policy fixture_own on public.audit_policy_fixture for select to authenticated using(tenant_id=public.current_tenant_id() and owner_uid=(select auth.uid()));
create policy fixture_admin on public.audit_policy_fixture for all to authenticated using(public.is_tenant_admin(tenant_id)) with check(public.is_tenant_admin(tenant_id));`);
await db.query('insert into public.audit_policy_fixture(id,tenant_id,owner_uid,visible) values(1,$1,$3,true),(2,$1,$3,false),(3,$1,$4,false),(4,$2,$3,true),(5,$2,$3,false)',[T,isolatedTenant,A,B]);
async function policyMatrix(){const results=[];for(const [role,uid] of [['anon',''],['authenticated',A],['authenticated',B],['authenticated',V]]){
 await db.exec(`set role ${role};`);await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false),set_config('request.jwt.claim.aal','aal2',false)",[uid,role]);
 results.push((await db.query('select id from public.audit_policy_fixture order by id')).rows.map(r=>r.id));
 if(uid===A&&(await db.query('update public.audit_policy_fixture set value=1 where id=2 returning id')).rows.length)throw Error('Select policy granted update');
 if(uid===B){if((await db.query('update public.audit_policy_fixture set value=2 where id=3 returning id')).rows.length!==1)throw Error('Admin update denied');await rejectedAs('insert into public.audit_policy_fixture(id,tenant_id) values(6,$1)',[isolatedTenant],'row-level security');await db.query('insert into public.audit_policy_fixture(id,tenant_id) values(6,$1)',[T]);await db.query('delete from public.audit_policy_fixture where id=6');}
 await db.exec('reset role;');
}return results;}
const policyBefore=await policyMatrix();
await db.exec(await readFile(join(migrationDir,'20261117006000_audit_policy_consolidation.sql'),'utf8'));
const policyAfter=await policyMatrix();
if(JSON.stringify(policyBefore)!==JSON.stringify(policyAfter)||JSON.stringify(policyAfter)!==JSON.stringify([[1,4],[1,2,4],[1,2,3,4],[1,4]]))throw Error('Consolidation changed effective role/tenant applicability');
const overlaps=(await db.query("select tablename from pg_policies cross join (values('SELECT'),('INSERT'),('UPDATE'),('DELETE')) op(cmd) where schemaname='public' and permissive='PERMISSIVE' and pg_policies.cmd in ('ALL',op.cmd) group by tablename,roles,op.cmd having count(*)>1")).rows;
if(overlaps.length)throw Error('Permissive public policy overlap remains');
console.log('PASS: policy consolidation preserves anonymous/sales/viewer/admin reads, write boundaries and cross-tenant checks; no duplicate permissive policies remain within the same role set.');
await db.exec('reset role;');
await db.query(`with runs as (insert into public.ingestion_runs(tenant_id,ingestion_job_id,status,completed_at) select $1,$2,'completed',now() from generate_series(1,5000) returning id,tenant_id) insert into public.crawl_checkpoints(tenant_id,ingestion_run_id,last_successful_step) select tenant_id,id,'index-fixture' from runs`,[T,ingestionJob]);
await db.exec('analyze public.crawl_checkpoints;');
const checkpointPlan=(await db.query('explain select id from public.crawl_checkpoints where tenant_id=$1 and ingestion_run_id=$2',[T,fencedIngestion])).rows.map(r=>r['QUERY PLAN']).join('\n');
if(!checkpointPlan.includes('crawl_checkpoints_tenant_run_idx'))throw Error('Measured checkpoint query did not use planned index: '+checkpointPlan);
console.log('PASS: selective fenced-checkpoint lookup uses new tenant/run index with 5000 real fixture rows.');

await db.exec('reset role;');
const exhaustedIngestion=(await db.query(`insert into public.ingestion_runs(tenant_id,ingestion_job_id,status,attempts,max_attempts,locked_at,locked_by,metadata) values($1,$2,'running',3,3,now()-interval '16 minutes','crashed','{}') returning id`,[T,ingestionJob])).rows[0].id;
const exhaustedParse=(await db.query(`insert into public.parsehub_runs(tenant_id,parsehub_project_id,run_token_hash,idempotency_key,run_token_ciphertext,status,attempts,locked_by,locked_at) values($1,$2,'exhausted-hash','exhausted-key','encrypted','processing',8,'crashed',now()-interval '16 minutes') returning id`,[T,parseProject])).rows[0].id;
await db.exec('set role service_role;');
const recoveredIngestion=(await db.query("select * from public.claim_ingestion_runs('budget-check',25)")).rows;
const recoveredParse=(await db.query("select * from public.claim_parsehub_runs('budget-check',25)")).rows;
if(recoveredIngestion.some(r=>r.id===exhaustedIngestion||r.id===fencedIngestion)||recoveredParse.some(r=>r.id===exhaustedParse||r.id===parseRun))throw Error('Terminal or cancelled run reclaimed');
await db.exec('reset role;');
const exhaustedState=(await db.query('select status,attempts,completed_at from public.ingestion_runs where id=$1',[exhaustedIngestion])).rows[0];
if(exhaustedState.status!=='failed'||exhaustedState.attempts!==3||!exhaustedState.completed_at)throw Error('Ingestion crash budget exceeded');
const exhaustedParseState=(await db.query('select status,attempts from public.parsehub_runs where id=$1',[exhaustedParse])).rows[0];
if(exhaustedParseState.status!=='failed'||exhaustedParseState.attempts!==8)throw Error('ParseHub crash budget exceeded');
console.log('PASS: ingestion/ParseHub recovery respects exhausted budgets and never reclaims cancelled/completed work.');
// Approval and price readiness are database boundaries, not just form checks.
await db.exec('reset role; grant select,insert,update on public.contract_templates,public.contract_template_versions,public.products,public.product_price_versions to authenticated;');
await db.exec('reset role;');
const readinessProduct=(await db.query(`insert into public.products(tenant_id,name) values($1,'Readiness fixture') returning id`,[T])).rows[0].id;
const readinessTemplate=(await db.query(`insert into public.contract_templates(tenant_id,name,contract_type,audience) values($1,'Readiness fixture','service','BOTH') returning id`,[T])).rows[0].id;
const readinessVersion=(await db.query(`insert into public.contract_template_versions(tenant_id,template_id,version,title_template,body_template,terms_template,status,created_by) values($1,$2,1,'Avtal','Belopp {{price.recurring_fee}}','Bindning {{price.binding_months}}','draft',$3) returning id`,[T,readinessTemplate,B])).rows[0].id;
async function readinessDenied(sql,args,reason){try{await db.query(sql,args);}catch(e){if(String(e.message).includes(reason))return;throw e;}throw Error('Expected readiness refusal: '+reason);}
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${B}',false);select set_config('request.jwt.claim.role','authenticated',false);`);
await readinessDenied('select public.approve_contract_template_version($1)',[readinessVersion],'contract_active_product_required');
await db.query('update public.contract_templates set product_id=$1 where id=$2',[readinessProduct,readinessTemplate]);
await readinessDenied('select public.approve_contract_template_version($1)',[readinessVersion],'contract_effective_price_required');
await db.exec('reset role;');
const readinessPrice=(await db.query(`insert into public.product_price_versions(tenant_id,product_id,version,recurring_fee,binding_months) values($1,$2,1,0,null) returning id`,[T,readinessProduct])).rows[0].id;
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${B}',false);`);
await readinessDenied('select public.approve_contract_template_version($1)',[readinessVersion],'contract_required_price_value_missing:binding_months');
await db.query(`update public.contract_template_versions set terms_template='Här ska slutvillkoren fyllas i.' where id=$1`,[readinessVersion]);
await readinessDenied(`update public.contract_template_versions set status='approved' where id=$1`,[readinessVersion],'contract_final_terms_required');
await db.query(`update public.contract_template_versions set terms_template='Bindning {{price.binding_months?Ingen angiven}}. Avgift {{price.recurring_fee}}.' where id=$1`,[readinessVersion]);
await db.query('select public.approve_contract_template_version($1)',[readinessVersion]);
await readinessDenied('update public.contract_templates set product_id=null where id=$1',[readinessTemplate],'contract_active_product_required');
await db.exec('reset role;');
// A subsequent active price may not remove a field the approved template needs.
await readinessDenied('update public.product_price_versions set recurring_fee=null where id=$1',[readinessPrice],'contract_required_price_value_missing:recurring_fee');
// Required duration is allowed to be explicitly zero, and may not be nulled later.
const strictVersion=(await db.query(`insert into public.contract_template_versions(tenant_id,template_id,version,title_template,body_template,terms_template,status,created_by) values($1,$2,2,'Avtal','Belopp {{price.recurring_fee}}','Bindning {{price.binding_months}}','draft',$3) returning id`,[T,readinessTemplate,B])).rows[0].id;
await db.query('update public.product_price_versions set binding_months=0 where id=$1',[readinessPrice]);
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${B}',false);`);
await db.query('select public.approve_contract_template_version($1)',[strictVersion]);
await readinessDenied('update public.product_price_versions set binding_months=null where id=$1',[readinessPrice],'contract_required_price_value_missing:binding_months');
await denied(`select public.assert_contract_readiness($1,$2,'x','y','z',null)`,[T,readinessProduct]);
await db.exec('reset role;');
const B2=(await db.query(`insert into auth.users(id,email) values(gen_random_uuid(),'other-owner@example.test') returning id`)).rows[0].id;
await db.query(`insert into public.tenant_memberships(tenant_id,user_id,role,status,joined_at) values($1,$2,'owner','active',now())`,[isolatedTenant,B2]);
await db.query('update public.profiles set active_tenant_id=$1 where id=$2',[isolatedTenant,B2]);
await db.exec('set role authenticated;');
// A tenant B owner cannot approve a tenant A version or alter its price.
await db.exec(`select set_config('request.jwt.claim.sub','${B2}',false);`);
await denied('select public.approve_contract_template_version($1)',[strictVersion]);
const foreignPriceUpdate=await db.query('update public.product_price_versions set binding_months=99 where id=$1 returning id',[readinessPrice]);
if(foreignPriceUpdate.rows.length)throw Error('Other tenant changed approved price');
await db.exec('reset role;');
// The exact selected price must be effective. A valid product price elsewhere
// does not rescue a draft bound to a missing/expired/cross-product version.
async function readinessDraft(priceId,templateVersionId=strictVersion){
  await db.exec('begin;');
  try {
    const c=(await db.query(`insert into public.contracts(tenant_id,contract_number,customer_id,template_id,product_id,audience,status,title) values($1,$2,$3,$4,$5,'B2B','draft','Readiness') returning id`,[T,'READY-'+Math.random(),customer,readinessTemplate,readinessProduct])).rows[0].id;
    await db.query(`insert into public.contract_versions(tenant_id,contract_id,version,template_version_id,price_version_id,title,rendered_body,document_hash) values($1,$2,1,$3,$4,'Readiness','Body','readiness-fixture')`,[T,c,templateVersionId,priceId]);
    await db.exec('commit;');
  } catch(e){await db.exec('rollback;');throw e;}
}
try{await readinessDraft(null);throw Error('Missing selected price accepted');}catch(e){if(!String(e.message).includes('contract_effective_price_required'))throw e;}
try{await readinessDraft(readinessPrice,null);throw Error('Unbound template version accepted');}catch(e){if(!String(e.message).includes('approved_contract_template_required'))throw e;}
await readinessDraft(readinessPrice);
await db.query(`update public.product_price_versions set valid_to=current_date-1 where id=$1`,[readinessPrice]);
try{try{await readinessDraft(readinessPrice,null);throw Error('Unbound template version accepted');}catch(e){if(!String(e.message).includes('approved_contract_template_required'))throw e;}
await readinessDraft(readinessPrice);throw Error('Expired selected price accepted');}catch(e){if(!String(e.message).includes('contract_effective_price_required'))throw e;}
console.log('PASS: direct DB/RPC approval, product binding, final terms, required/optional/zero price fields, subsequent price edits, private helper ACL, cross-tenant denial and selected draft price are enforced.');


// Expired invitations are renewed by tenant admins without changing Auth credentials,
// granting roles, sending mail, or bypassing the invitee's own activation.
await db.exec('reset role;');
const invitee=(await db.query(`insert into auth.users(id,email) values(gen_random_uuid(),'renewal@example.test') returning id`)).rows[0].id;
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${B}',false);select set_config('request.jwt.claim.role','authenticated',false);`);
const renewalInvitation=(await db.query(`select public.reserve_tenant_invitation_v2($1,'renewal@example.test','viewer','{}',null,null,now()+interval '7 days','audit-renewal') as id`,[T])).rows[0].id;
await db.exec('reset role;set role service_role;');
await db.query('select public.mark_tenant_invitation_auth_provisioned($1,$2,false)',[renewalInvitation,invitee]);
await db.exec(`reset role;set role authenticated;select set_config('request.jwt.claim.sub','${B}',false);`);
await db.query('select public.finalize_tenant_invitation($1,$2)',[renewalInvitation,invitee]);
await db.exec('reset role;');
await db.query(`update public.tenant_invitations set expires_at=now()-interval '1 day' where id=$1`,[renewalInvitation]);
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${V}',false);`);
await readinessDenied('select public.renew_tenant_invitation($1)',[renewalInvitation],'invitation_renewal_permission_required');
await db.exec(`select set_config('request.jwt.claim.sub','${B2}',false);`);
await readinessDenied('select public.renew_tenant_invitation($1)',[renewalInvitation],'invitation_not_found');
await db.exec(`select set_config('request.jwt.claim.sub','${B}',false);select set_config('request.jwt.claim.aal','aal1',false);`);
await denied('select public.renew_tenant_invitation($1)',[renewalInvitation]);
await db.exec(`select set_config('request.jwt.claim.aal','aal2',false);`);
const renewed=(await db.query('select public.renew_tenant_invitation($1) as expiry',[renewalInvitation])).rows[0].expiry;
const repeated=(await db.query('select public.renew_tenant_invitation($1) as expiry',[renewalInvitation])).rows[0].expiry;
if(String(renewed)!==String(repeated)||Date.parse(renewed)<=Date.now())throw Error('Invitation renewal not future/idempotent');
await db.exec('reset role;');
const renewalState=(await db.query(`select i.status,m.status as membership_status,m.role,(select count(*)::int from public.audit_logs where entity_id=i.id::text and action='tenant.invitation_renewed') as audits from public.tenant_invitations i join public.tenant_memberships m on m.tenant_id=i.tenant_id and m.user_id=i.invited_user_id where i.id=$1`,[renewalInvitation])).rows[0];
if(renewalState.status!=='pending'||renewalState.membership_status!=='invited'||renewalState.role!=='viewer'||renewalState.audits!==1)throw Error('Renewal activated membership, changed role or duplicated audit');
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${invitee}',false);`);
const activation=(await db.query('select public.activate_current_user_invitation() as tenant')).rows[0].tenant;
if(activation!==T)throw Error('Invitee could not activate renewed invitation');
await db.exec(`select set_config('request.jwt.claim.sub','${B}',false);`);
await readinessDenied('select public.renew_tenant_invitation($1)',[renewalInvitation],'pending_invitation_required');
await db.exec('reset role;');
const identityInvitation=(await db.query(`insert into public.tenant_invitations(tenant_id,email,role,status,invited_by,invited_user_id,expires_at,orchestration_status) values($1,'audit-v@example.test','viewer','pending',$2,$3,now()+interval '7 days','finalized') returning id`,[T,B,invitee])).rows[0].id;
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${V}',false);`);
if((await db.query('select public.activate_current_user_invitation() as tenant')).rows[0].tenant!==null)throw Error('Email fallback took another bound identity invitation');
await db.exec('reset role;');
await db.query(`update public.tenant_invitations set revoked_at=now() where id=$1`,[identityInvitation]);
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${B}',false);`);
await readinessDenied('select public.renew_tenant_invitation($1)',[identityInvitation],'pending_invitation_required');
await db.exec('reset role;');
console.log('PASS: expired invitation renewal is tenant/admin/MFA scoped and idempotent, preserves invited role, records one audit, denies revoked/accepted invitations, binds Auth identity and requires the invitee to activate.');


await db.exec('reset role;');
const cancelOwner=(await db.query(`insert into auth.users(id,email) values(gen_random_uuid(),'cancel-owner@example.test') returning id`)).rows[0].id;
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${B}',false);`);
const cancelInvitation=(await db.query(`select public.reserve_tenant_invitation_v2($1,'cancel-owner@example.test','owner','{}',null,null,now()+interval '7 days','audit-cancel-owner') as id`,[T])).rows[0].id;
await db.exec('reset role;set role service_role;');
await db.query('select public.mark_tenant_invitation_auth_provisioned($1,$2,false)',[cancelInvitation,cancelOwner]);
await db.exec(`reset role;set role authenticated;select set_config('request.jwt.claim.sub','${B}',false);`);
await db.query('select public.finalize_tenant_invitation($1,$2)',[cancelInvitation,cancelOwner]);
await db.exec('reset role;');
await db.query(`update public.tenant_memberships set role='admin' where tenant_id=$1 and user_id=$2`,[T,A]);
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${A}',false);`);
await readinessDenied('select public.renew_tenant_invitation($1)',[cancelInvitation],'owner_required');
await db.exec(`select set_config('request.jwt.claim.sub','${B}',false);`);
// Removing an invited owner must not mistake that person for the last active owner.
await db.query(`select public.update_tenant_member_v3($1,'owner','removed',null,'{}',null,true)`,[cancelOwner]);
await db.exec('reset role;');
const cancellation=(await db.query('select status,revoked_at from public.tenant_invitations where id=$1',[cancelInvitation])).rows[0];
if(cancellation.status!=='revoked'||!cancellation.revoked_at)throw Error('Canonical member removal left a live invitation');
const capacityTeam=(await db.query(`insert into public.teams(tenant_id,name,max_members) values($1,'Renewal capacity',1) returning id`,[T])).rows[0].id;
const capacityUser=(await db.query(`insert into auth.users(id,email) values(gen_random_uuid(),'capacity-invite@example.test') returning id`)).rows[0].id;
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${B}',false);`);
const capacityInvitation=(await db.query(`select public.reserve_tenant_invitation_v2($1,'capacity-invite@example.test','viewer',array[$2::uuid],$2,null,now()+interval '7 days','audit-capacity-renewal') as id`,[T,capacityTeam])).rows[0].id;
await db.exec('reset role;set role service_role;');
await db.query('select public.mark_tenant_invitation_auth_provisioned($1,$2,false)',[capacityInvitation,capacityUser]);
await db.exec(`reset role;set role authenticated;select set_config('request.jwt.claim.sub','${B}',false);`);
await db.query('select public.finalize_tenant_invitation($1,$2)',[capacityInvitation,capacityUser]);
await db.exec('reset role;');
await db.query(`update public.tenant_invitations set expires_at=now()-interval '1 day' where id=$1`,[capacityInvitation]);
await db.query(`insert into public.team_members(tenant_id,team_id,user_id,role,is_primary) values($1,$2,$3,'manager',false)`,[T,capacityTeam,B]);
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${B}',false);`);
await readinessDenied('select public.renew_tenant_invitation($1)',[capacityInvitation],'team_member_limit_reached');
await db.exec('reset role;');
if((await db.query('select expires_at<now() as expired from public.tenant_invitations where id=$1',[capacityInvitation])).rows[0].expired!==true)throw Error('Failed renewal changed expiry');
console.log('PASS: non-owner admin cannot renew owner invitation, canonical revocation cancels pending invitation, invited owner cancellation preserves last active owner and renewal respects current team capacity.');


// Measure the exact global identity/email activation predicate, not just whether
// an index exists. The target is selective among 5000 unrelated pending rows.
await db.exec('reset role;');
await db.query(`insert into public.tenant_invitations(tenant_id,email,role,status,invited_by,invited_user_id,expires_at,orchestration_status)
 select $1,'plan-'||n||'@example.test','viewer','pending',$2,$3,now()+interval '7 days','finalized' from generate_series(1,5000) n`,[T,B,V]);
await db.query(`insert into public.tenant_invitations(tenant_id,email,role,status,invited_by,invited_user_id,expires_at,orchestration_status)
 values($1,'plan-target@example.test','viewer','pending',$2,$3,now()+interval '7 days','finalized'),($1,'plan-legacy@example.test','viewer','pending',$2,null,now()+interval '7 days','finalized')`,[T,B,capacityUser]);
await db.exec('analyze public.tenant_invitations;');
const invitationPlan=(await db.query(`explain select id from public.tenant_invitations where status='pending' and expires_at>now() and revoked_at is null and
 (invited_user_id=$1 or (invited_user_id is null and lower(email::text)=$2)) order by created_at desc limit 1`,[capacityUser,'plan-legacy@example.test'])).rows.map(row=>row['QUERY PLAN']).join('\n');
if(!invitationPlan.includes('tenant_invitations_pending_identity_idx')||!invitationPlan.includes('tenant_invitations_pending_legacy_email_idx'))throw Error('Invitation identity/email plan did not use both targeted indexes: '+invitationPlan);
console.log('PASS: exact invitation activation identity/legacy-email OR predicate uses both targeted indexes with 5000 fixture rows.');


await db.exec(`reset role;set role authenticated;select set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000002',false);`);
const repairedDraft=(await db.query(`select public.create_product_contract_template_version('90000000-0000-4000-8000-000000000003','90000000-0000-4000-8000-000000000004','Legacy unlinked','service','BOTH',null,null,'Avtal','Fullständig testtext','Bindning {{price.binding_months}} månader.','[]','{}','{}') as id`)).rows[0].id;
const repairState=(await db.query(`select t.product_id,t.current_version_id,v.status from public.contract_templates t join public.contract_template_versions v on v.template_id=t.id where v.id=$1`,[repairedDraft])).rows[0];
if(repairState.product_id!=='90000000-0000-4000-8000-000000000003'||repairState.current_version_id!==null||repairState.status!=='draft')throw Error('Legacy product repair carried old approval or did not link product');
await readinessDenied('select public.approve_contract_template_version($1)',[repairedDraft],'contract_required_price_value_missing:binding_months');
await db.exec('reset role;');
const oldTerms=(await db.query(`select status,terms_template from public.contract_template_versions where id='90000000-0000-4000-8000-000000000005'`)).rows[0];
if(oldTerms.status!=='approved'||oldTerms.terms_template!=='Här ska slutvillkoren skrivas.')throw Error('Legacy immutable version was rewritten during repair');
await db.query(`update public.product_price_versions set binding_months=0 where tenant_id='90000000-0000-4000-8000-000000000001'`);
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000002',false);`);
await db.query('select public.approve_contract_template_version($1)',[repairedDraft]);
console.log('PASS: pre-upgrade unlinked approved instruction template can be repaired through canonical authoring; old version preserved, new draft requires explicit approval and decided price fields.');


await db.exec('reset role;');
const LT='90000000-0000-4000-8000-000000000001',LO='90000000-0000-4000-8000-000000000002',LP='90000000-0000-4000-8000-000000000003';
const basePrice=(await db.query(`select * from public.product_price_versions where tenant_id=$1 and product_id=$2 order by version desc limit 1`,[LT,LP])).rows[0];
await db.query(`update public.product_price_versions set setup_fee=17,recurring_fee=49,discounts='[{"name":"fixture"}]',variable_fees='[{"amount":2}]' where id=$1`,[basePrice.id]);
const otherProduct=(await db.query(`insert into public.products(tenant_id,name) values($1,'Independent product') returning id`,[LT])).rows[0].id;
const otherPrice=(await db.query(`insert into public.product_price_versions(tenant_id,product_id,version,binding_months,notice_months) values($1,$2,1,12,3) returning id`,[LT,otherProduct])).rows[0].id;
const termsCustomer=(await db.query(`insert into public.customers(tenant_id,customer_type,display_name,created_by) values($1,'company','Terms fixture',$2) returning id`,[LT,LO])).rows[0].id;
const termsIssuer=(await db.query(`insert into public.tenant_legal_entities(tenant_id,legal_name,active) values($1,'Terms fixture',true) returning id`,[LT])).rows[0].id;
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${LO}',false);`);
const termsDraft=async(price,binding,notice,number)=>(await db.query(`select public.create_contract_draft_v3($1,$2,$3,$4,'90000000-0000-4000-8000-000000000004',$5,$6,'Product terms','Rendered body','Rendered terms',$7::jsonb,'terms-fixture-hash','telephone','{}','{}',p_binding_months=>$8,p_notice_months=>$9) as id`,[number,termsCustomer,LP,price,repairedDraft,termsIssuer,JSON.stringify({binding_months:binding,notice_months:notice,payment_terms_days:30,currency:'SEK'}),binding,notice])).rows[0].id;
const oldDraft=await termsDraft(basePrice.id,0,null,'TERMS-OLD');
const revisionKey='91000000-0000-4000-8000-000000000001';
const revisedPrice=(await db.query('select public.revise_product_contract_terms($1,$2,2,1,30,$3) as id',[LP,basePrice.id,revisionKey])).rows[0].id;
if((await db.query('select public.revise_product_contract_terms($1,$2,2,1,30,$3) as id',[LP,basePrice.id,revisionKey])).rows[0].id!==revisedPrice)throw Error('Price revision replay duplicated version');
await readinessDenied('select public.revise_product_contract_terms($1,$2,3,1,30,$3)',[LP,basePrice.id,revisionKey],'price_revision_idempotency_conflict');
await readinessDenied('select public.revise_product_contract_terms($1,$2,2,1,30,gen_random_uuid())',[LP,basePrice.id],'price_version_changed_reload');
await readinessDenied('select public.revise_product_contract_terms($1,$2,null,1,30,gen_random_uuid())',[LP,revisedPrice],'contract_required_price_value_missing:binding_months');
await readinessDenied(`select public.create_contract_draft_v3('TERMS-STALE',$1,$2,$3,'90000000-0000-4000-8000-000000000004',$4,$5,'Old price','Body','Terms','{\"binding_months\":0}'::jsonb,'stale-hash','telephone','{}','{}',p_binding_months=>0)`,[termsCustomer,LP,basePrice.id,repairedDraft,termsIssuer],'contract_current_price_required');
const newDraft=await termsDraft(revisedPrice,2,1,'TERMS-NEW');
const zeroPrice=(await db.query('select public.revise_product_contract_terms($1,$2,0,0,0,gen_random_uuid()) as id',[LP,revisedPrice])).rows[0].id;
await db.exec('reset role;');
const revisions=(await db.query(`select id,binding_months,notice_months,payment_terms_days,recurring_fee,setup_fee,variable_fees,discounts from public.product_price_versions where id=any($1::uuid[])`,[[basePrice.id,revisedPrice,zeroPrice,otherPrice]])).rows;
const oldRow=revisions.find(r=>r.id===basePrice.id),newRow=revisions.find(r=>r.id===revisedPrice),zeroRow=revisions.find(r=>r.id===zeroPrice),independentRow=revisions.find(r=>r.id===otherPrice);
if(oldRow.binding_months!==0||oldRow.notice_months!==null||newRow.binding_months!==2||newRow.notice_months!==1||zeroRow.binding_months!==0||zeroRow.notice_months!==0||zeroRow.payment_terms_days!==0||independentRow.binding_months!==12||independentRow.notice_months!==3)throw Error('Product-local terms leaked globally or lost zero/null semantics');
if(newRow.recurring_fee!=='49'||newRow.setup_fee!=='17'||JSON.stringify(newRow.variable_fees)!==JSON.stringify(oldRow.variable_fees)||JSON.stringify(newRow.discounts)!==JSON.stringify(oldRow.discounts))throw Error('Changing durations changed fees/discounts');
const frozenDrafts=(await db.query(`select c.id,c.binding_months,c.notice_months,v.price_version_id from public.contracts c join public.contract_versions v on v.id=c.active_version_id where c.id=any($1::uuid[])`,[[oldDraft,newDraft]])).rows;
if(frozenDrafts.find(r=>r.id===oldDraft).binding_months!==0||frozenDrafts.find(r=>r.id===oldDraft).price_version_id!==basePrice.id||frozenDrafts.find(r=>r.id===newDraft).binding_months!==2||frozenDrafts.find(r=>r.id===newDraft).notice_months!==1||frozenDrafts.find(r=>r.id===newDraft).price_version_id!==revisedPrice)throw Error('Existing agreement snapshot changed or new agreement bound to wrong price');
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${V}',false);`);
await readinessDenied('select public.revise_product_contract_terms($1,$2,1,1,30,gen_random_uuid())',[LP,zeroPrice],'product_manage_permission_required');
await db.exec(`select set_config('request.jwt.claim.sub','${B2}',false);`);
await readinessDenied('select public.revise_product_contract_terms($1,$2,1,1,30,gen_random_uuid())',[LP,zeroPrice],'product_not_found');
await db.exec('reset role;');
await db.query(`insert into public.product_price_versions(tenant_id,product_id,version,binding_months,notice_months,valid_from) values($1,$2,50,12,1,current_date+1)`,[LT,LP]);
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${LO}',false);`);
await readinessDenied('select public.revise_product_contract_terms($1,$2,1,1,30,gen_random_uuid())',[LP,zeroPrice],'scheduled_price_version_requires_review');
console.log('PASS: per-product versioned terms preserve independent products, fees and old agreement snapshots; exact new draft binding, zero/null semantics, idempotency, stale edit, required fields, future schedule and role/tenant denial enforced.');


// Customer -> approved template field definitions -> immutable agreement values.
await db.exec('reset role;');
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${LO}',false);`);
await db.query(`select public.set_customer_custom_field($1,'anlaggning_id','"001234567890123456"'::jsonb)`,[termsCustomer]);
const fieldDefinitions=[{id:'anlaggning_id',label:'Anläggnings-ID',type:'text',required:true,customerKey:'anlaggning_id'},{id:'antal',label:'Antal',type:'number',required:false}];
const fieldVersion=(await db.query(`select public.create_product_contract_template_version($1,'90000000-0000-4000-8000-000000000004','Kundfält','service','BOTH',null,null,'Avtal','Anläggning {{custom.anlaggning_id}}','Villkor','[]','{}',$2::jsonb) as id`,[LP,JSON.stringify({custom_fields:fieldDefinitions})])).rows[0].id;
await db.query('select public.approve_contract_template_version($1)',[fieldVersion]);
async function fieldDraft(snapshot,number){return db.query(`select public.create_contract_draft_v3($1,$2,$3,$4,'90000000-0000-4000-8000-000000000004',$5,$6,'Kundfält','Anläggning 001234567890123456','Villkor',$7::jsonb,'field-hash','telephone','{}','{}',p_binding_months=>0,p_notice_months=>0) as id`,[number,termsCustomer,LP,zeroPrice,fieldVersion,termsIssuer,JSON.stringify({binding_months:0,notice_months:0,custom_fields:snapshot})]);}
try{await fieldDraft(null,'FIELDS-NO-SNAPSHOT');throw Error('Missing custom snapshot accepted');}catch(e){if(!String(e.message).includes('contract_custom_snapshot_required'))throw e;}
try{await fieldDraft({definitions:fieldDefinitions,values:{}},'FIELDS-MISSING');throw Error('Required field missing accepted');}catch(e){if(!String(e.message).includes('contract_custom_value_required'))throw e;}
try{await fieldDraft({definitions:fieldDefinitions,values:{anlaggning_id:'123',unexpected:'x'}},'FIELDS-UNKNOWN');throw Error('Unknown field accepted');}catch(e){if(!String(e.message).includes('contract_custom_value_unknown'))throw e;}
try{await fieldDraft({definitions:fieldDefinitions,values:{anlaggning_id:'123',antal:'wrong'}},'FIELDS-TYPE');throw Error('Invalid number accepted');}catch(e){if(!String(e.message).includes('contract_custom_number_invalid'))throw e;}
const fieldContract=(await fieldDraft({definitions:fieldDefinitions,values:{anlaggning_id:'001234567890123456',antal:0}},'FIELDS-GOOD')).rows[0].id;
await db.query(`select public.set_customer_custom_field($1,'anlaggning_id','"Changed on customer"'::jsonb)`,[termsCustomer]);
await db.exec('reset role;');
const storedField=(await db.query(`select v.commercial_terms#>>'{custom_fields,values,anlaggning_id}' as meter,v.commercial_terms#>>'{custom_fields,values,antal}' as quantity,c.custom_fields->>'anlaggning_id' as current_value from public.contract_versions v join public.contracts a on a.id=v.contract_id join public.customers c on c.id=a.customer_id where a.id=$1`,[fieldContract])).rows[0];
if(storedField.meter!=='001234567890123456'||storedField.quantity!=='0'||storedField.current_value!=='Changed on customer')throw Error('Customer edit changed frozen contract fields or lost leading zero');
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${B2}',false);`);
await readinessDenied(`select public.set_customer_custom_field($1,'anlaggning_id','"foreign"'::jsonb)`,[termsCustomer],'customer_write_permission_required');
await db.exec(`select set_config('request.jwt.claim.sub','${V}',false);`);
await readinessDenied(`select public.set_customer_custom_field($1,'anlaggning_id','"viewer"'::jsonb)`,[termsCustomer],'customer_write_permission_required');
await db.exec(`select set_config('request.jwt.claim.sub','${LO}',false);`);
await readinessDenied(`select public.set_customer_custom_field($1,'bad.key','"x"'::jsonb)`,[termsCustomer],'customer_field_key_invalid');
await readinessDenied(`update public.contract_template_versions set signing_configuration='{"custom_fields":[]}' where id=$1`,[fieldVersion],'approved_template_version_is_immutable');
console.log('PASS: customer field write is authorized/tenant-scoped; DB enforces approved definitions, required/type/unknown values, leading-zero/zero preservation and immutable snapshots after customer edits.');


await db.exec('reset role;');
await db.exec(`create function pg_temp.fail_customer_field_audit() returns trigger language plpgsql as $$begin if new.action='customer.custom_field_updated' and new.after_data->>'key'='fault_probe' then raise exception 'field_audit_failed'; end if; return new; end$$;
 create trigger customer_field_audit_failure before insert on public.audit_logs for each row execute function pg_temp.fail_customer_field_audit();`);
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${LO}',false);`);
await readinessDenied(`select public.set_customer_custom_field($1,'fault_probe','"temporary"'::jsonb)`,[termsCustomer],'field_audit_failed');
await readinessDenied(`select public.set_customer_custom_field($1,'anlaggning_id','{"nested":"no"}'::jsonb)`,[termsCustomer],'customer_field_value_invalid');
await db.exec('reset role;drop trigger customer_field_audit_failure on public.audit_logs;');
if((await db.query(`select custom_fields ? 'fault_probe' as exists from public.customers where id=$1`,[termsCustomer])).rows[0].exists)throw Error('Failed audit left changed customer data');
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${LO}',false);`);
for(const invalidFields of [[{...fieldDefinitions[0],unexpected:'no'}],[fieldDefinitions[0],fieldDefinitions[0]],[{...fieldDefinitions[0],required:'yes'}]]) {
 try {await db.query(`select public.create_product_contract_template_version($1,'90000000-0000-4000-8000-000000000004','Bad fields','service','BOTH',null,null,'Avtal','Body','Terms','[]','{}',$2::jsonb)`,[LP,JSON.stringify({custom_fields:invalidFields})]);throw Error('Invalid field schema accepted');}
 catch(e){if(!String(e.message).includes('contract_custom_definitions_invalid'))throw e;}
}
await db.exec('reset role;');
console.log('PASS: custom customer data rolls back on audit failure; nested payloads, unknown schema properties, duplicate field IDs and nonboolean required flags are refused.');

// Incoming routing is opt-in, tied to an exact registered browser session.
await db.exec(`reset role;select set_config('request.jwt.claim.role','authenticated',false);update public.tenants set status='active',onboarding_status='active' where id='${T}';
 update public.telephony_policies set telephony_enabled=true,recording_enabled=false where tenant_id='${T}';`);
const inboundNumber=(await db.query(`insert into public.phone_numbers(tenant_id,number_e164,supports_voice,webhook_token_hash) values($1,'+46855550123',true,'inbound-test') returning id`,[T])).rows[0].id;
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${B}',false);`);
const incomingSession=(await db.query(`select public.open_webphone_session('sinch','inbound regression') as result`)).rows[0].result.sessionId;
await db.query(`select public.heartbeat_webphone_session($1,$2)`,[incomingSession,incomingSession]);
await readinessDenied('select public.configure_inbound_number($1,null,null,true)',[inboundNumber],'inbound_recipient_required');
await readinessDenied('select public.configure_inbound_number($1,$2,null,true)',[inboundNumber,V],'inbound_active_recipient_required');
await readinessDenied('select public.configure_inbound_number($1,$2,$3,true)',[inboundNumber,B,team],'inbound_recipient_not_in_team');
let incomingSequence=0;
async function incomingIce(id){
 await db.exec(`reset role;set role service_role;select set_config('request.jwt.claim.role','service_role',false);select set_config('request.jwt.claim.sub','',false);`);
 return (await db.query(`select public.ingest_sinch_voice_event('ice',$1,$2,$3::jsonb) as result`,[id,'inbound-event-'+(++incomingSequence),JSON.stringify({originationType:'pstn',to:{type:'number',endpoint:'+46855550123'},cli:'+46700009988'})])).rows[0].result;
}
if((await incomingIce('incoming-disabled')).connect)throw Error('Disabled number accepted incoming call');
await db.exec(`reset role;set role authenticated;select set_config('request.jwt.claim.role','authenticated',false);select set_config('request.jwt.claim.sub','${B}',false);`);
await db.query('select public.configure_inbound_number($1,$2,null,true)',[inboundNumber,B]);
await db.exec(`reset role;update public.telephony_policies set recording_enabled=true where tenant_id='${T}';`);
if((await incomingIce('incoming-recording')).connect)throw Error('Unimplemented mandatory incoming recording bypassed');
await db.exec(`reset role;update public.telephony_policies set recording_enabled=false where tenant_id='${T}';`);
const incomingDecision=await incomingIce('incoming-good');
if(!incomingDecision.connect||incomingDecision.sessionId!==incomingSession)throw Error('Explicit exact-session inbound route failed');
const replayIncoming=await incomingIce('incoming-good');
if(!replayIncoming.connect||replayIncoming.sessionId!==incomingSession||!replayIncoming.duplicate)throw Error('Duplicate incoming ICE created another route');
if((await incomingIce('incoming-busy')).connect)throw Error('Busy incoming seller accepted a second call');
await db.exec(`reset role;set role authenticated;select set_config('request.jwt.claim.role','authenticated',false);select set_config('request.jwt.claim.sub','${B2}',false);`);
await readinessDenied(`select public.inbound_call_command($1,'incoming-good','inspect')`,[incomingSession],'inbound_offer_not_found');
await db.exec(`select set_config('request.jwt.claim.sub','${B}',false);`);
await readinessDenied(`select public.inbound_call_command(gen_random_uuid(),'incoming-good','inspect')`,[],'inbound_offer_not_found');
await readinessDenied(`select public.inbound_call_command($1,'incoming-good','established')`,[incomingSession],'inbound_acceptance_required');
const inspected=(await db.query(`select public.inbound_call_command($1,'incoming-good','inspect') as result`,[incomingSession])).rows[0].result;
if(!inspected.available||inspected.from!=='+46700009988')throw Error('Authorized incoming inspection missing');
await db.query(`select public.inbound_call_command($1,'incoming-good','accept')`,[incomingSession]);
if((await db.query(`select public.inbound_call_command($1,'incoming-good','accept') as result`,[incomingSession])).rows[0].result.available)throw Error('Duplicate answer command accepted');
await db.query(`select public.inbound_call_command($1,'incoming-good','established')`,[incomingSession]);
await db.query(`select public.inbound_call_command($1,'incoming-good','end')`,[incomingSession]);
await db.exec(`reset role;set role service_role;select set_config('request.jwt.claim.role','service_role',false);select set_config('request.jwt.claim.sub','',false);`);
await db.query(`select public.ingest_sinch_voice_event('dice','incoming-good','incoming-final','{"result":"ANSWERED","duration":25}'::jsonb)`);
await db.query(`select public.ingest_sinch_voice_event('dice','incoming-good','incoming-late-conflict','{"result":"BUSY"}'::jsonb)`);
await db.exec('reset role;');
const inboundFinal=(await db.query(`select status,duration_seconds,metadata from public.calls where id=$1`,[inspected.callId])).rows[0];
if(inboundFinal.status!=='completed'||inboundFinal.duration_seconds!==25||inboundFinal.metadata.provider_answered!==true)throw Error('Provider final overwritten or client outcome not reconciled');
if((await db.query(`select count(*)::int as count from public.calls where external_call_id='incoming-good'`)).rows[0].count!==1)throw Error('Duplicate incoming history');
const expiryDecision=await incomingIce('incoming-expiry');
if(!expiryDecision.connect)throw Error('Ended incoming call retained seller seat');
await db.exec(`reset role;update private.inbound_call_routes set expires_at=now()-interval '1 second' where external_call_id='incoming-expiry';`);
if(!(await incomingIce('incoming-after-expiry')).connect)throw Error('Expired incoming offer kept seller blocked');
await db.exec(`reset role;set role authenticated;select set_config('request.jwt.claim.role','authenticated',false);select set_config('request.jwt.claim.sub','${B}',false);`);
await db.query('select public.configure_inbound_number($1,$2,null,false)',[inboundNumber,B]);
await readinessDenied(`select public.inbound_call_command($1,'incoming-after-expiry','accept')`,[incomingSession],'inbound_route_no_longer_available');
await denied(`select * from private.inbound_call_routes`,[]);
await db.exec('reset role;');
console.log('PASS: incoming opt-in/assignment, mandatory recording guard, exact session, duplicate ICE, busy seller, wrong tenant/session, answer-once, provider final, expiry recovery and policy revocation enforced.');

// Required recording must stop before the browser/provider side effect.
await db.exec(`reset role;select set_config('request.jwt.claim.role','service_role',false);`);
const recordingCall=(await db.query(`insert into public.calls(tenant_id,provider,user_id,direction,from_number,to_number,status,callback_token_hash,recording_enabled,purpose) values($1,'sinch',$2,'outbound','+46855550123','+46700009988','requested','recording-boundary',true,'customer_service') returning id`,[T,B])).rows[0].id;
const recordingAttempt=(await db.query(`insert into public.dial_attempts(tenant_id,call_id,seller_user_id,provider,source_number_e164,destination_number_e164,client_request_id,idempotency_key,status,expires_at) values($1,$2,$3,'sinch','+46855550123','+46700009988',gen_random_uuid(),'recording-boundary','requested',now()+interval '5 minutes') returning id`,[T,recordingCall,B])).rows[0].id;
await readinessDenied(`update public.dial_attempts set provider_request_started_at=now(),status='dial_requested' where id=$1`,[recordingAttempt],'recording_capture_not_ready');
const captureDecision=(await db.query(`select public.ingest_sinch_voice_event('ice','capture-blocked','capture-blocked-ice',$1::jsonb) as result`,[JSON.stringify({user:B,originationType:'MXP',to:{type:'number',endpoint:'+46700009988'}})])).rows[0].result;
if(captureDecision.connect!==false||captureDecision.reason!=='recording_capture_not_ready')throw Error('Mandatory recording bypassed at signed callback boundary: '+JSON.stringify(captureDecision));
const captureReplay=(await db.query(`select public.ingest_sinch_voice_event('ice','capture-blocked','capture-blocked-ice',$1::jsonb) as result`,[JSON.stringify({user:B,originationType:'MXP',to:{type:'number',endpoint:'+46700009988'}})])).rows[0].result;
if(captureReplay.connect!==false)throw Error('Duplicate callback bypassed recording guard');
if((await db.query(`select count(*)::int as n from public.call_events where call_id=$1 and event_type='recording.capture_blocked'`,[recordingCall])).rows[0].n!==1)throw Error('Recording block audit duplicated');
console.log('PASS: required recording is denied before SDK claim and at provider ICE/replay; claim rolls back and block audit is idempotent.');

// Product creation audit is part of the initial-price transaction, not a later unchecked request.
await db.exec(`reset role;select set_config('request.jwt.claim.sub','${B}',false);select set_config('request.jwt.claim.role','authenticated',false);`);
const auditedProduct=(await db.query(`insert into public.products(tenant_id,name,configuration) values($1,'Audited generic product','{"_initial_price":{"recurring_fee":17,"binding_months":0,"notice_months":null,"payment_terms_days":0}}'::jsonb) returning id`,[T])).rows[0].id;
const productAudit=(await db.query(`select count(*)::int as n from public.audit_logs where tenant_id=$1 and entity_id=$2 and action='product.created' and actor_user_id=$3 and after_data->>'payment_terms_days'='0'`,[T,auditedProduct,B])).rows[0];
if(productAudit.n!==1)throw Error('Product initial-price audit missing, duplicated or lost zero');
await db.exec(`create function pg_temp.fail_product_audit() returns trigger language plpgsql as $$begin if new.action='product.created' then raise exception 'product_audit_failed'; end if; return new; end$$;create trigger product_audit_probe before insert on public.audit_logs for each row execute function pg_temp.fail_product_audit();`);
await readinessDenied(`insert into public.products(tenant_id,name,configuration) values($1,'Rollback product','{"_initial_price":{"recurring_fee":99}}')`,[T],'product_audit_failed');
if((await db.query(`select count(*)::int as n from public.products where tenant_id=$1 and name='Rollback product'`,[T])).rows[0].n!==0)throw Error('Product survived failed transactional audit');
if((await db.query(`select count(*)::int as n from public.product_price_versions p where p.tenant_id=$1 and not exists(select 1 from public.products x where x.tenant_id=p.tenant_id and x.id=p.product_id)`,[T])).rows[0].n!==0)throw Error('Failed product audit left an orphan price');
await db.exec('drop trigger product_audit_probe on public.audit_logs;');
console.log('PASS: generic product/initial price/one creation audit commit atomically, explicit zero preserved, audit failure rolls back product and price.');

// Complaint search: exact tenant/team, identity, date/time and platform audit.
await db.exec(`reset role;select set_config('request.jwt.claim.role','authenticated',false);select set_config('request.jwt.claim.aal','aal2',false);`);
const complaintCustomer=(await db.query(`insert into public.customers(tenant_id,customer_type,display_name,assigned_user_id) values($1,'company','Complaint Fixture Customer',$2) returning id`,[T,A])).rows[0].id;
await db.query(`update public.profiles set full_name='Complaint Fixture Seller' where id=$1`,[A]);
const complaintCalls=[];
for(const [owner,teamId,at] of [[A,team,'2026-11-17T09:30:00Z'],[B,otherTeam,'2026-11-17T10:45:00Z']]) {
 complaintCalls.push((await db.query(`insert into public.calls(tenant_id,customer_id,user_id,team_id,direction,from_number,to_number,status,callback_token_hash,started_at,answered_at,ended_at,duration_seconds,purpose) values($1,$2,$3,$4,'outbound','+46855559999','+46701234567','completed','complaint-fixture',$5::timestamptz,$5::timestamptz,$5::timestamptz+interval '25 seconds',25,'customer_service') returning id`,[T,complaintCustomer,owner,teamId,at])).rows[0].id);
}
const foreignComplaintCustomer=(await db.query(`insert into public.customers(tenant_id,customer_type,display_name,assigned_user_id) values($1,'company','Complaint Fixture Customer',$2) returning id`,[isolatedTenant,B2])).rows[0].id;
const foreignComplaintCall=(await db.query(`insert into public.calls(tenant_id,customer_id,user_id,direction,from_number,to_number,status,callback_token_hash,started_at,purpose) values($1,$2,$3,'outbound','+46855558888','+46707654321','completed','foreign-complaint','2026-11-17T09:40:00Z','customer_service') returning id`,[isolatedTenant,foreignComplaintCustomer,B2])).rows[0].id;
const histArgs=['Complaint Fixture Customer','2026-11-17T09:00:00Z','2026-11-17T12:00:00Z'];
async function history(q=histArgs[0],from=histArgs[1],to=histArgs[2],limit=50,offset=0,platform=false){return (await db.query('select public.search_call_history($1,$2,$3,$4,$5,$6) as result',[q,from,to,limit,offset,platform])).rows[0].result;}
await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${B}',false);`);
let foundHistory=await history();if(foundHistory.total!==2||foundHistory.data[1].seller_name!=='Complaint Fixture Seller'||foundHistory.data[1].duration_seconds!==25)throw Error('Owner complaint history missing identity/time/outcome');
if((await history('0701234567')).data.filter(c=>complaintCalls.includes(c.id)).length!==2)throw Error('National phone search normalization failed');
if((await history('Complaint Fixture Seller')).data.filter(c=>complaintCalls.includes(c.id)).length!==1)throw Error('Seller name search failed');
if((await history(histArgs[0],'2026-11-17T09:00:00Z','2026-11-17T10:00:00Z')).total!==1)throw Error('Time window did not select the matching conversation');
foundHistory=await history(histArgs[0],histArgs[1],histArgs[2],1,20);if(foundHistory.total!==2||foundHistory.data.length!==0)throw Error('Empty later page lost total');
await db.exec(`reset role;begin;update public.team_members set role='manager' where tenant_id='${T}' and team_id='${team}' and user_id='${A}';update public.tenant_memberships set role='team_lead' where tenant_id='${T}' and user_id='${A}';commit;set role authenticated;select set_config('request.jwt.claim.sub','${A}',false);`);
foundHistory=await history();if(foundHistory.total!==1||foundHistory.data[0].seller_id!==A)throw Error('Team leader history crossed team boundary');
await readinessDenied('select public.search_call_history($1,$2,$3,50,0,true)',histArgs,'platform_call_search_permission_required');
await db.exec(`select set_config('request.jwt.claim.sub','${B2}',false);`);
const foreignHistory=await history();if(foreignHistory.total!==1||foreignHistory.data[0].id!==foreignComplaintCall)throw Error('Another tenant saw complaint call history');
await db.exec(`reset role;insert into public.platform_memberships(user_id,role,status) values('${B}','platform_admin','active');set role authenticated;select set_config('request.jwt.claim.sub','${B}',false);select set_config('request.jwt.claim.aal','aal1',false);`);
await readinessDenied('select public.search_call_history($1,$2,$3,50,0,true)',histArgs,'platform_call_search_permission_required');
await db.exec(`select set_config('request.jwt.claim.aal','aal2',false);`);
if((await history(histArgs[0],histArgs[1],histArgs[2],50,0,true)).total!==3)throw Error('Authorized platform complaint search failed');
await readinessDenied(`select public.search_call_history('x',null,null,50,0,true)`,[],'call_search_filters_invalid');
await readinessDenied(`select public.search_call_history('',now(),now()-interval '1 day',50,0,true)`,[],'call_search_filters_invalid');
await readinessDenied(`select public.search_call_history('',now()-interval '400 days',now(),50,0,true)`,[],'call_search_filters_invalid');
await db.exec('reset role;');
const histAudit=(await db.query(`select after_data from public.audit_logs where action='calls.history_searched' and actor_user_id=$1 order by id desc limit 1`,[B])).rows[0].after_data;
if(histAudit.platform!==true||JSON.stringify(histAudit).includes('Complaint'))throw Error('Complaint audit missing or copied private search text');
await db.exec(`create function pg_temp.fail_call_search_audit() returns trigger language plpgsql as $$begin if new.action='calls.history_searched' then raise exception 'call_search_audit_failed'; end if; return new; end$$;create trigger complaint_audit_probe before insert on public.audit_logs for each row execute function pg_temp.fail_call_search_audit();set role authenticated;`);
await readinessDenied('select public.search_call_history($1,$2,$3,50,0,true)',histArgs,'call_search_audit_failed');
await db.exec('reset role;drop trigger complaint_audit_probe on public.audit_logs;');
console.log('PASS: complaint search by customer/national phone/seller/time, stable pagination, tenant/team isolation, MFA-gated platform access and fail-closed private audit.');

await db.close();
