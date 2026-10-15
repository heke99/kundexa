import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export async function verifyPostgisExtentPrivileges(db) {
  // PGlite has no PostGIS C module. Use real PostgreSQL roles/function ACLs and
  // extension dependencies, with harmless SQL bodies standing in for the three
  // advisor-confirmed functions. Catalog changes exist only inside this rollback.
  const migration=await readFile(new URL('../supabase/migrations/202610150009_postgis_extent_anonymous_execute.sql',import.meta.url),'utf8');
  const sql=migration.replace(/^begin;\s*/i,'').replace(/commit;\s*$/i,'');
  const signatures=['public.st_estimatedextent(text,text)','public.st_estimatedextent(text,text,text)','public.st_estimatedextent(text,text,text,boolean)'];
  await db.exec('begin');
  try {
    await db.exec(`create role extent_declared_role nologin;
      create function public.st_estimatedextent(text,text) returns text language sql security definer set search_path=public as $$ select 'extent-two'::text $$;
      create function public.st_estimatedextent(text,text,text) returns text language sql security definer set search_path=public as $$ select 'extent-three'::text $$;
      create function public.st_estimatedextent(text,text,text,boolean) returns text language sql security definer set search_path=public as $$ select 'extent-four'::text $$;
      create function public.st_estimatedextent(text,text,text,integer) returns text language sql security definer set search_path=public as $$ select 'untargeted-overload'::text $$;
      create function public.extent_unrelated_application_rpc() returns text language sql security definer set search_path=public as $$ select 'unrelated'::text $$;
      alter extension citext add function public.st_estimatedextent(text,text);
      alter extension citext add function public.st_estimatedextent(text,text,text);
      alter extension citext add function public.st_estimatedextent(text,text,text,boolean);
      alter extension citext add function public.st_estimatedextent(text,text,text,integer);
      update pg_extension set extname='postgis' where extname='citext';
      grant execute on function public.st_estimatedextent(text,text) to extent_declared_role;
      revoke execute on function public.st_estimatedextent(text,text,text) from public;
      grant execute on function public.st_estimatedextent(text,text,text) to anon,authenticated;
      revoke execute on function public.st_estimatedextent(text,text,text,boolean) from public;
      grant execute on function public.st_estimatedextent(text,text,text,boolean) to anon,service_role;
    `);
    const fingerprint=async()=> (await db.query(`select p.oid::regprocedure::text as signature,p.prosrc,p.proowner,p.proconfig,p.prosecdef
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='st_estimatedextent' order by 1`)).rows;
    const before=await fingerprint();
    await db.exec(sql);
    for (const [i,signature] of signatures.entries()) {
      const access=(await db.query(`select has_function_privilege('anon',$1,'execute') as anon,
        has_function_privilege('authenticated',$1,'execute') as authenticated,
        has_function_privilege('service_role',$1,'execute') as service_role`,[signature])).rows[0];
      assert.equal(access.anon,false,signature);
      assert.equal(access.authenticated,i!==2,`${signature}: preserve authenticated access exactly`);
      assert.equal(access.service_role,i!==1,`${signature}: preserve service_role access exactly`);
    }
    assert.deepEqual(await fingerprint(),before,'Function bodies, ownership, security mode and search paths remain unchanged');
    for (const signature of ['public.st_estimatedextent(text,text,text,integer)','public.extent_unrelated_application_rpc()']) {
      assert.equal((await db.query(`select has_function_privilege('anon',$1,'execute') as allowed`,[signature])).rows[0].allowed,true,'Untargeted overloads/application RPCs are not touched');
    }
    assert.equal((await db.query(`select has_function_privilege('extent_declared_role',$1,'execute') as allowed`,[signatures[0]])).rows[0].allowed,true,'Other explicit ACLs are retained');
    await db.exec('savepoint anon_extent_call; set local role anon');
    let denied=''; try { await db.query(`select public.st_estimatedextent('public','customers')`); } catch(error) { denied=String(error); }
    await db.exec('rollback to anon_extent_call; release anon_extent_call');
    assert.match(denied,/permission denied/,'An actual anon invocation is denied');
    await db.exec('savepoint authenticated_extent_call; set local role authenticated');
    assert.equal((await db.query(`select public.st_estimatedextent('public','customers') as extent`)).rows[0].extent,'extent-two');
    await db.exec('rollback to authenticated_extent_call; release authenticated_extent_call');
    await db.exec(sql); // Forward migration is safe to replay.
    assert.deepEqual(await fingerprint(),before);
    console.log('PostGIS extent ACL PASS: anonymous calls denied, exact authenticated/service access and explicit third-role ACLs preserved; application RPCs, unrelated overloads and function definitions untouched. Actual PostGIS C execution: NOT RUN.');
  } finally { await db.exec('rollback'); }
}
