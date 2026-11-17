const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const base=require('node:path').resolve(__dirname,'..')+'/';
const ts=require(base+'node_modules/typescript'),React=require(base+'node_modules/react');
const {renderToStaticMarkup}=require(base+'node_modules/react-dom/server');
function load(file,mocks){const exp={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(base+file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports:exp,require:id=>{if(id in mocks)return mocks[id];if(id==='react/jsx-runtime')return require(base+'node_modules/react/jsx-runtime');throw Error('unmocked '+id)},console,URL,Response,Request,Blob,Buffer,Date,crypto:require('node:crypto').webcrypto});return exp;}
function chain(data){const c={then:(r,j)=>Promise.resolve({data,error:null}).then(r,j)};for(const k of ['select','eq','single','maybeSingle','contains','in','order','limit'])c[k]=()=>c;return c;}
(async()=>{
const identity=load('supabase/functions/_shared/organization-number.ts',{});
const worker={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(base+'supabase/functions/parsehub-worker/index.ts','utf8')+'\nexport {normalizeOrg,boundedValue};',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:worker,require:id=>id.includes('organization-number')?identity:id.startsWith('npm:')?{createClient:()=>({})}:{decryptJson:async()=>({})},Deno:{env:{get:()=> 'fixture'},serve:()=>{}},console});
const person=Array.from({length:10},(_,i)=>'900101001'+i).find(identity.passesLuhn);
assert.equal(worker.normalizeOrg(person),null);
const company=Array.from({length:10},(_,i)=>'559999999'+i).find(identity.passesLuhn);
assert.equal(worker.normalizeOrg(company),identity.normalizeOrganizationNumber(company).canonical);
assert.throws(()=>worker.boundedValue('x'.repeat(50001)),/too_large/);
assert.throws(()=>worker.boundedValue(Array(10001).fill(1)),/too_large/);
assert.equal(worker.boundedValue('valid'),'valid');
let role='owner',path='tenant/dsar/request/export.json';
const admin={from:t=>t==='audit_logs'?{insert:async()=>({error:null})}:chain({result_storage_path:path,identity_verified_at:'2026-11-16',request_type:'access'}),storage:{from:()=>({download:async()=>({data:new Blob(['{}']),error:null})})}};
const download=load('src/app/api/v1/compliance/exports/[id]/route.ts',{'@/lib/auth':{getAppContext:async()=>({role,tenantId:'tenant',userId:'owner'}),isAdmin:r=>['owner','admin'].includes(r)},'@/lib/supabase/admin':{createAdminClient:()=>admin}});
const invoke=()=>download.GET(new Request('https://fixture.invalid'),{params:Promise.resolve({id:'request'})});
assert.equal((await invoke()).status,200);path='other/dsar/request/export.json';assert.equal((await invoke()).status,404);role='viewer';assert.equal((await invoke()).status,403);
const route=load('src/app/api/v1/customers/route.ts',{'next/server':{NextResponse:{json:(body,init)=>({status:init?.status??200,body})}},zod:require(base+'node_modules/zod'),'@/lib/api-auth':{authenticateRequest:async()=>({tenantId:'tenant',userId:'sales',role:'sales',source:'session'}),dataClientForIdentity:async()=>({from:()=>{throw Error('must not replay legacy customer')}})},'@/lib/supabase/admin':{createAdminClient:()=>({from:()=>chain({entity_id:'old-customer'})})},'@/lib/domain/phone':{normalizePhone:x=>x},'@/lib/imports/organization-number':identity,'@/lib/postgrest-filter':{buildIlikeOrFilter:()=>''},'@/lib/crypto':{sha256:()=> 'hash'}});
const replay=await route.POST(new Request('https://fixture.invalid',{method:'POST',body:JSON.stringify({customer_type:'company',display_name:'Fixture customer',idempotency_key:'legacy-key'})}));assert.equal(replay.status,409);
const source=fs.readFileSync(base+'supabase/functions/process-outbox/index.ts','utf8');
const webhook=source.slice(source.indexOf('async function processWebhook('),source.indexOf('async function sha256Text('));
let tooLarge=true;let patch;
const c=data=>{const x=chain(data);x.update=p=>{patch=p;return x};return x};
const out={};vm.runInNewContext(ts.transpileModule(webhook+'\nexport { processWebhook as run };',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:out,supabase:{from:t=>c(t==='webhook_endpoints'?{active:true,url:'https://fixture.invalid',secret_ciphertext:'fixture'}:{id:'delivery',endpoint_id:'endpoint',event_id:'event',event_type:'fixture',payload:{},attempts:0})},assertSafeWebhookUrl:x=>new URL(x),decryptJson:async()=>({secret:'fixture'}),encryptionKey:'fixture',hmacSha256:async()=> 'hash',checked:async x=>{const r=await x;if(r.error)throw r.error;return r},pinnedWebhookFetch:async(_url,p)=>{assert(p.signal);return new Response(tooLarge?'x'.repeat(16385):'ok')},AbortSignal,TextDecoder,URL,Date});
await assert.rejects(out.run({tenant_id:'tenant',aggregate_id:'delivery'}),/webhook_response_too_large/);tooLarge=false;await out.run({tenant_id:'tenant',aggregate_id:'delivery'});assert.equal(patch.status,'completed');
console.log('PASS: shared identity rules, oversize refusal, scoped export download, legacy replay conflict, bounded webhook responses.');
})().catch(e=>{console.error(e);process.exitCode=1});
