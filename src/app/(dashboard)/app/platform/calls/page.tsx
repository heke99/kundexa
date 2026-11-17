import {getPlatformContext,isPlatformAdmin} from "@/lib/auth";
import {redirect} from "next/navigation";
import {PageHeader} from "@/components/ui/page-header";
import {CallHistorySearch} from "@/components/call-history-search";
import type {HistoryParams} from "@/lib/calls/history-search";
export default async function Page({searchParams}:{searchParams:Promise<HistoryParams>}) {
 const context=await getPlatformContext();if(!isPlatformAdmin(context.platformRole))redirect("/app/platform");
 return <><PageHeader title="Samtalsregister – klagomål" description="Sök registrerade samtal i plattformen. Åtkomst kräver tvåstegsverifiering och sökningarna loggas."/><CallHistorySearch params={await searchParams} timeZone="Europe/Stockholm" platform/></>;
}
