const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),tls=require('node:tls'),{spawn,execFileSync}=require('node:child_process'),assert=require('node:assert/strict');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kundexa-tls-fixture-'));
 let server;
 try {
  const cert=path.join(dir,'cert.pem'),key=path.join(dir,'key.pem'),ca=path.join(dir,'ca.pem'),caKey=path.join(dir,'ca-key.pem'),csr=path.join(dir,'server.csr'),extensions=path.join(dir,'extensions.txt');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',caKey,'-out',ca,'-subj','/CN=Kundexa test root'],{stdio:'ignore'});
  execFileSync('openssl',['req','-new','-newkey','rsa:2048','-nodes','-keyout',key,'-out',csr,'-subj','/CN=fixture.invalid'],{stdio:'ignore'});
  fs.writeFileSync(extensions,'subjectAltName=DNS:fixture.invalid\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  execFileSync('openssl',['x509','-req','-in',csr,'-CA',ca,'-CAkey',caKey,'-CAcreateserial','-out',cert,'-days','1','-extfile',extensions],{stdio:'ignore'});
  server=tls.createServer({cert:fs.readFileSync(cert),key:fs.readFileSync(key)},socket=>{let request='';socket.on('data',chunk=>{request+=chunk;if(request.includes('runtime-http-fixture'))socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');});});
  server.on('tlsClientError',()=>{});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port;
  for(const [servername,success] of [['fixture.invalid',true],['wrong.invalid',false]]) {
   const source=`const conn=await Deno.connect({hostname:'127.0.0.1',port:${port}});const tls=await Deno.startTls(conn,{hostname:${JSON.stringify(servername)},caCerts:[await Deno.readTextFile(${JSON.stringify(ca)})],alpnProtocols:['http/1.1']});try{await tls.handshake();}finally{tls.close();}`;
   const version=process.env.DENO_COMPAT_NPM_VERSION;if(version&&!/^2\.\d+\.\d+$/.test(version))throw Error('invalid Deno compatibility version');
   const executable=version?'npx':path.join(__dirname,'../node_modules/.bin/deno');const args=version?['--yes',`deno@${version}`,'eval',source]:['eval',source];
   const result=await new Promise((resolve,reject)=>{const proc=spawn(executable,args,{stdio:['ignore','pipe','pipe']});let output='';proc.stdout.on('data',c=>output+=c);proc.stderr.on('data',c=>output+=c);proc.on('error',reject);proc.on('close',code=>resolve({code,output}));});
   assert.equal(result.code===0,success,result.output);
   if(!success)assert.match(result.output,/certificate|not valid|name mismatch|NotValidForName/i);
  }
  const moduleFile=path.join(dir,'pinned-webhook.ts');
  fs.writeFileSync(moduleFile,fs.readFileSync(path.join(__dirname,'../supabase/functions/_shared/pinned-webhook.ts'),'utf8')+'\nexport {nativePinnedPost as fixtureNativePost};');
  const integration=`const mod=await import(${JSON.stringify('file://'+moduleFile)});const pem=await Deno.readTextFile(${JSON.stringify(ca)});const transport={connect:Deno.connect,startTls:(conn,opts)=>Deno.startTls(conn,{...opts,caCerts:[pem]})};const result=await mod.fixtureNativePost(transport,new URL('https://fixture.invalid:${port}/fixture'),'127.0.0.1',{body:'runtime-http-fixture',headers:{'content-type':'text/plain'},signal:AbortSignal.timeout(5000)});if(await result.text()!=='ok')throw Error('native HTTP response mismatch');`;
  const compat=process.env.DENO_COMPAT_NPM_VERSION;
  const integrationResult=await new Promise((resolve,reject)=>{const proc=spawn(compat?'npx':path.join(__dirname,'../node_modules/.bin/deno'),compat?['--yes',`deno@${compat}`,'eval',integration]:['eval',integration],{stdio:['ignore','pipe','pipe']});let output='';proc.stdout.on('data',c=>output+=c);proc.stderr.on('data',c=>output+=c);proc.on('error',reject);proc.on('close',code=>resolve({code,output}));});
  assert.equal(integrationResult.code,0,integrationResult.output);
  console.log('PASS: actual native Deno TLS connects to explicit IP with independent SNI, validates matching hostname, rejects mismatch and sends/reads actual bounded HTTP.');
 } finally { if(server)await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1});
