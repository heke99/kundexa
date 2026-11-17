const net=require('node:net'),assert=require('node:assert/strict');
(async()=>{
 const sockets=new Set(),passiveServers=[];let controlClosed;const transferDone=new Promise(r=>controlClosed=r);
 const server=net.createServer(socket=>{
  sockets.add(socket);socket.on('close',()=>{sockets.delete(socket);controlClosed();});socket.write('220 Fixture FTP\r\n');let buffer='',dataSocket;
  socket.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\r\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+2);const cmd=line.split(' ')[0];
   if(cmd==='USER')socket.write('331 Password required\r\n');
   else if(cmd==='PASS')socket.write('230 Logged in\r\n');
   else if(cmd==='FEAT')socket.write('211-Features\r\n MDTM\r\n UTF8\r\n EPSV\r\n211 End\r\n');
   else if(cmd==='MDTM')socket.write('213 20261116000000\r\n');
   else if(cmd==='EPSV') {const passive=net.createServer(s=>{dataSocket=s;sockets.add(s);s.on('close',()=>sockets.delete(s));});passiveServers.push(passive);passive.listen(0,'127.0.0.1',()=>socket.write(`229 Entering Extended Passive Mode (|||${passive.address().port}|)\r\n`));}
   else if(cmd==='RETR'){socket.write('150 Data follows\r\n');if(!dataSocket)throw Error('missing data connection');dataSocket.end('patched FTP compatibility fixture');dataSocket.once('close',()=>socket.write('226 Transfer complete\r\n'));}
   else if(cmd==='QUIT')socket.end('221 Bye\r\n');
   else socket.write('200 OK\r\n');
  }});
 });
 try {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const {getUri}=require('get-uri');const stream=await getUri(`ftp://127.0.0.1:${server.address().port}/fixture.txt`);let body='';for await(const chunk of stream)body+=chunk;
  assert.equal(body,'patched FTP compatibility fixture');await transferDone;
  assert.equal(require('basic-ftp/package.json').version,'6.2.6');
  console.log('PASS: existing get-uri FTP adapter authenticates, gets metadata and downloads through patched basic-ftp 6.2.6.');
 } finally {for(const s of sockets)s.destroy();for(const s of passiveServers)s.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
