const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
let failedTable=null,missingProfile=false,platformRole=null,filters=[],authReadError=null,hasActiveTeam=true;
const client={auth:{getUser:async()=>({data:{user:authReadError?null:{id:'user',email:'user@example.test'}},error:authReadError})},rpc:async name=>({data:name==='current_user_mfa_required'?false:[{must_change_password:false}],error:null}),from:table=>{const q=new Proxy({}, {get:(_o,key)=>{
 if(key==='then')return resolve=>resolve(result());
 if(key==='maybeSingle')return async()=>result();
 return (...args)=>{if(key==='eq')filters.push([table,...args]);return q;};
 }});function result(){return {error:failedTable===table?{code:'fixture-db-unavailable'}:null,data:table==='profiles'?(missingProfile?null:{active_tenant_id:'tenant'}):table==='platform_memberships'?(platformRole?{role:platformRole}:null):table==='tenant_memberships'?{role:'sales',primary_team_id:'team',tenants:{name:'Company',legal_name:'Company',status:'active',onboarding_status:'active'}}:table==='team_members'?(hasActiveTeam?[{team_id:'team'}]:[]):null};}return q;}};
const authRead={};new Function('exports',ts.transpileModule(fs.readFileSync('src/lib/security/auth-read-error.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(authRead);
const exportsObject={};new Function('exports','require',ts.transpileModule(fs.readFileSync('src/lib/auth.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exportsObject,id=>id==='react'?{cache:fn=>fn}:id==='next/navigation'?{redirect:path=>{throw Error('redirect:'+path);}}:id==='@/lib/security/mfa'?{enforceMfaGate:async()=>{}}:id==='@/lib/security/auth-read-error'?authRead:id==='@/lib/supabase/server'?{createClient:async()=>client}:{});
(async()=>{
 for(const [table,error] of [['profiles','workspace_context_unavailable'],['platform_memberships','workspace_context_unavailable'],['tenant_memberships','tenant_membership_unavailable'],['team_members','team_membership_unavailable']]){failedTable=table;await assert.rejects(exportsObject.getAppContext(),new RegExp(error));}
 failedTable=null;filters=[];assert.equal((await exportsObject.getAppContext()).tenantId,'tenant');
 assert(filters.some(x=>x[0]==='team_members'&&x[1]==='assignment_paused'&&x[2]===false));assert(filters.some(x=>x[0]==='team_members'&&x[1]==='teams.status'&&x[2]==='active'));
 hasActiveTeam=false;const withoutTeam=await exportsObject.getAppContext();assert.deepEqual(withoutTeam.teamIds,[]);assert.equal(withoutTeam.primaryTeamId,null);hasActiveTeam=true;
 failedTable='platform_memberships';await assert.rejects(exportsObject.getPlatformContext(),/platform_context_unavailable/);
 failedTable=null;platformRole='platform_owner';assert.equal((await exportsObject.getPlatformContext()).platformRole,'platform_owner');
 const apiExports={};new Function('exports','require',ts.transpileModule(fs.readFileSync('src/lib/api-auth.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(apiExports,id=>id==='@/lib/security/auth-read-error'?authRead:id==='@/lib/supabase/server'?{createClient:async()=>client}:id==='@/lib/supabase/admin'?{createAdminClient:()=>({from:()=>{const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:{status:'active',onboarding_status:'active'},error:null})};return q;},rpc:async()=>({data:true,error:null})})}:id==='@/lib/permissions'?{apiScopePermission:{},can:()=>true}:{});
 for(const [table,error] of [['profiles','workspace_context_unavailable'],['tenant_memberships','tenant_membership_unavailable']]) {
  failedTable=table;let response;try{await apiExports.authenticateRequest(new Request('https://fixture.invalid'));}catch(e){response=e;}
  assert.equal(response.status,503);assert.equal((await response.json()).error,error);
 }
 failedTable=null;assert.equal((await apiExports.authenticateRequest(new Request('https://fixture.invalid'))).tenantId,'tenant');
 for(const authError of [{status:503},{status:0},{name:'AuthRetryableFetchError'}]) {
  authReadError=authError;await assert.rejects(exportsObject.getAppContext(),/authentication_service_unavailable/);await assert.rejects(exportsObject.getPlatformContext(),/authentication_service_unavailable/);
  let unavailable;try{await apiExports.authenticateRequest(new Request('https://fixture.invalid'));}catch(e){unavailable=e;}assert.equal(unavailable.status,503);
 }
 authReadError={status:401};await assert.rejects(exportsObject.getAppContext(),/redirect:\/login/);
 authReadError=null;
 platformRole=null;missingProfile=true;await assert.rejects(exportsObject.getAppContext(),/redirect:\/onboarding/);
 let missingResponse;try{await apiExports.authenticateRequest(new Request('https://fixture.invalid'));}catch(e){missingResponse=e;}assert.equal(missingResponse.status,403);assert.equal((await missingResponse.json()).error,'active_tenant_required');
 const oldUrl=process.env.NEXT_PUBLIC_SUPABASE_URL,oldKey=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
 process.env.NEXT_PUBLIC_SUPABASE_URL='https://project.example.test';process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY='fixture';
 class ProxyResponse extends Response {constructor(body,init){super(body,init);this.cookies={set:()=>{}};}static next(){return new ProxyResponse(null,{status:200});}static redirect(url){return new ProxyResponse(null,{status:307,headers:{location:url.toString()}});}}
 const proxyExports={};new Function('exports','require',ts.transpileModule(fs.readFileSync('src/lib/supabase/proxy.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(proxyExports,id=>id==='@/lib/security/auth-read-error'?authRead:id==='@supabase/ssr'?{createServerClient:()=>client}:id==='next/server'?{NextResponse:ProxyResponse}:id==='@/lib/call-workspace/frame-policy'?{contractFrameAncestors:()=>"frame-ancestors 'self'"}:id==='@/lib/telephony/webphone/connect-sources'?{webphoneConnectSources:[]}:{});
 function requestFor(path){const u=new URL('https://fixture.invalid'+path);u.clone=()=>new URL(u);return {nextUrl:u,headers:new Headers(),cookies:{getAll:()=>[],set:()=>{}}};}
 try {
  authReadError={status:503};const unavailable=await proxyExports.updateSession(requestFor('/app/customers'));assert.equal(unavailable.status,503);assert.equal(unavailable.headers.get('location'),null);assert((await unavailable.text()).includes('Försök igen'));
  assert.equal((await proxyExports.updateSession(requestFor('/'))).status,200,'Public pages remain reachable during Auth outage');
  authReadError={status:401};assert.equal((await proxyExports.updateSession(requestFor('/app'))).status,307,'Real missing session still requires login');
 }finally {authReadError=null;if(oldUrl===undefined)delete process.env.NEXT_PUBLIC_SUPABASE_URL;else process.env.NEXT_PUBLIC_SUPABASE_URL=oldUrl;if(oldKey===undefined)delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY=oldKey;}
 console.log('PASS: actual context readers preserve DB errors, deny partial team authority, filter inactive/paused teams, retain legitimate onboarding and avoid platform error redirects.');
})().catch(e=>{console.error(e);process.exitCode=1;});
