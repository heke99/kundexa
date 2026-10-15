import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const bytes=Buffer.from('%PDF-trusted-service-source');
const snapshotHash='a'.repeat(64);
let existing;
let stored=bytes;
let downloads=0;
const contract={id:'contract',tenant_id:'tenant',active_version_id:'version',source_call_id:'call',contract_number:'KX-UNIT'};
const admin={
  from(table) {
    const row={contracts:contract,contract_versions:{id:'version',commercial_terms:{}},calls:{id:'call',ended_at:'2026-10-15T10:00:00Z',disposition:'interested'},contract_documents:existing}[table];
    const builder=new Proxy({}, {get(_target,key){
      if (key==='single'||key==='maybeSingle') return async()=>({data:row,error:null});
      return ()=>builder;
    }}); return builder;
  },
  storage:{from(){return {async upload(){return {error:new Error('already exists')};},async download(){downloads++;return{data:new Blob([stored]),error:null};}};}},
};
const dependencies={
  '@/lib/contracts/canonical-contract-snapshot':{createCanonicalContractSnapshot:()=>({snapshot:{version:{commercial_terms:{}},seller:{legal_name:'Trusted AB'},counterparty:{display_name:'Recipient'}},snapshotHash})},
  '@/lib/contracts/generate-contract-pdf':{generateContractPdf:()=>bytes},
  '@/lib/supabase/admin':{createAdminClient:()=>admin},
  './pdf-field-template':{validatePdfTemplate:value=>value},
  './render-pdf-fields':{renderPdfFields:()=>{throw new Error('unexpected_render');}},
  './document-hash':{hashPdfBytes:hash},
  '@/lib/contracts/document-hash':{hashPdfBytes:hash},
};
const source=await readFile(new URL('../src/lib/contracts/canonical-document.ts',import.meta.url),'utf8');
const exports={};
new Function('require','exports',ts.transpile(source,{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}))(name=>{
  if (!(name in dependencies)) throw new Error(`unexpected_import:${name}`);
  return dependencies[name];
},exports);
const input={tenantId:'tenant',contractId:'contract',actorUserId:'actor'};
function document(origin,documentType='source_pdf',metadataHash=snapshotHash) {
  return{id:'document',document_type:documentType,sha256:hash(bytes),file_name:'contract.pdf',storage_path:'tenant/contract/source.pdf',size_bytes:bytes.length,
    metadata:{canonical:true,...(origin?{canonical_origin:origin}:{}),snapshot_hash:metadataHash}};
}
existing=document(null);
await assert.rejects(exports.ensureCanonicalContractDocument(admin,input),/canonical_document_origin_untrusted/);
assert.equal(downloads,0,'An untrusted source PDF never reaches privileged storage download');
existing=document('kundexa_author_upload_v1','source_pdf','wrong');
await assert.rejects(exports.ensureCanonicalContractDocument(admin,input),/contract_changed_after_preview/);
assert.equal(downloads,0,'Source PDFs require the exact current snapshot just like generated PDFs');
existing=document('kundexa_renderer_v1','generated_pdf'); stored=Buffer.from('%PDF-tampered-storage');
await assert.rejects(exports.ensureCanonicalContractDocument(admin,input),/canonical_document_stored_hash_mismatch/);
stored=bytes;
for(const [origin,type] of [['kundexa_renderer_v1','generated_pdf'],['kundexa_author_upload_v1','source_pdf']]) {
  existing=document(origin,type);
  const result=await exports.ensureCanonicalContractDocument(admin,input);
  assert.equal(result.id,'document'); assert.equal(result.sha256,hash(bytes)); assert.equal(result.snapshot_hash,snapshotHash);
}
existing=null; stored=Buffer.from('%PDF-attacker-preseeded-source');
await assert.rejects(exports.ensureCanonicalContractDocument(admin,input),/canonical_document_race_content_mismatch/);
console.log('Canonical origin tests PASS: preseeded storage collision rejected, untrusted source rejected, current snapshot required for uploads, stored bytes hash verified, trusted renderer and authorized author upload accepted.');
