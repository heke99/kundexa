import { NextResponse } from "next/server";
import { getAppContext } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptJson } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { assertPermission } from "@/lib/permissions";
export async function GET(){try{const ctx=await getAppContext();assertPermission(ctx.role,"calls.create");const admin=createAdminClient();const {data}=await admin.from('voice_clients').select('client_number_e164,sip_username,sip_password_ciphertext,websocket_url,sip_domain,status').eq('tenant_id',ctx.tenantId).eq('assigned_user_id',ctx.userId).eq('status','active').maybeSingle();if(!data)return NextResponse.json({error:'voice_client_not_configured'},{status:404});const secret=decryptJson<{password:string}>(data.sip_password_ciphertext,serverEnv().KUNDEXA_ENCRYPTION_KEY);return NextResponse.json({clientNumber:data.client_number_e164,username:data.sip_username,password:secret.password,websocketUrl:data.websocket_url,domain:data.sip_domain})}catch{return NextResponse.json({error:'internal_error'},{status:500})}}
