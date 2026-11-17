import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request, Agent } from "node:https";
import { connect } from "node:tls";
import { Buffer } from "node:buffer";

/** Conservative public-unicast policy, including mapped IPv6 and special-purpose ranges. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a,b,c] = address.split(".").map(Number);
    return !(a===0 || a===10 || a===127 || a>=224 || (a===100 && b>=64 && b<=127) ||
      (a===169 && b===254) || (a===172 && b>=16 && b<=31) ||
      (a===192 && (b===168 || (b===0 && (c===0 || c===2)) || (b===88 && c===99))) ||
      (a===198 && (b===18 || b===19 || (b===51 && c===100))) || (a===203 && b===0 && c===113));
  }
  if (isIP(address) !== 6) return false;
  const first = Number.parseInt(address.split(":")[0],16);
  const second = Number.parseInt(address.split(":")[1] || "0",16);
  return first>=0x2000 && first<=0x3fff && first!==0x2002 &&
    !(first===0x2001 && (second<0x200 || second===0xdb8)) && !(first===0x3fff && second<0x1000);
}

export function webhookUrl(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol!=="https:" || url.username || url.password || url.hash) throw new Error("webhook_url_forbidden");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".") || (isIP(host) && !isPublicAddress(host))) throw new Error("webhook_private_network_forbidden");
  return url;
}

// Edge uses native TCP + startTls: older Deno Node shims do not provide the
// required connection-factory/certificate guarantees. Handshake precedes payload.
type NativeConnection = {
  read(buffer:Uint8Array):Promise<number|null>;write(buffer:Uint8Array):Promise<number>;close():void;
  handshake?:()=>Promise<unknown>;
};
type NativeTransport = {
  connect(options:{hostname:string;port:number}):Promise<NativeConnection>;
  startTls(connection:NativeConnection,options:{hostname:string;alpnProtocols:string[]}):Promise<NativeConnection>;
};
function joinBytes(a:Uint8Array,b:Uint8Array){const result=new Uint8Array(a.length+b.length);result.set(a);result.set(b,a.length);return result;}
function sequenceIndex(bytes:Uint8Array,sequence:number[],offset=0){outer:for(let i=offset;i<=bytes.length-sequence.length;i++){for(let j=0;j<sequence.length;j++)if(bytes[i+j]!==sequence[j])continue outer;return i;}return -1;}
/** Complete bounded chunked framing, including extensions and trailers. null means more bytes required. */
export function decodeWebhookChunks(bytes:Uint8Array):Uint8Array<ArrayBuffer>|null{
 let offset=0,total=0;const parts:Uint8Array[]=[];
 while(true){
  const lineEnd=sequenceIndex(bytes,[13,10],offset);
  if(lineEnd<0){if(bytes.length-offset>1024)throw new Error("webhook_chunk_header_too_large");return null;}
  if(lineEnd-offset>1024)throw new Error("webhook_chunk_header_too_large");
  const line=new TextDecoder().decode(bytes.subarray(offset,lineEnd));
  if(!/^[0-9a-fA-F]+(?:;[^\r\n]*)?$/.test(line))throw new Error("webhook_chunk_invalid");
  const size=Number.parseInt(line.split(";")[0],16);offset=lineEnd+2;
  if(!Number.isSafeInteger(size)||size>16_384-total)throw new Error("webhook_response_too_large");
  if(size===0){
   if(bytes.length<offset+2)return null;
   if(!(bytes[offset]===13&&bytes[offset+1]===10)){
    const trailerEnd=sequenceIndex(bytes,[13,10,13,10],offset);
    if(trailerEnd<0){if(bytes.length-offset>4096)throw new Error("webhook_trailers_too_large");return null;}
    if(trailerEnd-offset>4096)throw new Error("webhook_trailers_too_large");
   }
   const output=new Uint8Array(total);let at=0;for(const part of parts){output.set(part,at);at+=part.length;}return output;
  }
  if(bytes.length<offset+size+2)return null;
  if(bytes[offset+size]!==13||bytes[offset+size+1]!==10)throw new Error("webhook_chunk_invalid");
  parts.push(bytes.subarray(offset,offset+size));total+=size;offset+=size+2;
 }
}

