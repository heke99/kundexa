"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { assertPermission } from "@/lib/permissions";
const v=(f:FormData,k:string)=>String(f.get(k)??'').trim();
export async function createCampaign(f:FormData){const ctx=await getAppContext();assertPermission(ctx.role,"campaigns.manage");const name=v(f,'name');if(!name)redirect('/app/campaigns?error=Namn krävs');const s=await createClient();const {error}=await s.from('campaigns').insert({tenant_id:ctx.tenantId,name,description:v(f,'description')||null,status:'draft',max_attempts:Number(v(f,'max_attempts')||7),allowed_start_time:v(f,'start_time')||'09:00',allowed_end_time:v(f,'end_time')||'18:00',created_by:ctx.userId});if(error)redirect(`/app/campaigns?error=${encodeURIComponent(error.message)}`);revalidatePath('/app/campaigns');redirect('/app/campaigns')}

// Kampanjens team. En lista som delas med kampanjen når de här teamen.
// Behörigheten avgörs i databasen: en administratör väljer fritt, en
// teamledare lägger till och tar bort bara team hen själv leder.
export async function setCampaignTeams(f: FormData) {
  const ctx = await getAppContext();
  assertPermission(ctx.role, "campaigns.manage");
  const campaignId = v(f, "campaign_id");
  if (!campaignId) redirect("/app/campaigns?error=Kampanjen saknas");
  const teamIds = f.getAll("team_ids").map(String).filter(Boolean);
  const s = await createClient();
  const { data, error } = await s.rpc("set_campaign_teams", { p_campaign_id: campaignId, p_team_ids: teamIds });
  if (error) redirect(`/app/campaigns?error=${encodeURIComponent(campaignTeamsError(error.message))}`);
  const released = Number((data as { releasedClaims?: number } | null)?.releasedClaims ?? 0);
  revalidatePath("/app/campaigns");
  revalidatePath("/app/lists");
  revalidatePath("/app/dialer");
  const message = released
    ? `Kampanjens team är sparade. ${released} låsta prospekt släpptes från säljare som inte längre har listan.`
    : "Kampanjens team är sparade. Listor som delas med kampanjen når de här teamen.";
  redirect(`/app/campaigns?message=${encodeURIComponent(message)}`);
}

function campaignTeamsError(code: string) {
  if (code.includes("campaign_team_permission_required")) return "Du kan bara lägga till och ta bort team du själv leder.";
  if (code.includes("team_not_found")) return "Teamet finns inte eller är inte aktivt.";
  if (code.includes("campaign_not_found")) return "Kampanjen finns inte.";
  return "Kampanjens team kunde inte sparas.";
}
