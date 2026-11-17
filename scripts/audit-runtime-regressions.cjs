const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const base=require('node:path').resolve(__dirname,'..')+'/';
const ts=require(base+'node_modules/typescript'),React=require(base+'node_modules/react');
const {renderToStaticMarkup}=require(base+'node_modules/react-dom/server');
function load(file,mocks){const exp={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(base+file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports:exp,require:id=>{if(id in mocks)return mocks[id];if(id==='react/jsx-runtime')return require(base+'node_modules/react/jsx-runtime');throw Error('unmocked '+id)},console,URL,Response,Request,Blob,Buffer,Date,AbortSignal,fetch:(...a)=>testFetch(...a),crypto:require('node:crypto').webcrypto});return exp;}
function chain(data){const c={then:(r,j)=>Promise.resolve({data,error:null}).then(r,j)};for(const k of ['select','eq','single','maybeSingle','contains','in','order','limit'])c[k]=()=>c;return c;}
let testFetch;
(async()=>{
const events=[];
const scheduler=load('src/lib/workers/scheduled-edge-worker.ts',{'@/lib/env':{serverEnv:()=>({CRON_SECRET:'fixture',NEXT_PUBLIC_SUPABASE_URL:'https://fixture.invalid'})},'@/lib/supabase/admin':{createAdminClient:()=>({rpc:async(_,p)=>{events.push(p);return {error:null}}})}});
for(const body of ['invalid',null]){
 events.length=0;
 testFetch=async()=>body===null?{ok:true,text:async()=>{throw Error('broken body')}}:new Response(body,{status:200});
 let error;try{await scheduler.invokeScheduledEdgeWorker('data-worker')}catch(e){error=e}
 assert(error);assert.equal(events.at(-1).p_status,'failed');
}
testFetch=async()=>Response.json({results:[],claimed:0});
assert.equal((await scheduler.invokeScheduledEdgeWorker('data-worker')).status,'healthy');
const auth=load('src/app/auth/confirm/route.ts',{'next/server':{NextResponse:{redirect:url=>url.toString()}},'@/lib/supabase/server':{createClient:async()=>({auth:{verifyOtp:async()=>({error:null})}})}});
for(const next of ['/\\evil.example','//evil.example','/app']){
 const url=new URL('https://fixture.invalid/auth/confirm');url.searchParams.set('token_hash','fixture');url.searchParams.set('type','invite');url.searchParams.set('next',next);
 const dest=await auth.GET({url:url.toString()});assert.equal(new URL(dest).origin,'https://fixture.invalid');
}
console.log('PASS: invalid/broken worker response fails, valid result healthy, auth return stays same-origin.');
})().catch(e=>{console.error(e);process.exitCode=1});
