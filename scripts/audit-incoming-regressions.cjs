const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
function load(file,mocks={}){const exports={};new Function('exports','require',ts.transpileModule(fs.readFileSync(file,'utf8'),{fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(exports,id=>id in mocks?mocks[id]:require(id));return exports;}
const session='11111111-1111-4111-8111-111111111111';
const {sinchSvamlFor}=load('src/lib/telephony/sinch/svaml.ts');
const payload={originationType:'pstn',to:{type:'number',endpoint:'+46855550123'}};
const decision={incoming:true,connect:true,sessionId:session,destination:'+46855550123'};
assert.deepEqual(sinchSvamlFor('ice',payload,decision),{instructions:[],action:{name:'connectMxp',destination:{type:'userName',endpoint:session}}});
for(const bad of [{...decision,connect:false},{...decision,sessionId:'11111111----------------------------'},{...decision,destination:'+46855550999'},undefined])assert.equal(sinchSvamlFor('ice',payload,bad).action.name,'hangup');
assert.equal(sinchSvamlFor('ice',{...payload,originationType:'app'},decision).action.name,'connectPstn');

async function main(){
 let mintedIdentity;
 const provider=load('src/lib/telephony/webphone/sinch.ts',{'server-only':{},'@/lib/env':{serverEnv:()=>({SINCH_APPLICATION_KEY:'key',SINCH_APPLICATION_SECRET:'secret',SINCH_RTC_ENVIRONMENT_HOST:'test'})},'@/lib/telephony/sinch/registration-token':{mintSinchRegistrationToken:args=>{mintedIdentity=args.userId;return {token:'token',expiresAt:'later'};}}}).sinchWebphoneProvider;
 const provisioned=await provider.provision({sessionId:session,sellerUserId:'different-seller',callerIdentifier:'+46855550123'});
 assert.equal(mintedIdentity,session);assert.equal(provisioned.credentials.userId,session);
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
 const Panel=load('src/components/incoming-call-panel.tsx').IncomingCallPanel;
 const panelProps={incoming:{callId:'crm',from:'anonymous',expiresAt:'later',phase:'offered'},incomingError:null,audioError:null,acceptIncoming:async()=>{},declineIncoming:async()=>{},hangupWebphone:()=>{},audioCapabilities:{mute:true},muted:false,toggleMute:()=>{}};
 const offeredHtml=renderToStaticMarkup(React.createElement(Panel,panelProps));assert(offeredHtml.includes('Svara'));assert(offeredHtml.includes('Avvisa'));assert(offeredHtml.includes('Skyddat eller okänt nummer'));
 const answeredHtml=renderToStaticMarkup(React.createElement(Panel,{...panelProps,incoming:{...panelProps.incoming,phase:'answered'}}));assert(answeredHtml.includes('Lägg på'));assert(answeredHtml.includes('Stäng av mikrofon'));assert(!answeredHtml.includes('>Svara<'));
 const routeFile='src/app/api/v1/telephony/webphone/incoming/route.ts';let rpcCalls=[];
 const route=load(routeFile,{'next/server':{NextResponse:{json:(body,init={})=>({body,status:init.status??200})}},'@/lib/auth':{getAppContext:async()=>({role:'sales'})},'@/lib/permissions':{assertPermission:()=>{}},'@/lib/supabase/server':{createClient:async()=>({rpc:async(name,args)=>{rpcCalls.push({name,args});return {data:{available:true},error:null};}})}});
 let response=await route.POST({json:async()=>({sessionId:session,externalCallId:'external',action:'inspect',tenantId:'spoof'})});assert.equal(response.status,422);assert.equal(rpcCalls.length,0);
 response=await route.POST({json:async()=>({sessionId:session,externalCallId:'external',action:'inspect'})});assert.equal(response.status,200);assert.equal(rpcCalls[0].name,'inbound_call_command');assert.equal('p_tenant_id' in rpcCalls[0].args,false);

 let cells=[],cursor=0,providerListener,incomingListener,commands=[],audioPlays=0,inspectResolve,denyInspect=false,holdInspect=false;
 const react={useState:init=>{const n=cursor++;if(!(n in cells))cells[n]=init;return [cells[n],value=>{cells[n]=typeof value==='function'?value(cells[n]):value;}];},useRef:init=>{const n=cursor++;if(!(n in cells))cells[n]={current:init};return cells[n];},useCallback:fn=>fn,useEffect:()=>{}};
 const client={addListener:l=>providerListener=l,start:()=>{},callClient:{addListener:l=>incomingListener=l,setAudioTrackConstraints:()=>{}}};
 const builder={applicationKey(){return this;},userId(id){assert.equal(id,session);return this;},environmentHost(){return this;},callerIdentifier(){return this;},fetchApi(){return this;},mediaStreamFactory(){return this;},build:()=>client};
 const original={fetch:global.fetch,setInterval:global.setInterval,clearInterval:global.clearInterval,Audio:global.Audio};
 global.setInterval=()=>1;global.clearInterval=()=>{};global.Audio=class{};
 global.fetch=async(url,options)=>{
  const body=JSON.parse(options.body);commands.push({url,body});
  if(url.endsWith('/session'))return {ok:true,status:200,json:async()=>({sessionId:session,credentials:{kind:'sinch_rtc',applicationKey:'app',userId:session,token:'token',callerIdentifier:'+46855550123',environmentHost:'test',expiresAt:new Date(Date.now()+3600000).toISOString()}})};
  if(url.endsWith('/heartbeat'))return {ok:true,status:200,json:async()=>({alive:true})};
  if(body.action==='inspect' && holdInspect)await new Promise(resolve=>inspectResolve=resolve);
  return {ok:!denyInspect,status:denyInspect?409:200,json:async()=>({available:!denyInspect,callId:'crm-call',from:'+46700009988',expiresAt:new Date(Date.now()+60000).toISOString()})};
 };
 try{
  const hook=load('src/hooks/use-sinch-webphone.ts',{react,'sinch-rtc':{Sinch:{getSinchClientBuilder:()=>builder}},'@/lib/telephony/webphone/audio':{playRemoteStream:async()=>{audioPlays++;},clearRemoteStream:()=>{}},'./use-audio-devices':{readAudioSelection:()=>({})},'@/lib/telephony/sinch/end-cause':{}}).useSinchWebphone;
  const render=()=>{cursor=0;return hook();};const flush=async()=>{for(let n=0;n<15;n++)await Promise.resolve();};
  let voice=render();await voice.start();providerListener.onClientStarted();await flush();
  function call(id){return {id,incomingStream:{},answers:0,hangups:0,addListener(listener){this.listener=listener;},answer:async function(){this.answers++;},hangup(){this.hangups++;}};}
  // No SDK ended event: rejected/quarantined calls must still release local state.
  holdInspect=true;const first=call('first');incomingListener.onIncomingCall(null,first);voice=render();assert.equal(voice.incoming,null);first.listener.onRemoteTrack();await voice.resumeAudio();assert.equal(audioPlays,0,'No audio before authorization/accept');
  inspectResolve();holdInspect=false;await flush();voice=render();assert.equal(voice.incoming.from,'+46700009988');assert.equal(first.answers,0);
  await Promise.all([voice.acceptIncoming(),voice.acceptIncoming()]);assert.equal(first.answers,1,'Rapid double answer is fenced locally');first.listener.onCallEstablished();await flush();voice=render();assert.equal(voice.incoming.phase,'answered');assert(audioPlays>0);
  voice.hangup();voice=render();assert.equal(voice.incoming,null);assert.equal(first.hangups,1);
  const next=call('next');incomingListener.onIncomingCall(null,next);await flush();voice=render();assert(voice.incoming);first.listener.onCallEnded();voice=render();assert(voice.incoming,'Old ended event cannot clear a new call');await voice.declineIncoming();assert.equal(next.answers,0);voice=render();assert.equal(voice.incoming,null);
  denyInspect=true;const rejected=call('rejected');incomingListener.onIncomingCall(null,rejected);await flush();voice=render();assert.equal(voice.incoming,null);assert.equal(rejected.hangups,1);
  denyInspect=false;const recovered=call('recovered');incomingListener.onIncomingCall(null,recovered);await flush();voice=render();assert(voice.incoming,'Rejected SDK call without ended callback must not hold client busy');await voice.declineIncoming();
 }finally{Object.assign(global,original);}
 console.log('PASS: actual incoming SVAML, strict session API, browser quarantine, no premature audio/answer, double click, reject/decline, missing SDK ended event and late old callback.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
