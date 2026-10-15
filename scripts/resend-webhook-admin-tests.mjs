import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source=ts.transpile(await readFile(new URL('../src/lib/email/resend-webhook-admin.ts',import.meta.url),'utf8'),{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022});
const api={};new Function('exports',source)(api);
const endpoint='https://app.example/api/webhooks/resend/private-path';const key='runtime-test-key-never-return';const calls=[];
let created=false;let unknown=false;let duplicates=false;
const provider=api.resendWebhookAdmin(key,async(url,options)=>{
 calls.push([String(url),options]); assert.equal(options.redirect,'error'); assert.equal(options.headers.Authorization,`Bearer ${key}`);
 const path=new URL(url).pathname;
 if(path==='/domains')return Response.json({data:[{name:'kundexa.se',status:'verified'}]});
 if(path==='/webhooks'&&options.method==='POST'){
   created=true;if(unknown)throw new Error('network_outcome_unknown');
   assert.deepEqual(JSON.parse(options.body),{endpoint,events:api.RESEND_DELIVERY_EVENTS});
   return Response.json({id:'webhook-one',signing_secret:'whsec_not_exposed'});
 }
 if(path==='/webhooks')return Response.json({has_more:false,data:created?[{id:'webhook-one',endpoint},...(duplicates?[{id:'webhook-two',endpoint}]:[])]:[]});
 if(path==='/webhooks/webhook-one')return Response.json({id:'webhook-one',endpoint,status:'enabled',events:api.RESEND_DELIVERY_EVENTS,signing_secret:'whsec_private_runtime_secret'});
 throw new Error(path);
});
assert.equal(await provider.inspectDomain('kundexa.se'),true);assert.equal(await provider.inspectDomain('other.example'),false);
await assert.rejects(provider.ensureWebhook(endpoint,false),/outcome_unconfirmed/);
assert.equal(calls.filter(([,options])=>options.method==='POST').length,0);
unknown=true;
await assert.rejects(provider.ensureWebhook(endpoint,true),/outcome_unknown/);
const recovered=await provider.ensureWebhook(endpoint,false);
assert.equal(recovered.id,'webhook-one');assert.equal(recovered.signingSecret,'whsec_private_runtime_secret');
assert.equal(calls.filter(([,options])=>options.method==='POST').length,1,'An unknown POST is recovered by exact endpoint, never repeated');
duplicates=true;await assert.rejects(provider.ensureWebhook(endpoint,true),/inventory_conflict/);
await assert.rejects(provider.ensureWebhook('http://app.example/unsafe',true),/endpoint_invalid/);
const actionSource=ts.transpile(await readFile(new URL('../src/app/actions/platform-email.ts',import.meta.url),'utf8'),{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022});
let providerCalls=0;const actionExports={};
new Function('require','exports',actionSource)(name=>{
 if(name==='zod')return {z:{uuid:()=>({}),object:()=>({parse:()=>({tenantId:'other',integrationId:'integration',requestId:'request'})})}};
 if(name.endsWith('/auth'))return {getAppContext:async()=>({role:'viewer',tenantId:'own',platformRole:null}),isPlatformAdmin:()=>false};
 if(name.endsWith('/resend-webhook-admin'))return {resendWebhookAdmin:()=>{providerCalls++;throw new Error('must not reach');}};
 if(name==='next/navigation')return {redirect:()=>{}};
 if(name==='next/cache')return {revalidatePath:()=>{}};
 return {};
},actionExports);
await assert.rejects(actionExports.registerPlatformResendWebhook(new FormData()),/integration_operator_required/);
assert.equal(providerCalls,0,'Unauthorized callers cannot perform any provider request');
console.log('Resend webhook operator: runtime credential transport, verified domain, exact endpoint reconciliation, one create after unknown response, duplicate rejection and authorization-before-provider PASS');
