"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { assertPermission } from "@/lib/permissions";
const v=(f:FormData,k:string)=>String(f.get(k)??'').trim();
export async function createProduct(f:FormData){const ctx=await getAppContext();assertPermission(ctx.role,"products.manage");const name=v(f,'name');if(!name)redirect('/app/products?error=Produktnamn krävs');const s=await createClient();const {data,error}=await s.from('products').insert({tenant_id:ctx.tenantId,name,sku:v(f,'sku')||null,description:v(f,'description')||null,product_type:v(f,'product_type')||'service'}).select('id').single();if(error)redirect(`/app/products?error=${encodeURIComponent(error.message)}`);const recurring=Number(v(f,'recurring_fee')||0);const setup=Number(v(f,'setup_fee')||0);await s.from('product_price_versions').insert({tenant_id:ctx.tenantId,product_id:data.id,version:1,setup_fee:setup,recurring_fee:recurring,recurring_interval:recurring?'month':null,binding_months:Number(v(f,'binding_months')||0)||null,notice_months:Number(v(f,'notice_months')||0)||null});await s.from('audit_logs').insert({tenant_id:ctx.tenantId,actor_user_id:ctx.userId,action:'product.created',entity_type:'product',entity_id:data.id});revalidatePath('/app/products');redirect('/app/products')}
