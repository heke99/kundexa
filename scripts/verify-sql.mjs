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
  create table auth.users (id uuid primary key, email text);
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
await db.close();
