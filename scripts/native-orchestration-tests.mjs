import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceBytes = Buffer.from('%PDF-canonical-native-source');
const envelope = { id:randomUUID(),tenant_id:randomUUID(),contract_id:randomUUID(),contract_version_id:randomUUID(),generation:1,status:'sent',provider_evidence:{source_document_id:randomUUID(),source_sha256:hash(sourceBytes),recipient_name:'Test Signer',email:'test@example.test',expires_at:'2030-01-01T00:00:00.000Z'} };
const token='a'.repeat(43); envelope.provider_evidence.public_token_hash=hash(token+'pepper');
const storage=new Map([['source.pdf',sourceBytes]]);
const calls=[]; const rendered=[]; let claimError=false; let finalError=false;
const source={id:envelope.provider_evidence.source_document_id,sha256:hash(sourceBytes),storage_path:'source.pdf',file_name:'source.pdf',metadata:{locked_parties:{seller:{legal_name:'Test AB'}}}};
const admin={
  from(table) {
    const rows={signing_envelopes:envelope,tenants:{status:'active'},contracts:{title:'Native test',active_version_id:envelope.contract_version_id,acceptance_generation:1},contract_documents:source,contract_versions:{commercial_terms:{pdf_fields:{template:{fields:[{type:'signature',required:true}]}}}}};
    const builder=new Proxy({}, {get(_target,key){if(key==='then')return resolve=>Promise.resolve({data:rows[table],error:null}).then(resolve);return()=>builder;}});return builder;
  },
  storage:{from(){return {
    async upload(path,bytes){calls.push(['upload',path]);if(storage.has(path))return{error:new Error('exists')};storage.set(path,new Uint8Array(bytes));return{error:null};},
    async download(path){return storage.has(path)?{data:new Blob([storage.get(path)]),error:null}:{error:new Error('missing')};},
  };}},
  async rpc(name,args){
    calls.push([name,args]);
    if(name==='consume_rate_limit')return{data:true,error:null};
    if(name==='expire_native_signing')return{data:true,error:null};
    if(name==='claim_native_signature'){
      if(claimError)return{error:new Error('idempotency_conflict')};
      const p=args.p_input;
      if(!envelope.provider_evidence.native_signature)envelope.provider_evidence.native_signature={...p,recipient_name:envelope.provider_evidence.recipient_name,recipient_email:envelope.provider_evidence.email,receipt_id:randomUUID(),accepted_at:'2026-10-15T10:00:00.000Z',acceptance_text:'Locked consent',ip_address:'192.0.2.1',user_agent:'First receipt agent'};
      return{data:structuredClone(envelope),error:null};
    }
    if(name==='finalize_native_signature')return finalError?{error:new Error('DB interrupted')}:{data:{status:'signed'},error:null};
    throw new Error(name);
  },
};
const modules={
  zod:require('zod'),
  '@/lib/supabase/admin':{createAdminClient:()=>admin},
  '@/lib/env':{serverEnv:()=>({KUNDEXA_WEBHOOK_PEPPER:'pepper'}),canonicalAppBaseUrl:()=> 'https://app.example'},
  '@/lib/crypto':{sha256:hash,encryptJson:()=>'',decryptJson:()=>({}),randomToken:()=>token},
  '@/lib/contracts/document-hash':{stableJson:JSON.stringify,hashPdfBytes:hash},
  '@/lib/contracts/canonical-document':{},
  '@/lib/contracts/pdf-field-template':{validatePdfTemplate:value=>value},
  '@/lib/email/templates/contract-delivery':{},
  '@/lib/supabase/json':{toJson:value=>value},
  './native-document':{inspectNativeSignaturePng:()=>{},validateNativeSignerText:async()=>{},renderNativeSignedPdf:async input=>{rendered.push(input.receipt);return Buffer.from('signed:'+JSON.stringify(input.receipt));},renderNativeAuditPdf:async receipt=>Buffer.from('audit:'+JSON.stringify(receipt))},
};
const output=ts.transpile(await readFile(new URL('../src/lib/signing/orchestration.ts',import.meta.url),'utf8'),{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022});
const exports={};new Function('require','exports',output)(name=>{if(!(name in modules))throw new Error(name);return modules[name];},exports);
const input={signerName:'Test Signer',consent:true,signaturePng:'data:image/png;base64,'+Buffer.alloc(80,1).toString('base64'),idempotencyKey:randomUUID()};
finalError=true;
await assert.rejects(exports.submitNativeSignature(token,input,{ipAddress:'192.0.2.1',userAgent:'First receipt agent'}),/DB interrupted/);
assert.ok(envelope.provider_evidence.native_signature,'First receipt remains after finalization failure');
const firstReceipt=structuredClone(envelope.provider_evidence.native_signature);
assert.equal(calls.findIndex(([name])=>name==='claim_native_signature')<calls.findIndex(([name])=>name==='finalize_native_signature'),true);
finalError=false; envelope.provider_evidence.recipient_name='Changed live label';
assert.deepEqual(await exports.submitNativeSignature(token,input,{ipAddress:'192.0.2.99',userAgent:'Retry agent'}),{status:'signed'});
assert.deepEqual(rendered[0],rendered[1],'Retry derives bytes only from the first persisted receipt');
assert.equal(rendered[1].acceptedAt,firstReceipt.accepted_at);
assert.equal(rendered[1].recipientName,firstReceipt.recipient_name,'The locked organization remains the one captured with the first receipt');
const finalizeCalls=calls.filter(([name])=>name==='finalize_native_signature');
assert.deepEqual(finalizeCalls[0][1],finalizeCalls[1][1],'Identical signed and audit hashes and receipt binding on retry');
const finalInput=finalizeCalls[1][1].p_input;
assert.equal(finalInput.storage_path,`${envelope.tenant_id}/${envelope.contract_id}/${envelope.contract_version_id}/native/${firstReceipt.receipt_id}/signed.pdf`);
assert.equal(finalInput.audit_storage_path,`${envelope.tenant_id}/${envelope.contract_id}/${envelope.contract_version_id}/native/${firstReceipt.receipt_id}/audit.pdf`);
assert.equal(finalInput.receipt_id,firstReceipt.receipt_id);
assert.equal(finalInput.public_token_hash,envelope.provider_evidence.public_token_hash);
claimError=true;const before=rendered.length;
await assert.rejects(exports.submitNativeSignature(token,input,{ipAddress:null,userAgent:null}),/idempotency_conflict/);
assert.equal(rendered.length,before,'No document may be rendered after an unaccepted receipt');
await assert.rejects(exports.submitNativeSignature(token,{...input,consent:false},{ipAddress:null,userAgent:null}));
claimError=false; delete envelope.provider_evidence.native_signature;
envelope.provider_evidence.recipient_name='Exempel AB';
await exports.submitNativeSignature(token,{...input,signerName:'Anna Andersson',idempotencyKey:randomUUID()},{ipAddress:null,userAgent:null});
assert.equal(rendered.at(-1).signerName,'Anna Andersson','The actual human signer is distinct from the organization recipient');
assert.equal(rendered.at(-1).recipientName,'Exempel AB');
console.log('Native orchestration: first receipt before finalization, interruption recovery, identical final/audit hashes, source/token/receipt paths and actual human signer, organization recipient and rejected consent/idempotency PASS');

