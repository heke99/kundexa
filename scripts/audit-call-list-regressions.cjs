const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=p=>ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const permissions={};new Function('exports',compile('src/lib/permissions.ts'))(permissions);
assert.equal(permissions.apiScopePermission['calls:read'],'calls.read');
let failure=null,filters=[],clientReads=0,source='session';
const client={from:()=>{clientReads++;const q=new Proxy({}, {get:(_,k)=>k==='then'?resolve=>resolve({data:[],error:null}):(...args)=>{filters.push([k,...args]);return q;}});return q;}};
const route={};new Function('exports','require',compile('src/app/api/v1/calls/route.ts'))(route,id=>id==='next/server'?{NextResponse:{json:(data,init)=>Response.json(data,init)}}:id==='zod'?require('zod'):id==='@/lib/api-auth'?{authenticateRequest:async(_r,scope)=>{assert.equal(scope,'calls:read');if(failure)throw failure;return {tenantId:'tenant-A',source};},dataClientForIdentity:async()=>client}:{});
(async()=>{
 for(const status of [401,403,429,503]){failure=Response.json({error:'controlled'},{status});clientReads=0;assert.equal((await route.GET(new Request('https://fixture.invalid/api/v1/calls'))).status,status);assert.equal(clientReads,0);}
 failure=null;
 for(const limit of ['NaN','0','-1','1.5','101']){clientReads=0;assert.equal((await route.GET(new Request('https://fixture.invalid/api/v1/calls?limit='+limit))).status,422);assert.equal(clientReads,0);}
 for(source of ['session','api_key']){filters=[];const r=await route.GET(new Request('https://fixture.invalid/api/v1/calls?limit=25'));assert.equal(r.status,200);assert(filters.some(x=>x[0]==='eq'&&x[1]==='tenant_id'&&x[2]==='tenant-A'));assert(filters.some(x=>x[0]==='limit'&&x[1]===25));}
 console.log('PASS: actual call list preserves auth/rate/outage responses, rejects invalid limits and applies explicit tenant scope for both transports.');
})().catch(e=>{console.error(e);process.exitCode=1;});
