const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'..'),ts=require(path.join(root,'node_modules/typescript'));
const people=[{full_name:'Anna',phone_e164:'+46700000001'},{full_name:'Bo',phone_e164:'+46700000002'},{full_name:'Cecilia',phone_e164:'+46700000003'}];
const rows=[{contacts:people.slice(0,2)},{contacts:[people[1],people[2]]}];
let inserted=[];
const db={from(table){let op='select';const q={then(resolve,reject){return Promise.resolve({data:table==='platform_lists'&&op==='insert'?{id:'list-fixture'}:null,error:null}).then(resolve,reject)}};for(const method of ['select','eq','neq','maybeSingle','single','delete','update'])q[method]=()=>q;q.insert=value=>{op='insert';if(table==='platform_list_entries')inserted.push(...value);return q};return q},rpc:async()=>({error:null})};
const mocks={
 'node:crypto':require('node:crypto'), 'next/server':{NextResponse:{redirect:url=>url}},
 '@/lib/auth':{getPlatformContext:async()=>({platformRole:'platform_owner',userId:'user'}),isPlatformAdmin:()=>true},
 '@/lib/supabase/admin':{createAdminClient:()=>db},
 '@/lib/imports/file-parser':{parseImportFile:async()=>({rows,sourceType:'json',parserErrors:[],columns:[]})},
 '@/lib/imports/normalize-row':{normalizeImportedRow:row=>({normalized:{display_name:'Company',organization_number:'org-fixture',contacts:row.contacts},mapping:{},errors:[],warnings:[]})},
 '@/lib/imports/malware-scan':{scanImportFile:async()=>({status:'clean',sha256:'sha-fixture'})},
 '@/lib/supabase/json':{toJson:value=>value},
};
const exportsObject={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,'src/app/api/v1/platform/lists/import/route.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:exportsObject,require:id=>{if(!(id in mocks))throw Error(id);return mocks[id]},File,Buffer,URL,console,crypto:require('node:crypto').webcrypto});
(async()=>{const form=new FormData();form.set('name','Fixture');form.set('file',new File(['[]'],'fixture.json'));const result=await exportsObject.POST({url:'https://fixture.invalid',formData:async()=>form});assert.equal(result.searchParams.has('error'),false);assert.equal(inserted.length,1);assert.equal(inserted[0].metadata.contacts.length,3);assert.equal(inserted[0].metadata.source_rows.length,2);console.log('PASS: actual platform import merges company, preserves three contacts and both source rows.');})().catch(e=>{console.error(e);process.exitCode=1});