async function nativePinnedPost(native:NativeTransport,url:URL,address:string,init:{body:string;headers:Record<string,string>;signal:AbortSignal}):Promise<Response>{
 let connection:NativeConnection|undefined;let abortReject:((reason:Error)=>void)|undefined;
 const aborted=new Promise<never>((_,reject)=>{abortReject=reject;});
 const abort=()=>{try{connection?.close();}catch{/* already closed */}abortReject?.(new Error("webhook_timeout"));};
 init.signal.addEventListener("abort",abort,{once:true});
 const resource=async(pending:Promise<NativeConnection>)=>await Promise.race([pending.then(conn=>{if(init.signal.aborted){try{conn.close();}catch{/* already closed */}}return conn;}),aborted]);
 try{
  if(init.signal.aborted)throw new Error("webhook_timeout");
  connection=await resource(native.connect({hostname:address,port:Number(url.port||443)}));
  connection=await resource(native.startTls(connection,{hostname:url.hostname.replace(/^\[|\]$/g,""),alpnProtocols:["http/1.1"]}));
  if(!connection.handshake)throw new Error("webhook_native_tls_unsupported");
  await Promise.race([connection.handshake(),aborted]);
  const body=new TextEncoder().encode(init.body);
  const headers=Object.entries(init.headers).map(([key,value])=>{
   if(!/^[A-Za-z0-9-]+$/.test(key)||/[\r\n\x00]/.test(value)||["host","connection","content-length","transfer-encoding"].includes(key.toLowerCase()))throw new Error("webhook_request_header_forbidden");
   return `${key}: ${value}\r\n`;
  }).join("");
  const head=new TextEncoder().encode(`POST ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\nContent-Length: ${body.length}\r\n${headers}\r\n`);
  const requestBytes=joinBytes(head,body);
  for(let offset=0;offset<requestBytes.length;){const written=await Promise.race([connection.write(requestBytes.subarray(offset)),aborted]);if(written<=0)throw new Error("webhook_write_failed");offset+=written;}
  let pending=new Uint8Array(0);let status=0;let length:number|null=null;let chunked=false;let wireBytes=0;let headerBytes=0;let interims=0;
  const readBuffer=new Uint8Array(4096);
  while(true){
   const n=await Promise.race([connection.read(readBuffer),aborted]);
   if(n===null){
    if(!status||chunked||length!==null&&pending.length<length)throw new Error("webhook_response_truncated");
    return new Response(pending,{status});
   }
   wireBytes+=n;if(wireBytes>65_536)throw new Error("webhook_response_too_large");pending=joinBytes(pending,readBuffer.subarray(0,n));
   while(!status){
    const end=sequenceIndex(pending,[13,10,13,10]);
    if(end<0){if(headerBytes+pending.length>16_384)throw new Error("webhook_headers_too_large");break;}
    headerBytes+=end+4;if(headerBytes>16_384)throw new Error("webhook_headers_too_large");
    const lines=new TextDecoder().decode(pending.subarray(0,end)).split("\r\n");pending=pending.slice(end+4);
    const match=/^HTTP\/1\.[01] ([1-5][0-9]{2})(?: |$)/.exec(lines.shift()||"");if(!match)throw new Error("webhook_http_status_invalid");
    const code=Number(match[1]);
    if(code<200){if(code===101||++interims>4)throw new Error("webhook_upgrade_forbidden");continue;}
    status=code;if(status>=300&&status<400)throw new Error("webhook_redirect_forbidden");
    const responseHeaders=new Map<string,string>();
    for(const line of lines){const colon=line.indexOf(":");if(colon<1||!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(line.slice(0,colon)))throw new Error("webhook_response_header_invalid");const key=line.slice(0,colon).toLowerCase();const value=line.slice(colon+1).trim();if(responseHeaders.has(key)&&["content-length","transfer-encoding"].includes(key))throw new Error("webhook_framing_ambiguous");responseHeaders.set(key,value);}
    const rawLength=responseHeaders.get("content-length"),transfer=responseHeaders.get("transfer-encoding");
    if(rawLength!==undefined&&transfer!==undefined)throw new Error("webhook_framing_ambiguous");
    if(rawLength!==undefined){if(!/^\d+$/.test(rawLength))throw new Error("webhook_content_length_invalid");length=Number(rawLength);if(length>16_384)throw new Error("webhook_response_too_large");}
    if(transfer!==undefined){if(transfer.toLowerCase()!=="chunked")throw new Error("webhook_transfer_encoding_unsupported");chunked=true;}
    if(status===204||status===205)return new Response(null,{status});
   }
   if(!status)continue;
   if(chunked){const decoded=decodeWebhookChunks(pending);if(decoded)return new Response(decoded,{status});}
   else{
    if(length!==null&&pending.length>=length)return new Response(pending.slice(0,length),{status});
    if(pending.length>16_384)throw new Error("webhook_response_too_large");
   }
  }
 }finally{init.signal.removeEventListener("abort",abort);try{connection?.close();}catch{/* already closed */}}
}

