"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
export function MfaForm() {
 const [factor,setFactor]=useState("");const [qr,setQr]=useState("");const [secret,setSecret]=useState("");
 const [error,setError]=useState("");const [code,setCode]=useState("");const [busy,setBusy]=useState(false);const [loaded,setLoaded]=useState(false);
 useEffect(()=>{let active=true;void createClient().auth.mfa.listFactors().then(result=>{
  if(!active)return;if(result.error)setError("Säkerhetsmetoderna kunde inte läsas. Läs om sidan.");
  else setFactor(result.data.totp.find(f=>f.status==='verified')?.id ?? "");setLoaded(true);
 }).catch(()=>{if(active){setError("Säkerhetsmetoderna kunde inte läsas. Läs om sidan.");setLoaded(true);}});return()=>{active=false;};},[]);
 async function enroll(){setBusy(true);setError("");try {
  const result=await createClient().auth.mfa.enroll({factorType:"totp",friendlyName:`Kundexa ${new Date().toISOString()}`});
  if(result.error){setError("Säkerhetsmetoden kunde inte skapas. Försök igen.");return;}
  setFactor(result.data.id);setQr(result.data.totp.qr_code);setSecret(result.data.totp.secret);
 }catch{setError("Förfrågan kunde inte slutföras. Försök igen.");}finally{setBusy(false);}}
 async function verify(event:React.FormEvent){event.preventDefault();setBusy(true);setError("");try {
  const result=await createClient().auth.mfa.challengeAndVerify({factorId:factor,code});
  if(result.error){setError("Koden kunde inte verifieras. Kontrollera koden och tiden i autentiseringsappen.");return;}
  // Full navigation makes the server and DB evaluate the refreshed AAL2 session.
  window.location.assign("/app");
 }catch{setError("Förfrågan kunde inte slutföras. Försök igen.");}finally{setBusy(false);}}
 return <><h2>Tvåstegsverifiering</h2>{error?<p className="form-error">{error}</p>:null}{!loaded?<p>Läser säkerhetsmetoder…</p>:!factor?<button type="button" disabled={busy} className="button button-primary" onClick={enroll}>Lägg till autentiseringsapp</button>:<>{qr?<><p>Skanna QR-koden i din autentiseringsapp och bekräfta med en kod.</p>{/* Auth-generated QR; no external image host receives the enrolment secret. */}<img src={qr.startsWith("data:image/svg+xml;") ? qr : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr)}`} width={220} height={220} alt="QR-kod för autentiseringsapp"/><details><summary>Lägg till nyckeln manuellt</summary><code>{secret}</code></details></>:null}<form onSubmit={verify} className="form-stack"><label className="field"><span>Engångskod</span><input value={code} onChange={e=>setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required/></label><button disabled={busy} className="button button-primary" type="submit">Verifiera</button></form></>}<p>Har du förlorat din autentiseringsapp? Kontakta Kundexas plattformsadministratör för identitetskontrollerad återställning.</p></>;
}
