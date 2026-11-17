begin;
create table private.product_price_revision_requests (
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 request_key uuid not null,product_id uuid not null,base_price_id uuid not null,new_price_id uuid not null,
 binding_months integer,notice_months integer,payment_terms_days integer not null,
 created_at timestamptz not null default now(),primary key(tenant_id,request_key),
 foreign key(tenant_id,product_id) references public.products(tenant_id,id),
 foreign key(tenant_id,base_price_id) references public.product_price_versions(tenant_id,id),
 foreign key(tenant_id,new_price_id) references public.product_price_versions(tenant_id,id)
);
alter table private.product_price_revision_requests enable row level security;
revoke all on private.product_price_revision_requests from public,anon,authenticated,service_role;

create function public.revise_product_contract_terms(
 p_product_id uuid,p_expected_price_id uuid,p_binding_months integer,p_notice_months integer,
 p_payment_terms_days integer,p_request_key uuid
) returns uuid language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_tenant uuid:=public.current_tenant_id(); v_actor uuid:=auth.uid();
 v_base public.product_price_versions%rowtype; v_request private.product_price_revision_requests%rowtype;
 v_new uuid; v_version integer;
begin
 if v_tenant is null or v_actor is null then raise exception 'authentication_required'; end if;
 if not public.has_current_role(array['owner','admin']) then raise exception 'product_manage_permission_required'; end if;
 if p_request_key is null then raise exception 'price_revision_request_key_required'; end if;
 if p_binding_months<0 or p_binding_months>240 or p_notice_months<0 or p_notice_months>120
   or p_payment_terms_days is null or p_payment_terms_days<0 or p_payment_terms_days>365 then raise exception 'product_contract_terms_invalid'; end if;
 perform 1 from public.products where tenant_id=v_tenant and id=p_product_id for update;
 if not found then raise exception 'product_not_found'; end if;
 select * into v_request from private.product_price_revision_requests where tenant_id=v_tenant and request_key=p_request_key;
 if found then
   if row(v_request.product_id,v_request.base_price_id,v_request.binding_months,v_request.notice_months,v_request.payment_terms_days)
     is distinct from row(p_product_id,p_expected_price_id,p_binding_months,p_notice_months,p_payment_terms_days) then
     raise exception 'price_revision_idempotency_conflict';
   end if;
   return v_request.new_price_id;
 end if;
 select * into v_base from public.product_price_versions where tenant_id=v_tenant and product_id=p_product_id and active
   and valid_from<=current_date and (valid_to is null or valid_to>=current_date) order by version desc limit 1 for share;
 if not found then raise exception 'product_effective_price_required'; end if;
 if p_expected_price_id is distinct from v_base.id then raise exception 'price_version_changed_reload'; end if;
 if exists(select 1 from public.product_price_versions where tenant_id=v_tenant and product_id=p_product_id and active and valid_from>current_date) then
   raise exception 'scheduled_price_version_requires_review';
 end if;
 select coalesce(max(version),0)+1 into v_version from public.product_price_versions where tenant_id=v_tenant and product_id=p_product_id;
 insert into public.product_price_versions(tenant_id,product_id,version,currency,setup_fee,recurring_fee,recurring_interval,
  variable_fees,discounts,binding_months,notice_months,payment_terms_days,terms,valid_from,valid_to,active)
 values(v_tenant,p_product_id,v_version,v_base.currency,v_base.setup_fee,v_base.recurring_fee,v_base.recurring_interval,
  v_base.variable_fees,v_base.discounts,p_binding_months,p_notice_months,p_payment_terms_days,v_base.terms,current_date,v_base.valid_to,true)
 returning id into v_new;
 insert into private.product_price_revision_requests(tenant_id,request_key,product_id,base_price_id,new_price_id,binding_months,notice_months,payment_terms_days)
 values(v_tenant,p_request_key,p_product_id,v_base.id,v_new,p_binding_months,p_notice_months,p_payment_terms_days);
 insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,before_data,after_data)
 values(v_tenant,v_actor,'product.contract_terms_revised','product',p_product_id::text,
  jsonb_build_object('price_version_id',v_base.id,'binding_months',v_base.binding_months,'notice_months',v_base.notice_months,'payment_terms_days',v_base.payment_terms_days),
  jsonb_build_object('price_version_id',v_new,'version',v_version,'binding_months',p_binding_months,'notice_months',p_notice_months,'payment_terms_days',p_payment_terms_days));
 return v_new;
end $$;
revoke all on function public.revise_product_contract_terms(uuid,uuid,integer,integer,integer,uuid) from public,anon,service_role;
grant execute on function public.revise_product_contract_terms(uuid,uuid,integer,integer,integer,uuid) to authenticated;
commit;
