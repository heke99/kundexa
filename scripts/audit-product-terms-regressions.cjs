const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript'),crypto=require('node:crypto');
function load(file,mocks={}){const exports={};const source=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},fileName:file}).outputText;new Function('exports','require','crypto',source)(exports,id=>{if(id in mocks)return mocks[id];if(['zod','pdf-lib','react/jsx-runtime','node:crypto'].includes(id))return require(id);return {};},globalThis.crypto);return exports;}
const schema=load('src/lib/products/contract-terms.ts').productContractTermsSchema;
assert.equal(schema.parse({bindingMonths:'0',noticeMonths:'0',paymentTermsDays:'0'}).bindingMonths,0);
assert.equal(schema.parse({bindingMonths:'',noticeMonths:'',paymentTermsDays:'30'}).noticeMonths,null);
for(const input of [{bindingMonths:'-1',noticeMonths:'1',paymentTermsDays:'30'},{bindingMonths:'2.5',noticeMonths:'1',paymentTermsDays:'30'},{bindingMonths:'2',noticeMonths:'121',paymentTermsDays:'30'}])assert.equal(schema.safeParse(input).success,false);
const {renderStrictTemplate}=load('src/lib/domain/template.ts');
const {buildTemplateRenderContext}=load('src/lib/contracts/template-context.ts');
const {normalizeVariableFees}=load('src/lib/contracts/price-terms.ts');
const stableJson=value=>JSON.stringify(value),sha256=value=>crypto.createHash('sha256').update(value).digest('hex');
let captured;
const today=new Date().toISOString().slice(0,10);
const prices=[{id:'future',tenant_id:'tenant',product_id:'product',active:true,valid_from:'9999-01-01',valid_to:null,version:99,binding_months:99,notice_months:99},{id:'expired',tenant_id:'tenant',product_id:'product',active:true,valid_from:'2000-01-01',valid_to:'2001-01-01',version:98,binding_months:98,notice_months:98},{id:'price',tenant_id:'tenant',product_id:'product',active:true,valid_from:'2000-01-01',valid_to:null,version:2,binding_months:2,notice_months:1,payment_terms_days:0,recurring_fee:49,currency:'SEK',setup_fee:0}];
const records={audit_logs:null,customers:{id:'customer',customer_type:'company',display_name:'Fixture'},tenant_legal_entities:{id:'issuer',legal_name:'Fixture'},contract_template_versions:{id:'version',template_id:'template',status:'approved',title_template:'{{contract.title}}',body_template:'Bindning {{price.binding_months}}',terms_template:'Uppsägning {{price.notice_months}}. Betalning {{price.payment_terms_days}}.',signing_configuration:{}},contract_templates:{id:'template',audience:'BOTH',active:true,current_version_id:'version'},products:{id:'product',name:'Product'}};
const admin={from:table=>{
 let rows=table==='product_price_versions'?[...prices]:null;
 const q={select:()=>q,eq:(key,value)=>{if(rows)rows=rows.filter(r=>r[key]===value);return q;},is:()=>q,like:()=>q,lte:(key,value)=>{assert.equal(value,today);rows=rows.filter(r=>r[key]<=value);return q;},or:value=>{assert(value.includes(today));rows=rows.filter(r=>r.valid_to===null||r.valid_to>=today);return q;},order:key=>{rows.sort((a,b)=>b[key]-a[key]);return q;},limit:()=>q,single:()=>q,maybeSingle:()=>q,then:(resolve,reject)=>Promise.resolve({data:rows?rows[0]??null:records[table],error:null}).then(resolve,reject)};return q;
},rpc:async(name,args)=>{assert.equal(name,'create_contract_draft_api_v2');captured=args;return {data:'new-contract',error:null};}};
const api=load('src/lib/contracts/api-service.ts',{'@/lib/supabase/admin':{createAdminClient:()=>admin},'@/lib/domain/template':{renderStrictTemplate},'./template-context':{buildTemplateRenderContext},'./document-hash':{stableJson},'@/lib/crypto':{sha256},'@/lib/contracts/pdf-field-template':{freezePdfTemplate:()=>null,freezeContractCustomFields:load('src/lib/contracts/pdf-field-template.ts').freezeContractCustomFields},'@/lib/contracts/price-terms':{normalizeVariableFees},'@/lib/supabase/json':{toJson:x=>x,toJsonObject:x=>x}});
async function productActionCheck(binding,notice){
 let saved;
 const products=load('src/app/actions/products.ts',{
  '@/lib/products/contract-terms':load('src/lib/products/contract-terms.ts'),
  '@/lib/auth':{getAppContext:async()=>({tenantId:'tenant',userId:'owner',role:'owner'})},
  '@/lib/permissions':{assertPermission:()=>{}},
  'next/cache':{revalidatePath:()=>{}},'next/navigation':{redirect:()=>{throw Error('REDIRECT');}},
  '@/lib/supabase/server':{createClient:async()=>({from:table=>({insert:row=>{
   if(table==='audit_logs')return Promise.resolve({error:null});
   saved=row;return {select:()=>({single:async()=>({data:{id:'product'},error:null})})};
  }})})},
 });
 const form=new FormData();for(const [key,value] of Object.entries({name:'Fixture product',product_type:'service',binding_months:binding,notice_months:notice,payment_terms_days:'30'}))form.set(key,value);
 try{await products.createProduct(form);}catch(e){if(e.message!=='REDIRECT')throw e;}
 return saved.configuration._initial_price;
}
async function productPageCheck(){
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
 const div=({children})=>React.createElement('div',null,children);
 const field=({label,...props})=>React.createElement('label',null,label,React.createElement('input',props));
 const productRows=[{id:'product-a',name:'Product A',active:true,product_price_versions:[{id:'price-a',active:true,valid_from:'2000-01-01',valid_to:null,version:1,binding_months:2,notice_months:1,payment_terms_days:30,recurring_fee:49,setup_fee:0},{id:'future-a',active:true,valid_from:'9999-01-01',valid_to:null,version:99,binding_months:99,notice_months:99}]},{id:'product-b',name:'Product B',active:true,product_price_versions:[{id:'price-b',active:true,valid_from:'2000-01-01',valid_to:null,version:1,binding_months:12,notice_months:3,payment_terms_days:15,recurring_fee:100,setup_fee:0}]}];
 const query=table=>{const q={select:()=>q,order:()=>q,eq:()=>q,not:()=>q,then:(resolve,reject)=>Promise.resolve({data:table==='products'?productRows:[],error:null}).then(resolve,reject)};return q;};
 const page=load('src/app/(dashboard)/app/products/page.tsx',{
  'next/link':{__esModule:true,default:({children,href})=>React.createElement('a',{href},children)},
  '@/lib/supabase/read':{ok:async q=>q},'@/components/icons':{Package:()=>null,Plus:()=>null},
  '@/lib/supabase/server':{createClient:async()=>({from:query})},'@/lib/auth':{getAppContext:async()=>({role:'owner'})},
  '@/app/actions/products':{createProduct:()=>{},reviseProductContractTerms:()=>{}},
  '@/components/ui/page-header':{PageHeader:()=>null},'@/components/ui/card':{Card:div,CardHeader:div,CardContent:div},
  '@/components/ui/data-table':{DataTable:({children})=>React.createElement('table',null,React.createElement('tbody',null,children))},
  '@/components/ui/form-field':{Field:field,SelectField:({label,children,...props})=>React.createElement('select',props,children),TextareaField:({label,...props})=>React.createElement('textarea',props)},
  '@/components/ui/badge':{Badge:div},'@/lib/utils':{formatCurrency:value=>String(value)},
  '@/lib/supabase/json':{readJsonObject:value=>value},'@/lib/permissions':{can:()=>true},
 });
 const html=renderToStaticMarkup(await page.default({searchParams:Promise.resolve({})}));
 const details=[...html.matchAll(/<details[^>]*>([\s\S]*?)<\/details>/g)].map(match=>match[1]);
 assert.equal(details.length,2);assert(details[0].includes('name="product_id" value="product-a"'));assert(details[0].includes('name="expected_price_id" value="price-a"'));assert(details[1].includes('name="product_id" value="product-b"'));assert(details[1].includes('name="expected_price_id" value="price-b"'));
 assert(details[0].match(/name="binding_months"[^>]*value="2"/));assert(details[1].match(/name="binding_months"[^>]*value="12"/));assert(!details[0].includes('future-a'));
}
(async()=>{
 await productPageCheck();
 const zeroSeed=await productActionCheck('0','0');assert.equal(zeroSeed.binding_months,0);assert.equal(zeroSeed.notice_months,0);
 const emptySeed=await productActionCheck('','');assert.equal(emptySeed.binding_months,null);assert.equal(emptySeed.notice_months,null);
 await api.createContractFromApi({kind:'session',tenantId:'tenant',userId:'owner'},{customer_id:'customer',product_id:'product',legal_entity_id:'issuer',template_version_id:'version',source_call_id:'call',title:'Product contract',idempotency_key:'test-key-123'});
 assert.equal(captured.p_price_version_id,'price');assert.equal(captured.p_commercial_terms.binding_months,2);assert.equal(captured.p_commercial_terms.notice_months,1);assert.equal(captured.p_rendered_body,'Bindning 2');assert.equal(captured.p_rendered_terms,'Uppsägning 1. Betalning 0.');
 // The same API supports ordinary text-template fields and customer defaults.
 const originalVersion={...records.contract_template_versions};
 records.customers.custom_fields={anlaggning_id:'001234567890123456',unrelated:'not part of the agreement'};
 records.contract_template_versions={...originalVersion,body_template:'Anläggning {{custom.anlaggning_id}}',signing_configuration:{custom_fields:[{id:'anlaggning_id',label:'Anläggnings-ID',type:'text',required:true,customerKey:'anlaggning_id'}]}};
 const fieldInput={customer_id:'customer',product_id:'product',legal_entity_id:'issuer',template_version_id:'version',source_call_id:'call',title:'Fields',idempotency_key:'field-key-123'};
 await api.createContractFromApi({kind:'session',tenantId:'tenant',userId:'owner'},fieldInput);
 assert.equal(captured.p_rendered_body,'Anläggning 001234567890123456');assert.equal(captured.p_commercial_terms.custom_fields.values.anlaggning_id,'001234567890123456');
 assert(!('custom_fields' in captured.p_counterparty_snapshot),'Unrelated customer fields must not leak into the agreement snapshot');
 await assert.rejects(api.createContractFromApi({kind:'session',tenantId:'tenant',userId:'owner'},{...fieldInput,custom_values:{anlaggning_id:''}}),/required_value/);
 await assert.rejects(api.createContractFromApi({kind:'session',tenantId:'tenant',userId:'owner'},{...fieldInput,custom_values:{anlaggning_id:'123'},pdf_custom_values:{anlaggning_id:'123'}}),/ambiguous/);
 records.contract_template_versions=originalVersion;
 // Generate a real PDF while observing the actual draw operations, preserving
 // pdf-lib fonts/layout/serialization. This verifies zero renders as zero.
 const pdfLib=require('pdf-lib'),draw=pdfLib.PDFPage.prototype.drawText,texts=[];
 pdfLib.PDFPage.prototype.drawText=function(text,...args){texts.push(text);return draw.call(this,text,...args);};
 try{
 const generate=load('src/lib/contracts/generate-contract-pdf.ts').generateContractPdf;
 const bytes=await generate({generated_at:new Date().toISOString(),contract:{id:'contract',number:'TEST-1',title:'Fixture',value:49,currency:'SEK',binding_months:0,notice_months:0},version:{id:'version',number:1,commercial_terms:{payment_terms_days:0,product_name:'Fixture'},body:'Body',terms:'Terms'},seller:{legal_name:'Fixture AB'},counterparty:{display_name:'Fixture'},source_call:{id:'call',ended_at:'2026-11-17'}},'fixture-sha');
 assert(Buffer.from(bytes).subarray(0,5).equals(Buffer.from('%PDF-')));assert(texts.includes('0 månader'));assert(texts.includes('0 dagar'));
 }finally{pdfLib.PDFPage.prototype.drawText=draw;}
 console.log('PASS: per-product nullable/zero durations, actual API effective-price selection and template snapshot/RPC payload, real PDF preserves zero months/days.');
})().catch(e=>{console.error(e);process.exitCode=1;});
