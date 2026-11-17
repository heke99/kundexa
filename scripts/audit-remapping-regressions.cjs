const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'..'),ts=require(path.join(root,'node_modules/typescript'));
const code=ts.transpileModule(fs.readFileSync(path.join(root,'src/app/actions/imports.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
async function run(failure) {
  let status='preview_ready', rpcCount=0, readyWrites=0;
  const run={id:'fixture',status,total_rows:501,updated_at:'fixture-time',validation_report:{}};
  const db={from(table){let update,offset=0;const q={then(resolve,reject){if(update){if(update.status==='preview_ready')readyWrites++;if(update.status!=='failed'||status==='validating')status=update.status;return Promise.resolve({data:{id:'fixture'},error:null}).then(resolve,reject)}const data=table==='import_runs'?run:Array.from({length:offset===0?500:failure==='missing'?0:1},(_,i)=>({id:`row-${offset+i}`,raw_data:{}}));return Promise.resolve({data,error:null}).then(resolve,reject)}};for(const method of ['select','eq','contains','single','maybeSingle','order'])q[method]=()=>q;q.range=start=>{offset=start;return q};q.update=value=>{update=value;return q};return q},rpc:async()=>{rpcCount++;return failure==='batch'&&rpcCount===2?{error:{message:'injected_second_batch_failure'}}:{data:rpcCount===1?500:1,error:null}}};
  const mocks={'next/cache':{revalidatePath:()=>{}},'next/navigation':{redirect:url=>{throw Error(url)}},'@/lib/auth':{getAppContext:async()=>({tenantId:'tenant',role:'owner'})},'@/lib/permissions':{assertPermission:()=>{}},'@/lib/supabase/server':{createClient:async()=>db},'@/lib/supabase/admin':{createAdminClient:()=>db},'@/lib/imports/import-profile':{importFieldMappingSchema:{parse:v=>v}},'@/lib/imports/normalize-row':{normalizeImportedRow:()=>({normalized:{},errors:[],warnings:[],issues:[]})}};
  const exp={};vm.runInNewContext(code,{exports:exp,require:id=>{if(!(id in mocks))throw Error(id);return mocks[id]},crypto:require('node:crypto').webcrypto});
  const form=new FormData();form.set('import_run_id','fixture');form.set('mapping_json','{}');
  try{await exp.updateImportMapping(form)}catch{}
  return {status,readyWrites,rpcCount};
}
(async()=>{for(const failure of ['batch','missing']){const result=await run(failure);assert.equal(result.status,'failed');assert.equal(result.readyWrites,0);}const success=await run(null);assert.equal(success.status,'preview_ready');assert.equal(success.readyWrites,1);console.log('PASS: second-batch failure and missing rows never publish mapping as ready; complete mapping does.');})().catch(e=>{console.error(e);process.exitCode=1});
