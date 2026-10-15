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
