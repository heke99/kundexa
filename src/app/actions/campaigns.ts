"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { assertPermission } from "@/lib/permissions";
const v=(f:FormData,k:string)=>String(f.get(k)??'').trim();
export async function createCampaign(f:FormData){const ctx=await getAppContext();assertPermission(ctx.role,"campaigns.manage");const name=v(f,'name');if(!name)redirect('/app/campaigns?error=Namn krävs');const s=await createClient();const {error}=await s.from('campaigns').insert({tenant_id:ctx.tenantId,name,description:v(f,'description')||null,status:'draft',max_attempts:Number(v(f,'max_attempts')||7),allowed_start_time:v(f,'start_time')||'09:00',allowed_end_time:v(f,'end_time')||'18:00',created_by:ctx.userId});if(error)redirect(`/app/campaigns?error=${encodeURIComponent(error.message)}`);revalidatePath('/app/campaigns');redirect('/app/campaigns')}
