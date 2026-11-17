const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript');
async function run({role='owner',id='a0000000-0000-4000-8000-000000000001',rpcError=null}={}){
 const calls=[],revalidated=[],exp={};let location;
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/actions/organization.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
 exports:exp,require:name=>{
 if(name==='next/navigation')return {redirect:url=>{location=url;throw Error('REDIRECT');}};
 if(name==='next/cache')return {revalidatePath:path=>revalidated.push(path)};
 if(name==='@/lib/auth')return {getAppContext:async()=>({role})};
 if(name==='@/lib/supabase/server')return {createClient:async()=>({rpc:async(name,args)=>{calls.push({name,args});return {data:'2026-11-24',error:rpcError};}})};
 if(name==='@/lib/users/provision-user')return {provisionUser:()=>{throw Error('Renewal must not provision or email');}};
 if(name==='zod'||name==='node:crypto')return require(name);throw Error(name);
 }});
 const form=new FormData();form.set('invitation_id',id);
 try{await exp.renewTenantInvitation(form);}catch(e){if(e.message!=='REDIRECT')throw e;}
 return {calls,revalidated,location};
}
(async()=>{
 for(const role of ['sales','team_lead','viewer']){const r=await run({role});assert.equal(r.calls.length,0);assert(r.location.includes('Tenantadmin'));}
 let r=await run({id:'bad-id'});assert.equal(r.calls.length,0);assert(r.location.includes('Ogiltig'));
 r=await run();assert.equal(r.calls.length,1);assert.equal(r.calls[0].name,'renew_tenant_invitation');assert.equal(r.calls[0].args.p_invitation_id,'a0000000-0000-4000-8000-000000000001');assert(r.revalidated.includes('/app/users'));assert(decodeURIComponent(r.location).includes('Inget nytt mejl'));
 r=await run({role:'admin',rpcError:{message:'owner_required'}});assert(r.location.startsWith('/app/users?error='));assert.equal(r.revalidated.length,0);
 console.log('PASS: invitation renewal action enforces roles/input, uses canonical RPC, propagates denial, refreshes users and truthfully reports no email.');
})().catch(e=>{console.error(e);process.exitCode=1;});