const submitRouteSource=ts.transpile(await readFile(new URL('../src/app/api/sign/[token]/submit/route.ts',import.meta.url),'utf8'),{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022});
const routeExports={};const routeCalls=[];
new Function('require','exports',submitRouteSource)(name=>name==='node:net'?require(name):name.endsWith('/orchestration')?{submitNativeSignature:async(...args)=>{routeCalls.push(args);return{status:'signed'};}}:(()=>{throw new Error(name);})(),routeExports);
let cancelled=false;
const oversized=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(500_000));controller.enqueue(new Uint8Array(500_000));},cancel(){cancelled=true;}});
const refusedBody=await routeExports.POST(new Request('https://app.example/api/sign/token/submit',{method:'POST',body:oversized,duplex:'half'}),{params:Promise.resolve({token})});
assert.equal(refusedBody.status,413);assert.equal(cancelled,true);assert.equal(routeCalls.length,0,'Chunked oversized input is rejected before signature processing');
const acceptedBody=await routeExports.POST(new Request('https://app.example/api/sign/token/submit',{method:'POST',headers:{'x-forwarded-for':'invalid'},body:JSON.stringify(input)}),{params:Promise.resolve({token})});
assert.equal(acceptedBody.status,200);assert.equal(routeCalls[0][2].ipAddress,null);
console.log('Native submit endpoint: actual chunked-byte limit, early stream cancellation and IP validation PASS');

const frozenReceipt=envelope.provider_evidence.native_signature;
delete envelope.provider_evidence.native_signature;
envelope.provider_evidence.expires_at='2020-01-01T00:00:00.000Z';
assert.deepEqual(await exports.continueNativeSigning(envelope.id),{envelopeId:envelope.id,status:'expired',replay:true});
assert.ok(calls.some(([name])=>name==='expire_native_signing'));
envelope.provider_evidence.native_signature=frozenReceipt;
claimError=false;
const expiryCount=calls.filter(([name])=>name==='expire_native_signing').length;
await exports.continueNativeSigning(envelope.id);
assert.equal(calls.filter(([name])=>name==='expire_native_signing').length,expiryCount,'A receipt accepted before expiry must complete without expiration');
console.log('Native recovery: expired unclaimed requests use atomic expiry; accepted receipts finish after expiry PASS');
