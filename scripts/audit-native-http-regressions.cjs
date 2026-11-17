const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'..'),ts=require(path.join(root,'node_modules/typescript'));
let wire='',chunks=[],writes=[],closed=false,handshakeError=false,hangRead=false;
const conn={read:async buffer=>{if(hangRead)return await new Promise(()=>{});const next=chunks.shift();if(!next)return null;buffer.set(next);return next.length},write:async bytes=>{writes.push(Buffer.from(bytes));return bytes.length},close:()=>{closed=true},handshake:async()=>{if(handshakeError)throw Error('fixture certificate mismatch')}};
const native={connect:async options=>{assert.equal(options.hostname,'8.8.8.8');assert.equal(options.port,443);return conn},startTls:async(c,options)=>{assert.equal(c,conn);assert.equal(options.hostname,'fixture.example');return conn}};
const exp={};const modules={'node:dns/promises':{lookup:async()=>[{address:'8.8.8.8',family:4}]},'node:net':require('node:net'),'node:buffer':{Buffer},'node:https':{},'node:tls':{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,'supabase/functions/_shared/pinned-webhook.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:exp,require:id=>modules[id],Deno:native,URL,Response,Uint8Array,TextEncoder,TextDecoder,setTimeout,clearTimeout,Buffer});
const init={body:'Fixture ü',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(30000)};
function reset(response){writes=[];closed=false;wire=response;const bytes=Buffer.from(response);chunks=[];for(let i=0;i<bytes.length;i+=3)chunks.push(bytes.subarray(i,i+3));}
(async()=>{
 for(const [response,body] of [['HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok','ok'],['HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2;ext=1\r\nok\r\n0\r\nX-Fixture: yes\r\n\r\n','ok'],['HTTP/1.0 200 OK\r\n\r\nclose-delimited','close-delimited'],['HTTP/1.1 204 No Content\r\n\r\n','']]){
  reset(response);const result=await exp.pinnedWebhookFetch(new URL('https://fixture.example/path?x=1'),init);assert.equal(await result.text(),body);assert(closed);assert.match(Buffer.concat(writes).toString(),/Content-Length: 10\r\n/);
 }
 for(const [response,error] of [['HTTP/1.1 302 Found\r\nLocation: https://127.0.0.1\r\n\r\n','redirect'],['HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\na','truncated'],['HTTP/1.1 200 OK\r\nContent-Length: 17000\r\n\r\n','too_large'],['HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n','ambiguous'],['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nFFFF\r\n','too_large']]){
  reset(response);await assert.rejects(exp.pinnedWebhookFetch(new URL('https://fixture.example'),init),new RegExp(error));assert(closed);
 }
 reset('');handshakeError=true;await assert.rejects(exp.pinnedWebhookFetch(new URL('https://fixture.example'),init),/certificate/);assert.equal(writes.length,0);handshakeError=false;
 reset('');hangRead=true;const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),5);try{await assert.rejects(exp.pinnedWebhookFetch(new URL('https://fixture.example'),{...init,signal:controller.signal}),/timeout/);assert(closed)}finally{clearTimeout(timer);hangRead=false;}
 console.log('PASS: actual native HTTP transport pins IP/SNI, verifies TLS before payload, handles split/chunked/interim/close responses and rejects truncation, ambiguity, redirects, oversize and timeout.');
})().catch(e=>{console.error(e);process.exitCode=1});
