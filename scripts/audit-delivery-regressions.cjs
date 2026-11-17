const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const base=require('node:path').resolve(__dirname,'..')+'/',ts=require(base+'node_modules/typescript');
const reads=[],rpcs=[],smsSubmissions=[],emailSubmissions=[]; let tenantStatus='suspended', allowed=false;
let submittedId=null;
const email={id:'email',customer_id:'blocked-customer',contract_id:null,status:'queued',provider_message_id:null,attachments:[],to_addresses:['fixture@example.test'],subject:'Fixture',body_text:'Fixture',idempotency_key:'fixture-key'};
const sms={id:'sms',customer_id:'blocked-customer',contract_id:null,status:'queued',provider_message_id:null,from_number:'+46700000001',to_number:'+46700000002',body:'Fixture',updated_at:new Date().toISOString()};
function chain(data,table){const c={then:(r,j)=>Promise.resolve({data,error:null}).then(r,j)};for(const m of ['select','eq','single','maybeSingle','limit','is','order'])c[m]=()=>c;c.update=()=>c;return c;}
const supabase={from:t=>{reads.push(t);const rows={contract_deliveries:null,email_messages:email,sms_messages:sms,tenant_features:{enabled:true},tenants:{name:'Fixture',legal_name:'Fixture AB',status:tenantStatus},tenant_integrations:{status:'active',provider:'sinch',credentials_ciphertext:null},phone_numbers:{webhook_token_ciphertext:'fixture'}};if(!(t in rows))throw Error('unexpected read '+t);return chain(rows[t],t);},rpc:async(name,p)=>{rpcs.push({name,p});if(name==='evaluate_contact_policy_for_tenant')return {data:{allowed},error:null};if(name==='prepare_sms_submission'){if(p.p_worker==='old-worker')return {error:{message:'outbox_lease_lost'}};return {data:{from:sms.from_number,to:sms.to_number,body:sms.body,clientReference:sms.id},error:null};}if(name==='prepare_email_submission')return {data:p.p_payload,error:null};if(name==='renew_outbox_lease'&&p.p_worker==='old-worker')return {error:{message:'outbox_lease_lost'}};if(name==='record_sms_submission'){if(submittedId&&submittedId!==p.p_provider_message_id)return {error:{message:'sms_submission_binding_mismatch'}};submittedId=p.p_provider_message_id;}return {data:true,error:null};}};
let arrived=0,release;const gate=new Promise(r=>release=r);
const provider={findSubmitted:async()=>null,send:async p=>{smsSubmissions.push(p);const id='sms-provider-'+smsSubmissions.length;return {providerMessageId:id,status:'sent',sentAt:new Date().toISOString(),parts:1};}};
const env={APP_URL:'https://fixture.example.test',RESEND_API_KEY:'fake-key',DEFAULT_EMAIL_FROM_ADDRESS:'sender@example.test',SMS_SERVICE_PLAN_ID:'fake-plan',SMS_API_TOKEN:'fake-token'};
const modules={'../_shared/pinned-webhook.ts':{pinnedWebhookFetch:()=>{throw Error('unexpected webhook')},webhookUrl:x=>new URL(x)},'../_shared/outbox-policy.ts':{permanentResendFailure:()=>false},'../_shared/crypto.ts':{decryptJson:async()=>({token:'fake-token'})},'../_shared/reminder-time.ts':{inQuietHours:()=>false},'../_shared/sms-provider.ts':{DEFAULT_SMS_PROVIDER:'sinch',smsProviderFor:()=>provider}};
const exp={},ctx={exports:exp,require:id=>id.startsWith('npm:')?{createClient:()=>supabase}:modules[id],Deno:{env:{get:k=>env[k]??'fixture'},serve:()=>{}},console,URL,Response,Headers,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,Date,setTimeout,clearTimeout,AbortSignal,AbortController,crypto:require('node:crypto').webcrypto,fetch:async(url,p)=>{assert.equal(url,'https://api.resend.com/emails');emailSubmissions.push(JSON.parse(p.body));return Response.json({id:'fake-provider-id'});}};
const source=fs.readFileSync(base+'supabase/functions/process-outbox/index.ts','utf8')+'\nexport {processEmail,processSms};';
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,ctx);
(async()=>{
const job={id:'job-email',tenant_id:'tenant',aggregate_id:'email',payload:{},locked_by:'worker',job_type:'email.send'};
await assert.rejects(exp.processEmail(job),/email_tenant_inactive/);assert.equal(emailSubmissions.length,0);
tenantStatus='active';await assert.rejects(exp.processEmail(job),/email_current_contact_policy_denied/);assert.equal(emailSubmissions.length,0);
allowed=true;await exp.processEmail(job);assert.equal(emailSubmissions.length,1);
const smsJob={...job,id:'job-sms',aggregate_id:'sms',job_type:'sms.send',attempts:2,locked_by:'old-worker'};
await assert.rejects(exp.processSms(smsJob),/outbox_lease_lost/);assert.equal(smsSubmissions.length,0);
await exp.processSms({...smsJob,locked_by:'current-worker'});assert.equal(smsSubmissions.length,1);
sms.status='submitting';sms.updated_at='2020-01-01T00:00:00Z';
await assert.rejects(exp.processSms({...smsJob,locked_by:'current-worker'}),/sms_submission_requires_provider_reconciliation/);assert.equal(smsSubmissions.length,1);
console.log('PASS: stale SMS worker cannot send; current worker sends; unknown prior submission never automatically resends.');
console.log('PASS: suspended tenant and current contact block prevent submission; authorized email sends once.');
})().catch(e=>{console.error(e);process.exitCode=1});
