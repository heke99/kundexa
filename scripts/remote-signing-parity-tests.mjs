import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role;create schema private;
create table tenants(id uuid primary key);create table signing_envelopes(tenant_id uuid,id uuid,unique(tenant_id,id));
create table contract_recipients(tenant_id uuid,id uuid,unique(tenant_id,id));`);
await db.exec(await readFile(new URL('../supabase/migrations/202610150011_disabled_legacy_signing_links_parity.sql',import.meta.url),'utf8'));
assert.equal((await db.query("select count(*)::int n from information_schema.columns where table_name='contract_signing_links'")).rows[0].n,9);
for(const role of ['anon','authenticated','service_role']) {
 assert.equal((await db.query(`select has_table_privilege('${role}','public.contract_signing_links','INSERT') p`)).rows[0].p,false);
}
await assert.rejects(db.exec("insert into contract_signing_links(id) values(gen_random_uuid())"),/remote_signing_links_retired/);
assert.equal((await db.query('select count(*)::int n from contract_signing_links')).rows[0].n,0);
await db.exec("update contract_signing_links set revoked_at=now() where revoked_at is null");
console.log('Legacy parity PASS: exact nine columns, no application role grants, owner insertion blocked, empty revocation harmless.');
await db.close();
