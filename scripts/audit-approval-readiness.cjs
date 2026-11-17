const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'..'),ts=require(path.join(root,'node_modules/typescript'));
function load(file,mocks={}){const exp={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:exp,require:id=>{if(id in mocks)return mocks[id];throw Error(id)}});return exp;}
const template=load('src/lib/domain/template.ts'),{contractApprovalProblems:check}=load('src/lib/contracts/approval-readiness.ts',{'@/lib/domain/template':template});
const input={productId:'product',productActive:true,title:'Avtal',body:'Pris {{price.recurring_fee}}',terms:'Avtalet gäller i {{price.binding_months}} månader.',price:{recurring_fee:100,binding_months:12}};
assert.equal(check(input).length,0);assert(check({...input,productId:null}).some(p=>p.includes('Koppla')));assert(check({...input,terms:'Här ska de slutliga villkoren anges.'}).some(p=>p.includes('instruktionstext')));assert(check({...input,price:{recurring_fee:100,binding_months:null}}).some(p=>p.includes('binding_months')));assert.equal(check({...input,terms:'Bindningstid: {{price.binding_months?Ingen angiven}}',price:{recurring_fee:100,binding_months:null}}).length,0);assert.equal(check({...input,price:{recurring_fee:0,binding_months:0}}).length,0);
console.log('PASS: approval preflight rejects unlinked/incomplete instructions and missing required price; explicit optional fields and zero values remain valid.');
assert(check({...input,title:'<p> </p>'}).some(p=>p.includes('titel')));
assert(check({...input,body:'<br>'}).some(p=>p.includes('titel')));

const {countSellableProducts}=load('src/lib/contracts/sellable-products.ts',{
  '@/lib/contracts/approval-readiness':{contractApprovalProblems:check},
  '@/lib/supabase/read':{ok:async q=>{const r=await q;if(r.error)throw Error('read_failed');return r;}}
});
const today=new Date().toISOString().slice(0,10);
const approved={status:'approved',title_template:input.title,body_template:input.body,terms_template:input.terms};
const tables={products:[{id:'good',active:true},{id:'future',active:true},{id:'expired',active:true},{id:'draft',active:true},{id:'incomplete',active:true},{id:'badterms',active:true}],
  contract_templates:['good','future','expired','draft','incomplete','badterms'].map(product_id=>({product_id,active:true,current_version_id:product_id,current_version:{...approved,...(product_id==='draft'?{status:'draft'}:{}),...(product_id==='badterms'?{terms_template:'TODO slutvillkor'}:{})}})),
  product_price_versions:['good','future','expired','draft','incomplete','badterms'].map(product_id=>({product_id,active:true,version:1,valid_from:product_id==='future'?'9999-01-01':'2000-01-01',valid_to:product_id==='expired'?'2001-01-01':null,recurring_fee:0,binding_months:product_id==='incomplete'?null:0}))};
function client(failure){return {from:table=>{
  let rows=tables[table].map(x=>({...x}));
  const q={select:()=>q,eq:(k,v)=>{rows=rows.filter(r=>r[k]===v);return q;},not:(k,op,v)=>{rows=rows.filter(r=>r[k]!==v);return q;},lte:(k,v)=>{assert.equal(v,today);rows=rows.filter(r=>r[k]<=v);return q;},or:v=>{assert(v.includes(today));rows=rows.filter(r=>r.valid_to===null||r.valid_to>=today);return q;},order:(k)=>{rows.sort((a,b)=>b[k]-a[k]);return q;},then:(resolve,reject)=>Promise.resolve({data:rows,error:table===failure?{message:'fixture error'}:null}).then(resolve,reject)};return q;
}};}
(async()=>{
 assert.equal(await countSellableProducts(client()),1,'Only approved, complete, effective product should be sellable');
 tables.product_price_versions.push({...tables.product_price_versions[0],version:2,binding_months:null});
 assert.equal(await countSellableProducts(client()),0,'Latest effective price is authoritative, no fallback to older complete price');
 for(const table of Object.keys(tables))await assert.rejects(countSellableProducts(client(table)),/read_failed/);
 console.log('PASS: dialer readiness rejects future/expired/draft/incomplete/instruction templates, preserves zero values, selects latest price and propagates DB read failures.');
})().catch(e=>{console.error(e);process.exitCode=1;});
