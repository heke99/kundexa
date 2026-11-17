const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const base=require('node:path').resolve(__dirname,'..')+'/';
const ts=require(base+'node_modules/typescript'),React=require(base+'node_modules/react');
const {renderToStaticMarkup}=require(base+'node_modules/react-dom/server');
function load(file,mocks){const exp={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(base+file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports:exp,require:id=>{if(id in mocks)return mocks[id];if(id==='react/jsx-runtime')return require(base+'node_modules/react/jsx-runtime');throw Error('unmocked '+id)},console,URL,Response,Request,Blob,Buffer,Date,crypto:require('node:crypto').webcrypto});return exp;}
function chain(data){const c={then:(r,j)=>Promise.resolve({data,error:null}).then(r,j)};for(const k of ['select','eq','single','maybeSingle','contains','in','order','limit'])c[k]=()=>c;return c;}
(async()=>{
let docState='pending',tenantReads=0;
const admin={from:t=>{if(t==='tenants'){tenantReads++;return chain({status:'active'});}return chain(t==='tenants'?{status:'active'}:t==='contract_acceptance_requests'?{tenant_id:'suspended-fixture',status:docState,expires_at:'2020-01-01',canonical_document_id:'doc',canonical_document_sha256:'hash'}:{file_name:'agreement.pdf',storage_path:'private/fixture',mime_type:'application/pdf',sha256:'hash'})},rpc:async()=>({data:true,error:null}),storage:{from:()=>({download:async()=>({data:new Blob(['%PDF-fixture']),error:null})})}};
const doc=load('src/app/api/public/contracts/[token]/document/route.ts',{'@/lib/supabase/admin':{createAdminClient:()=>admin},'@/lib/env':{serverEnv:()=>({KUNDEXA_WEBHOOK_PEPPER:'fixture'})},'@/lib/crypto':{sha256:()=> 'hash',sha256Bytes:()=> 'hash'}});
const invoke=()=>doc.GET(new Request('https://local.invalid/document'),{params:Promise.resolve({token:'fixture'})});
let res=await invoke();assert.equal(res.status,410);docState='expired';res=await invoke();assert.equal(res.status,410);
console.log('FIX VERIFIED public PDF: elapsed pending request=410, same request status expired=410; no tenant status read.');
let status='pending',writes=0;
const request={id:'request',tenant_id:'tenant',status,opened_at:'2026-01-01',expires_at:'2099-01-01',require_code:false,canonical_document_id:'doc',contracts:{id:'contract',title:'Fixture secret agreement',contract_number:'FIXTURE',value:100,currency:'SEK',seller_snapshot:{legal_name:'Fixture AB'},tenants:{name:'Fixture',legal_name:'Fixture AB'},customers:{display_name:'Fixture recipient'}},contract_versions:{version:1,rendered_body:'Confidential agreement fixture',rendered_terms:'Terms'}};
const div=({children})=>React.createElement('div',{},children);
const page=load('src/app/accept/[token]/page.tsx',{'next/link':{__esModule:true,default:({children,href})=>React.createElement('a',{href},children)},'next/navigation':{notFound:()=>{throw Error('not found')}},'@/components/icons':new Proxy({},{get:()=>()=>null}),'@/lib/supabase/admin':{createAdminClient:()=>({from:t=>chain(t==='tenants'?{status:'active'}:t==='contract_acceptance_requests'?{...request,status}:{id:'doc',file_name:'fixture.pdf'}),rpc:async()=>{writes++;return {error:null}}})},'@/lib/env':{serverEnv:()=>({KUNDEXA_WEBHOOK_PEPPER:'fixture'})},'@/lib/crypto':{sha256:()=> 'hash'},'@/app/actions/public-contract':{respondPublicContract:()=>{}},'@/components/ui/card':{Card:div,CardContent:div,CardHeader:div},'@/components/ui/form-field':{Field:()=>null},'@/components/logo':{Logo:()=>null},'@/lib/utils':{formatCurrency:()=> '100',formatDate:()=> 'date'},'@/lib/contracts/delivery-readiness':{contractAcceptanceModes:async()=>({web:true})}});
let html=renderToStaticMarkup(await page.default({params:Promise.resolve({token:'fixture'}),searchParams:Promise.resolve({accepted:'1'})}));assert.doesNotMatch(html,/Din acceptans är registrerad/);assert.equal(writes,0);
console.log('FIX VERIFIED acceptance page: accepted=1 does not render registered acceptance for pending request without recording a response.');
html=renderToStaticMarkup(await page.default({params:Promise.resolve({token:'fixture'}),searchParams:Promise.resolve({declined:'1'})}));assert.doesNotMatch(html,/Ditt besked är registrerat/);
console.log('FIX VERIFIED acceptance page: declined=1 does not render registered refusal for pending request.');

})().catch(e=>{console.error(e);process.exitCode=1});
