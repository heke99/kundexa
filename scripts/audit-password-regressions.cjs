const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'..'),ts=require(path.join(root,'node_modules/typescript')),z=require(path.join(root,'node_modules/zod')).z;
let otpValid=false,reauthValid=false,updates=0,completions=0,sends=0;
const user={id:'verified-user',email:'fixture@example.test'};
const auth={getUser:async()=>({data:{user}}),verifyOtp:async p=>{assert.equal(p.type,'recovery');return otpValid?{data:{user,session:{}},error:null}:{data:{},error:{code:'invalid'}}},updateUser:async()=>{updates++;return {error:null}},signOut:async()=>({error:null}),signInWithPassword:async()=>reauthValid?{data:{user},error:null}:{data:{},error:{code:'invalid'}},resetPasswordForEmail:async()=>{sends++;return {error:{code:'fixture_unknown_user'}}}};
const client={auth,rpc:async name=>name==='current_user_security_state'?{data:[{must_change_password:false}],error:null}:{error:null}};
const mocks={'next/navigation':{redirect:url=>{throw Error(url)}},'zod':{z},'@/lib/supabase/server':{createClient:async()=>client},'@/lib/supabase/admin':{createAdminClient:()=>({rpc:async()=>{completions++;return {error:null}}})},'@/lib/env':{serverEnv:()=>({NEXT_PUBLIC_APP_URL:'https://fixture.invalid'})},'@/lib/security/password-policy':{passwordSchema:z.string().min(12)}};
function load(file){const exp={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:exp,require:id=>{if(!(id in mocks))throw Error(id);return mocks[id]},URL,console,crypto:require('node:crypto').webcrypto});return exp;}
(async()=>{const recovery=load('src/app/actions/password-recovery.ts'),change=load('src/app/actions/change-password.ts');const form=new FormData();form.set('email',user.email);form.set('token','123456');form.set('password','Fixture!LongPassword12');form.set('password_confirm','Fixture!LongPassword12');
await assert.rejects(recovery.recoverPassword(form),/Koden/);assert.equal(updates,0);assert.equal(completions,0);
otpValid=true;await assert.rejects(recovery.recoverPassword(form),/Lösenordet är ändrat/);assert.equal(updates,1);assert.equal(completions,1);
await assert.rejects(change.changePassword(form),/nuvarande/);assert.equal(updates,1);
form.set('current_password','old-password');await assert.rejects(change.changePassword(form),/kunde inte verifieras/);assert.equal(updates,1);
reauthValid=true;await assert.rejects(change.changePassword(form),/\/app/);assert.equal(updates,2);
await assert.rejects(recovery.requestPasswordRecovery(form),/Om kontot finns/);assert.equal(sends,1);
console.log('PASS: invalid recovery/current password never updates credentials; verified proof succeeds; request response avoids account disclosure.');})().catch(e=>{console.error(e);process.exitCode=1});
