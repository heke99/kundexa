const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, 'deploy-functions.mjs'), 'utf8').replace(/^import .*;\n/gm, '');
function run(inventory, listStatus = 0, deleteStatus = 0, preflightStatus = 0) {
  const calls = [], messages = [];
  let failure;
  try {
    vm.runInNewContext(source, {
      readdirSync: () => [{ name: 'process-outbox', isDirectory: () => true }], existsSync: () => true,
      join: require('node:path').join,
      process: { execPath: 'node', argv: ['node', 'script', '--project-ref', 'fixture'], platform: 'linux', exit: n => { throw Error(`exit:${n}`); } },
      console: { log: (...args) => messages.push(args.join(' ')), error: () => {} },
      spawnSync: (_, args) => { calls.push(args); return { status: args[0]==='scripts/check-deployment-schema.mjs' ? preflightStatus : args.includes('list') ? listStatus : args.includes('delete') ? deleteStatus : 0, stdout: inventory }; },
    });
  } catch (e) { failure = e; }
  return { calls, messages, failure };
}
let result = run('[]'); assert.equal(result.failure, undefined); assert.equal(result.calls.some(a => a.includes('delete')), false);
result = run('[{"name":"rinkel-platform-worker"}]'); assert.equal(result.failure, undefined); assert(result.calls.some(a => a.includes('delete')));
for (const result of [run('[]', 1), run('not json'), run('{}'), run('[{"slug":"unknown"}]')]) {
  assert(result.failure); assert.equal(result.calls.some(a => a.includes('delete')), false);
}
result = run('[{"name":"rinkel-platform-worker"}]', 0, 1); assert(result.failure); assert.equal(result.messages.some(s => s.startsWith('Removed ')), false);
console.log('PASS: verified absence is idempotent; inventory/parse/delete failures stop cleanup.');

result=run('[]',0,0,1); assert(result.failure); assert.equal(result.calls.some(a=>a.includes('deploy')||a.includes('delete')),false,'Schema failure must precede every deploy or deletion');
