const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'..'),ts=require(path.join(root,'node_modules/typescript'));
let addresses=[{address:'8.8.8.8',family:4}],dnsCalls=0,requests=0,bytes=Buffer.from('ok'),status=200;
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const modules={'node:dns/promises':{lookup:async()=>{dnsCalls++;return addresses}},'node:net':require('node:net'),'node:buffer':{Buffer},'node:tls':{connect:options=>{assert.equal(options.host,'8.8.8.8');assert.equal(options.servername,'fixture.example');assert.equal(options.rejectUnauthorized,true);return {}}},'node:https':{Agent:class{destroy(){}},request:(url,options,callback)=>{
 requests++;assert.equal(url.hostname,'fixture.example');assert.equal(options.rejectUnauthorized,true);assert(options.agent);
 options.agent.createConnection();
 const req=new EventEmitter();req.destroy=error=>req.emit('error',error);req.end=()=>{const res=new PassThrough();res.statusCode=status;callback(res);res.end(bytes)};return req;
}}};
const exp={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,'supabase/functions/_shared/pinned-webhook.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:exp,require:id=>modules[id],URL,Response,setTimeout,clearTimeout,Buffer});
(async()=>{
 for(const address of ['0.1.2.3','10.0.0.1','100.64.0.1','127.2.3.4','169.254.169.254','172.31.2.3','192.168.2.1','192.0.2.1','198.18.1.1','224.0.0.1','255.255.255.255','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::1','64:ff9b::7f00:1'])assert.equal(exp.isPublicAddress(address),false,address);
 assert(exp.isPublicAddress('8.8.8.8'));assert(exp.isPublicAddress('2606:4700:4700::1111'));
 for(const url of ['https://127.1','https://2130706433','https://[::ffff:7f00:1]','https://u:p@fixture.example','http://fixture.example'])assert.throws(()=>exp.webhookUrl(url));
 assert.equal(exp.webhookUrl('https://fixture.example:8443').port,'8443');
 const init={body:'fixture',headers:{},signal:AbortSignal.timeout(30000)};
 addresses=[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}];await assert.rejects(exp.pinnedWebhookFetch(new URL('https://fixture.example'),init),/private_network/);assert.equal(requests,0);
 addresses=[{address:'8.8.8.8',family:4}];dnsCalls=0;const result=await exp.pinnedWebhookFetch(new URL('https://fixture.example'),init);assert.equal(await result.text(),'ok');assert.equal(dnsCalls,1);
 bytes=Buffer.alloc(16385);await assert.rejects(exp.pinnedWebhookFetch(new URL('https://fixture.example'),init),/too_large/);
 bytes=Buffer.from('redirect');status=302;await assert.rejects(exp.pinnedWebhookFetch(new URL('https://fixture.example'),init),/redirect_forbidden/);
 console.log('PASS: public-only DNS, mixed/private/mapped-IP rejection, pinned TLS connection, certificate verification, no redirects and response byte budget.');
})().catch(e=>{console.error(e);process.exitCode=1});
