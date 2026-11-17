import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Field } from "@/components/ui/form-field";
import { callStatusLabel,dispositionLabel } from "@/lib/ui/labels";
import { historyFilters,type HistoryParams } from "@/lib/calls/history-search";

type HistoryRow={id:string;tenant_name:string;customer_name:string|null;contact_name:string|null;seller_name:string|null;seller_id:string|null;team_name:string|null;from_number:string;to_number:string;direction:string;status:string;disposition:string|null;started_at:string;answered_at:string|null;ended_at:string|null;duration_seconds:number|null};
export async function CallHistorySearch({params,timeZone,platform=false}:{params:HistoryParams;timeZone:string;platform?:boolean}) {
 let filters;let invalid=false;try{filters=historyFilters(params,timeZone);}catch{filters=historyFilters({},timeZone);invalid=true;}
 const db=await createClient();const {data,error}=invalid?{data:{data:[],total:0},error:null}:await db.rpc("search_call_history",{p_query:filters.query,p_from:filters.since,p_to:filters.until,p_limit:50,p_offset:filters.offset,p_platform:platform});
 if(error)throw Error("call_history_search_unavailable");
 const result=data as unknown as {data:HistoryRow[];total:number};
 const formatter=new Intl.DateTimeFormat("sv-SE",{timeZone,dateStyle:"short",timeStyle:"long"});
 const base=platform?"/app/platform/calls":"/app/calls/history";
 const href=(page:number)=>`${base}?${new URLSearchParams({q:filters.query,from:filters.from,to:filters.to,page:String(page)})}`;
 return <>
  {invalid?<p className="form-error">Kontrollera söktext, datum och tid. Sök högst366 dagar åt gången. Formuläret har återställts så att du kan söka igen.</p>:null}
  <form method="get" className="form-grid" action={base}>
   <Field label="Nummer, kundnamn eller säljare" name="q" defaultValue={filters.query} minLength={2} maxLength={120}/>
   <Field label={`Från (${timeZone})`} name="from" type="datetime-local" defaultValue={filters.from} required/>
   <Field label="Till och med angiven minut" name="to" type="datetime-local" defaultValue={filters.to} required/>
   <button className="button button-primary" type="submit">Sök samtal</button>
  </form>
  <p className="muted">Sökningen avser samtalets starttid. Datum och klockslag visas i {timeZone}. Inkommande, utgående och manuellt registrerade samtal ingår inom din behörighet. Namn visas från aktuella kund- och användarkort.</p>
  <p>{result.total} träffar · sida {filters.page}</p>
  <div style={{overflowX:"auto"}}><table className="data-table"><thead><tr>{[...(platform?["Organisation"]:[]),"Kund / kontakt","Från / till","Säljare / team","Start","Svar / slut","Längd","Status / utfall","Referens"].map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>
   {result.data.map(call=><tr key={call.id}>
    {platform?<td>{call.tenant_name}</td>:null}
    <td>{call.customer_name??"Ej kopplad kund"}{call.contact_name?<><br/>{call.contact_name}</>:null}</td>
    <td>{call.from_number}<br/>{call.to_number}<br/>{call.direction==="inbound"?"Inkommande":"Utgående"}</td>
    <td>{call.seller_name??"Säljarnamn saknas"}<br/>{call.team_name??"Inget team"}{call.seller_id?<details><summary>Säljarreferens</summary><code>{call.seller_id}</code></details>:null}</td>
    <td>{formatter.format(new Date(call.started_at))}</td>
    <td>{call.answered_at?formatter.format(new Date(call.answered_at)):"Ej besvarat"}<br/>{call.ended_at?formatter.format(new Date(call.ended_at)):"Ej avslutat"}</td>
    <td>{call.duration_seconds===null?"Ej rapporterad":`${call.duration_seconds} s`}</td>
    <td>{callStatusLabel(call.status)}<br/>{dispositionLabel(call.disposition)}</td>
    <td>{platform?<code>{call.id}</code>:<Link href={`/app/calls/${call.id}`}>Öppna samtal</Link>}<details><summary>Samtalsreferens</summary><code>{call.id}</code></details></td>
   </tr>)}
  </tbody></table></div>
  {result.data.length===0?<p>Inga samtal matchade sökningen inom din behörighet.</p>:null}
  <div className="toolbar">{filters.page>1?<Link className="button button-secondary" href={href(filters.page-1)}>Föregående</Link>:null}{filters.page<2001 && result.data.length===50 && filters.offset+50<result.total?<Link className="button button-secondary" href={href(filters.page+1)}>Nästa</Link>:null}</div>
 </>;
}
