import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { randomUUID } from 'node:crypto';
let failProvider = false; let touchError = false;
let rows = []; const calls = [];
const admin = {
  from() {
    let updating = false;
    const builder = new Proxy({}, { get(_target, key) {
      if (key === 'then') return resolve => Promise.resolve({ data: updating ? null : rows, error: updating && touchError ? new Error('DB unavailable') : null }).then(resolve);
      return (...args) => { if (key === 'update') { updating = true; calls.push(['touch', args[0]]); } return builder; };
    } }); return builder;
  },
  async rpc(_name, args) { calls.push(['heartbeat', args.p_status]); return { error: null }; },
};
const compiled = ts.transpile(await readFile(new URL('../src/app/api/cron/signing-reconcile/route.ts', import.meta.url), 'utf8'), { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
const exports = {};
new Function('require','exports',compiled)((name) => {
  if (name.endsWith('/admin')) return { createAdminClient: () => admin };
  if (name.endsWith('/env')) return { serverEnv: () => ({ CRON_SECRET: 'test-secret-only' }) };
  if (name.endsWith('/orchestration')) return {
    continueNativeSigning: async (...args) => { calls.push(['continue', ...args]); if (failProvider) throw new Error('Stored receipt temporarily unavailable'); },
  }; throw new Error(name);
},exports);
const invoke = authorized => exports.GET(new Request('https://example.test/api/cron/signing-reconcile', { headers: authorized ? { authorization: 'Bearer test-secret-only' } : {} }));
assert.equal((await invoke(false)).status,403); assert.equal(calls.length,0);
rows=[{id:randomUUID(),status:'creating',provider_envelope_id:null},{id:randomUUID(),status:'sent',provider_envelope_id:'123'}];
assert.equal((await invoke(true)).status,200);
assert.equal(calls.find(row=>row[0]==='continue').length,2,'Automatic recovery must omit initial=true');
assert.equal(calls.filter(row=>row[0]==='touch').length,2);
assert.deepEqual(calls.filter(row=>row[0]==='heartbeat').map(row=>row[1]),['running','healthy']);
calls.length=0; failProvider=true;
assert.equal((await invoke(true)).status,503); assert.equal(calls.filter(row=>row[0]==='touch').length,2,'Failed oldest operations do not starve later work');
assert.deepEqual(calls.filter(row=>row[0]==='heartbeat').map(row=>row[1]),['running','degraded']);
calls.length=0; failProvider=false; touchError=true;
assert.equal((await invoke(true)).status,503); assert.equal(calls.at(-1)[1],'failed');
console.log('Scheduled native signing: auth, persisted receipt recovery, fairness, progress errors and heartbeat PASS.');

{
  const workerSource=await readFile(new URL('../src/lib/workers/scheduled-edge-worker.ts',import.meta.url),'utf8');
  const workerOutput=ts.transpile(workerSource,{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022});
  const workerExports={};const heartbeatStatuses=[];const heartbeatMetadata=[];
  new Function('require','exports',workerOutput)(name=>{
    if(name.endsWith('/env'))return{serverEnv:()=>({CRON_SECRET:'cron-test',NEXT_PUBLIC_SUPABASE_URL:'https://db.example.test'})};
    if(name.endsWith('/admin'))return{createAdminClient:()=>({rpc:async(_name,args)=>{heartbeatStatuses.push(args.p_status);heartbeatMetadata.push(args.p_metadata);return{error:null};}})};
    throw new Error(name);
  },workerExports);
  const originalFetch=globalThis.fetch;const originalTimeout=AbortSignal.timeout;let timeoutMs;
  try {
    AbortSignal.timeout=milliseconds=>{timeoutMs=milliseconds;return new AbortController().signal;};
    globalThis.fetch=async()=>Response.json({results:[],delivery:{emailConfigurationDigest:'a'.repeat(64),platformEmailConfigured:true,apiKey:'mock-key-must-not-propagate'}});
    assert.equal((await workerExports.invokeScheduledEdgeWorker('process-outbox')).status,'healthy');
    assert.deepEqual(heartbeatStatuses,['running','healthy']);
    assert.equal(heartbeatMetadata.at(-1).delivery.emailConfigurationDigest,'a'.repeat(64));
    assert.ok(!JSON.stringify(heartbeatMetadata).includes('mock-key-must-not-propagate'),'Only nonsecret configuration digest is forwarded to heartbeat metadata');
    for(const route of ['../src/app/api/cron/process-outbox/route.ts','../src/app/api/cron/edge-workers/[worker]/route.ts']){
      const caller=await readFile(new URL(route,import.meta.url),'utf8');
      const maxDurationSeconds=Number(/export const maxDuration = (\d+)/.exec(caller)?.[1]);
      assert.ok(timeoutMs>45_000+30_000,'Invoker must cover the loop budget and a final provider request');
      assert.ok(timeoutMs+30_000<=maxDurationSeconds*1000,'Caller must retain a bounded margin for response processing and heartbeat writes');
    }
  } finally {globalThis.fetch=originalFetch;AbortSignal.timeout=originalTimeout;}
  console.log('Scheduled Edge worker: provider timeout exceeds full batch budget and remains below both cron caller deadlines with heartbeat margin PASS');
}
