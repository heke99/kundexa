process.on('uncaughtException', error => { console.error(error.message); process.exit(1); });
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


// Controlled database probes only: no external providers or customer messages.
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12,"0")}`;
const [ta,tb,owner,sales,viewer,ca,cb,contract,version,envelope,recipient,document] = Array.from({length:12},(_,i)=>id(i+1));
await db.exec(`grant select,insert,update,delete on public.customers,public.contracts,public.contract_versions,public.contract_recipients to authenticated;
grant usage on schema auth to authenticated;
begin; select set_config('request.jwt.claim.role','service_role',false);
insert into auth.users(id,email) values('${owner}','owner@example.test'),('${sales}','sales@example.test'),('${viewer}','viewer@example.test');
insert into public.tenants(id,slug,name,legal_name) values('${ta}','check-a','Check A','Check A AB'),('${tb}','check-b','Check B','Check B AB');
insert into public.teams(id,tenant_id,name) values('${id(30)}','${ta}','Check team');
insert into public.tenant_memberships(tenant_id,user_id,role,status) values('${ta}','${owner}','owner','active'),('${ta}','${sales}','sales','active'),('${ta}','${viewer}','viewer','active');
update public.tenant_memberships set primary_team_id='${id(30)}' where tenant_id='${ta}' and user_id='${sales}';
insert into public.team_members(tenant_id,team_id,user_id,is_primary) values('${ta}','${id(30)}','${sales}',true);
update public.profiles set active_tenant_id='${ta}' where id in ('${owner}','${sales}','${viewer}');
insert into public.customers(id,tenant_id,customer_type,display_name,assigned_user_id,created_by) values('${ca}','${ta}','company','Customer A','${sales}','${owner}'),('${cb}','${tb}','company','Customer B',null,null);
insert into public.contracts(id,tenant_id,customer_id,owner_user_id,contract_number,title,audience,acceptance_generation) values('${contract}','${ta}','${ca}','${sales}','CHECK-1','Check contract','B2B',1);
insert into public.contract_versions(id,tenant_id,contract_id,version,title,rendered_body,document_hash,signature_policy_snapshot) values('${version}','${ta}','${contract}',1,'Check','Check','check','{"method":"external_esign"}');
update public.contracts set active_version_id='${version}',status='signing' where id='${contract}';
insert into public.contract_documents(id,tenant_id,contract_id,contract_version_id,document_type,file_name,storage_path,mime_type,size_bytes,sha256) values('${document}','${ta}','${contract}','${version}','generated_pdf','check.pdf','check.pdf','application/pdf',10,repeat('a',64));
insert into public.contract_recipients(id,tenant_id,contract_id,full_name,email,generation) values('${recipient}','${ta}','${contract}','Check customer','customer@example.test',1);
insert into public.signing_envelopes(id,tenant_id,contract_id,contract_version_id,provider,provider_envelope_id,signature_policy,generation,status,provider_evidence) values('${envelope}','${ta}','${contract}','${version}','docuseal','123','{"method":"external_esign"}',1,'sent',jsonb_build_object('source_document_id','${document}','source_sha256',repeat('a',64)));
insert into public.signing_recipients(tenant_id,envelope_id,contract_recipient_id) values('${ta}','${envelope}','${recipient}');
insert into public.contract_signing_links(tenant_id,envelope_id,recipient_id,token_hash,token_ciphertext,expires_at) values('${ta}','${envelope}','${recipient}',repeat('b',64),'probe-only',now()+interval '1 day');
commit;
`);
let checks = 0;
async function assert(query, predicate, label) { const result=await db.query(query); if(!predicate(result)) throw new Error(label); checks++; console.log(`PASS ${label}`); }
async function denies(query, expected, label) { try { await db.query(query); } catch(e) { if(!String(e.message).includes(expected)) throw e; checks++; console.log(`PASS ${label}`); return; } throw new Error(label); }
async function user(uid) { await db.exec(`reset role; select set_config('request.jwt.claim.sub','${uid}',false); select set_config('request.jwt.claim.role','authenticated',false); set role authenticated;`); }
await user(sales);
await assert(`select id from public.customers where id='${cb}'`,r=>r.rows.length===0,'seller cannot read other tenant');
await assert(`update public.customers set display_name='Seller edit' where id='${ca}' returning id`,r=>r.rows.length===1,'seller can save assigned customer');
await assert(`update public.customers set display_name='Cross tenant' where id='${cb}' returning id`,r=>r.rows.length===0,'seller cannot update other tenant');
await denies(`update public.contracts set status='active' where id='${contract}'`,'controlled_contract_transition_required','seller cannot bypass activation');
await denies(`update public.contracts set value=1 where id='${contract}'`,'controlled_commercial_change_required','seller cannot override frozen price');
await denies(`update public.contract_versions set commercial_terms='{"price":1}' where id='${version}'`,'controlled_contract_version_required','seller cannot rewrite contract version');
await denies(`select * from public.contract_signing_links`,'permission denied','seller cannot enumerate signing tokens');
await denies(`select public.queue_docuseal_invitation('${ta}','${envelope}','a@example.test','Check','Check')`,'permission denied','seller cannot call service invitation RPC');
await user(viewer);
await assert(`update public.customers set display_name='Viewer edit' where id='${ca}' returning id`,r=>r.rows.length===0,'viewer cannot save customer');
await denies(`insert into public.customers(tenant_id,customer_type,display_name) values('${ta}','company','Viewer insertion')`,'row-level security','viewer cannot insert customer');
await db.exec(`reset role; select set_config('request.jwt.claim.role','service_role',false);`);
await assert(`select public.queue_docuseal_invitation('${ta}','${envelope}','from@example.test','Check','Check') as queued`,r=>r.rows[0].queued===true,'current generation queues invitation atomically');
await assert(`select public.queue_docuseal_invitation('${ta}','${envelope}','from@example.test','Check','Check') as queued`,r=>r.rows[0].queued===true,'invitation replay is idempotent');
await assert(`select count(*)::int n from public.email_messages where contract_id='${contract}'`,r=>r.rows[0].n===1,'one invitation after replay');
await db.exec(`update public.contracts set acceptance_generation=2 where id='${contract}';`);
await assert(`select public.queue_docuseal_invitation('${ta}','${envelope}','from@example.test','Check','Check') as queued`,r=>r.rows[0].queued===false,'superseded generation cannot queue invitation');
await assert(`select public.project_docuseal_terminal('${ta}','${envelope}','123','declined') as projected`,r=>r.rows[0].projected===true,'provider terminal state stored');
await assert(`select status from public.contracts where id='${contract}'`,r=>r.rows[0].status==='signing','old decline cannot change current contract');
await db.exec(`update public.contracts set acceptance_generation=1,status='signing' where id='${contract}';`);
await assert(`select public.project_docuseal_terminal('${ta}','${envelope}','123','declined') as projected`,r=>r.rows[0].projected===true,'current decline projected');
await assert(`select status from public.contracts where id='${contract}'`,r=>r.rows[0].status==='declined','seller sees declined status');
await denies(`select public.finalize_signing_envelope('${envelope}','${document}','{}')`,'contract_terminal','late completion cannot resurrect terminal contract');
await db.exec(`update public.outbox_jobs set status='processing',locked_by='owner-worker',locked_at=now(),attempts=1 where tenant_id='${ta}' and job_type='email.send';`);
await assert(`select public.settle_outbox_job(id,'wrong-worker') as settled from public.outbox_jobs where tenant_id='${ta}' and job_type='email.send'`,r=>r.rows[0].settled===false,'wrong worker cannot settle lease');
await assert(`select public.settle_outbox_job(id,'owner-worker') as settled from public.outbox_jobs where tenant_id='${ta}' and job_type='email.send'`,r=>r.rows[0].settled===true,'lease owner can settle job');
// Synthetic completion checks the database projection only, not a customer signature.
await db.exec(`update public.contracts set status='signing' where id='${contract}';
update public.signing_envelopes set status='sent' where id='${envelope}';
update public.signing_recipients set status='signed',signed_at=now() where envelope_id='${envelope}';
insert into public.signing_events(tenant_id,envelope_id,provider,provider_event_id,event_type,event_at,verified,processing_status,payload)
values('${ta}','${envelope}','docuseal','synthetic-completion','submission.completed',now(),true,'processed','{"synthetic":true}');
insert into public.contract_documents(id,tenant_id,contract_id,contract_version_id,document_type,file_name,storage_path,mime_type,size_bytes,sha256)
values('${id(40)}','${ta}','${contract}','${version}','signed_pdf','synthetic-signed.pdf','synthetic-signed.pdf','application/pdf',100,repeat('c',64));`);
await assert(`select public.finalize_signing_envelope('${envelope}','${id(40)}','{"synthetic":true}') as result`,r=>r.rows[0].result.status==='signed','completed envelope projects signed contract');
await assert(`select locked_at from public.contract_versions where id='${version}'`,r=>Boolean(r.rows[0].locked_at),'already bound policy is locked at completion');
await db.exec(`select set_config('request.jwt.claim.sub','${owner}',false); select set_config('request.jwt.claim.role','authenticated',false);`);
await assert(`select public.activate_completed_contract('${contract}') as result`,r=>r.rows[0].result.status==='active','owner can activate completed current evidence');
console.log(`${checks} controlled database probes PASS; hosted JWT/storage/provider flow NOT RUN`);
await db.close();
