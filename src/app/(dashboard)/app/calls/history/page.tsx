import {getAppContext} from "@/lib/auth";
import {assertPermission} from "@/lib/permissions";
import {PageHeader} from "@/components/ui/page-header";
import {CallHistorySearch} from "@/components/call-history-search";
import type {HistoryParams} from "@/lib/calls/history-search";
export default async function Page({searchParams}:{searchParams:Promise<HistoryParams>}) {
 const context=await getAppContext();assertPermission(context.role,"calls.read");
 return <><PageHeader title="Sök samtal" description="Samtalshistorik för uppföljning och klagomål, inom din behörighet."/><CallHistorySearch params={await searchParams} timeZone={context.tenantTimezone}/></>;
}
