const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
function load(file,mocks={}){const exports={};new Function('exports','require',ts.transpileModule(fs.readFileSync(file,'utf8'),{fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports,id=>id in mocks?mocks[id]:require(id));return exports;}
const {recordingPlaybackPath}=load('src/lib/telephony/recording-playback.ts');
assert.equal(recordingPlaybackPath('tenant','call','tenant/call/audio.wav'),'tenant/call/audio.wav');
for(const path of ['foreign/call/audio.wav','tenant/other/audio.wav','tenant/call/../other/audio.wav','tenant/call/%2e%2e/audio.wav','tenant/call//audio.wav','tenant/call/audio.wav?token=x','tenant/call/audio.wav#x',null])assert.throws(()=>recordingPlaybackPath('tenant','call',path),/scope_invalid/);
async function main(){
 const route=load('src/app/api/v1/calls/start/route.ts',{'@/lib/auth':{getAppContext:async()=>({role:'sales',tenantId:'tenant',userId:'seller'})},'@/lib/permissions':{assertPermission:()=>{}},'@/lib/api-correlation':{getCorrelationId:()=>null,apiJson:(_c,body,init)=>({body,status:init.status})},'@/lib/supabase/admin':{createAdminClient:()=>({from:table=>{const result=table==='webphone_sessions'?{data:{id:'session'},error:null}:{data:null,error:{message:'recording_capture_not_ready'}};const q=new Proxy({maybeSingle:async()=>result},{get:(obj,key)=>key in obj?obj[key]:()=>q});return q;}})}});
 const result=await route.POST({json:async()=>({callId:'11111111-1111-4111-8111-111111111111',attemptId:'22222222-2222-4222-8222-222222222222',webphoneSessionId:'33333333-3333-4333-8333-333333333333'})});
 assert.equal(result.status,409);assert.equal(result.body.sdkStartAllowed,false);assert.equal(result.body.error,'RECORDING_CAPTURE_NOT_READY');
 console.log('PASS: recording path is exact tenant/call scope; mandatory capture rejection is definite and cannot authorize SDK dialing.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
