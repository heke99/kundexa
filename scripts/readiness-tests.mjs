import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = ts.transpile(readFileSync('src/lib/operational-readiness.ts', 'utf8'), { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
const exports = {}; new Function('exports', source)(exports);
const now = Date.parse('2026-10-15T10:00:00Z');
const workers = exports.REQUIRED_WORKERS.map(worker_key => ({ worker_key, status: 'healthy', updated_at: new Date(now - 60_000).toISOString() }));
assert.equal(exports.evaluateWorkerReadiness(workers, now).every(x => x.ready), true);
for (const bad of [[], workers.map(w => ({ ...w, updated_at: new Date(now - 16*60_000).toISOString() })), workers.map(w => ({ ...w, status: 'degraded' })), workers.map(w => ({ ...w, updated_at: 'invalid' })), workers.map(w => ({ ...w, updated_at: new Date(now+120_000).toISOString() }))]) assert.equal(exports.evaluateWorkerReadiness(bad, now).every(x => x.ready), false);
console.log('Readiness freshness and failure tests PASS.');

const healthySigning = {worker_key:'signing-reconcile',status:'healthy',updated_at:new Date(now-60_000).toISOString()};
const signingCheck = overrides => exports.evaluateSigningWorkerReadiness({templateCount:0,pendingCount:0,readFailed:false,now,...overrides});
assert.deepEqual(signingCheck({}),{required:false,ready:true});
assert.deepEqual(signingCheck({pendingCount:1}),{required:true,ready:false},'An in-flight native envelope still requires recovery after its template is replaced');
assert.deepEqual(signingCheck({pendingCount:1,heartbeat:healthySigning}),{required:true,ready:true});
assert.deepEqual(signingCheck({templateCount:1}),{required:true,ready:false});
for(const heartbeat of [{...healthySigning,status:'degraded'},{...healthySigning,updated_at:'invalid'},{...healthySigning,updated_at:new Date(now-16*60_000).toISOString()}]) assert.equal(signingCheck({pendingCount:1,heartbeat}).ready,false);
assert.equal(signingCheck({readFailed:true,heartbeat:healthySigning}).ready,false);
console.log('Signing readiness: in-flight envelopes require a fresh worker after template changes; queue/policy read errors fail closed PASS.');

const digest='a'.repeat(64),otherDigest='b'.repeat(64);
assert.equal(exports.matchingEmailConfiguration(digest,digest),true);
for(const report of [undefined,null,'',otherDigest,'not-a-digest'])assert.equal(exports.matchingEmailConfiguration(report,digest),false);
assert.equal(exports.matchingEmailConfiguration(digest,null),false);
assert.equal(exports.everyTenantEmailWebhookVerified([]),false);
assert.equal(exports.everyTenantEmailWebhookVerified([{tenantId:'A',verified:true},{tenantId:'B',verified:false}]),false,'Tenant A cannot mark tenant B webhook ready');
assert.equal(exports.everyTenantEmailWebhookVerified([{tenantId:'A',verified:false},{tenantId:'A',verified:true},{tenantId:'B',verified:true}]),true);
console.log('Email readiness: missing/mismatched effective configuration fails closed; every active tenant needs its own verified webhook group PASS.');
