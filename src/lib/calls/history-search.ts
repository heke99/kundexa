import { z } from "zod";
import { zonedLocalDateTimeToIso, isoToZonedLocalDateTime } from "@/lib/domain/time";
export type HistoryParams = {q?:string;from?:string;to?:string;page?:string};
export function historyFilters(params: HistoryParams, timeZone: string, now = new Date()) {
 const schema=z.object({q:z.string().trim().max(120).refine(v=>v.length===0||v.length>=2),page:z.coerce.number().int().min(1).max(2001)});
 const input=schema.parse({q:params.q??"",page:params.page??"1"});
 const from=params.from??isoToZonedLocalDateTime(new Date(now.getTime()-30*86400000).toISOString(),timeZone);
 const to=params.to??isoToZonedLocalDateTime(now.toISOString(),timeZone);
 const since=zonedLocalDateTimeToIso(from,timeZone),until=new Date(Date.parse(zonedLocalDateTimeToIso(to,timeZone))+60000).toISOString();
 if(Date.parse(since)>=Date.parse(until)||Date.parse(until)-Date.parse(since)>366*86400000)throw Error("invalid_history_range");
 return {query:input.q,page:input.page,from,to,since,until,offset:(input.page-1)*50};
}
