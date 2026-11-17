import { getAppContext, isAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getAppContext();
  if (!isAdmin(context.role)) return new Response(null, { status: 403 });
  const { id } = await params;
  const admin = createAdminClient();
  const { data: request, error } = await admin.from("data_subject_requests").select("result_storage_path,identity_verified_at,request_type").eq("tenant_id",context.tenantId).eq("id",id).maybeSingle();
  const path = request?.result_storage_path;
  if (error || !path || !request.identity_verified_at || !["access","portability"].includes(request.request_type) || !path.startsWith(`${context.tenantId}/dsar/${id}/`)) return new Response(null,{status:404});
  const { data, error: downloadError } = await admin.storage.from("compliance-exports").download(path);
  if (downloadError || !data) return new Response(null,{status:503});
  const { error: auditError } = await admin.from("audit_logs").insert({tenant_id:context.tenantId,actor_user_id:context.userId,action:"privacy.export_downloaded",entity_type:"data_subject_request",entity_id:id});
  if (auditError) return new Response(null,{status:503});
  return new Response(data,{headers:{"Content-Type":"application/json","Content-Disposition":"attachment; filename=kundexa-export.json","Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
}