export async function pinnedWebhookFetch(value: URL, init: { body: string; headers: Record<string,string>; signal: AbortSignal }): Promise<Response> {
  const url = webhookUrl(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    isIP(host) ? Promise.resolve([{ address: host, family: isIP(host) }]) : lookup(host, { all: true, verbatim: true }),
    new Promise<never>((_,reject) => { timeout=setTimeout(()=>reject(new Error("webhook_dns_timeout")),5000); }),
  ]).finally(()=>{ if (timeout) clearTimeout(timeout); });
  if (!addresses.length || addresses.some(({address})=>!isPublicAddress(address))) throw new Error("webhook_private_network_forbidden");
  if (init.signal.aborted) throw new Error("webhook_aborted");
  const pinned=addresses[0];
  const native=(globalThis as unknown as {Deno?:NativeTransport}).Deno;
  if(native && typeof native.connect==="function" && typeof native.startTls==="function")return await nativePinnedPost(native,url,pinned.address,init);
  // No second DNS resolution. Keep URL hostname for Host, SNI and certificate validation.
  // No shared socket pool, environment proxy or automatic redirects.
  return await new Promise<Response>((resolve,reject)=>{
    class PinnedAgent extends Agent {
      createConnection() { return connect({ host:pinned.address, port:Number(url.port||443),
        servername:isIP(host) ? undefined : host, rejectUnauthorized:true }); }
    }
    const agent = new PinnedAgent({ keepAlive:false });
    const req=request(url, { method:"POST", agent, signal:init.signal, headers:init.headers,
      rejectUnauthorized:true,
    }, res=>{
      const status=res.statusCode ?? 502;
      if (status>=300 && status<400) { res.destroy(); reject(new Error("webhook_redirect_forbidden")); return; }
      let bytes=0; const chunks: Buffer[]=[];
      res.on("data",(chunk: Buffer)=>{
        bytes+=chunk.length;
        if (bytes>16_384) { const error=new Error("webhook_response_too_large"); res.destroy(error); req.destroy(error); reject(error); return; }
        chunks.push(chunk);
      });
      res.on("error",reject);
      res.on("aborted",()=>reject(new Error("webhook_response_aborted")));
      res.on("end",()=>resolve(new Response(status===204 || status===205 ? null : Buffer.concat(chunks).toString("utf8"),{status})));
    });
    req.on("error",error=>{ agent.destroy(); reject(error); });
    req.on("close",()=>agent.destroy());
    req.end(init.body);
  });
}
