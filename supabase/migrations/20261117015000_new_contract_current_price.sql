begin;
-- Old versions remain valid evidence for existing drafts/agreements. A newly
-- created product agreement, however, must start from the current price; keeping
-- historical prices must not let a direct RPC caller choose a superseded rate.
create function public.enforce_new_contract_current_price() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.contract_versions%rowtype; c public.contracts%rowtype; v_current uuid;
begin
 select * into v from public.contract_versions where tenant_id=new.tenant_id and id=new.id;
 if not found or v.version<>1 or v.template_version_id is null or v.price_version_id is null then return null; end if;
 select * into c from public.contracts where tenant_id=v.tenant_id and id=v.contract_id;
 if not found or c.product_id is null then return null; end if;
 perform 1 from public.products where tenant_id=c.tenant_id and id=c.product_id for update;
 -- Leave missing/expired/cross-product failures to the canonical readiness guard.
 if not exists(select 1 from public.product_price_versions where tenant_id=c.tenant_id and product_id=c.product_id
   and id=v.price_version_id and active and valid_from<=current_date and (valid_to is null or valid_to>=current_date)) then return null; end if;
 select id into v_current from public.product_price_versions where tenant_id=c.tenant_id and product_id=c.product_id
   and active and valid_from<=current_date and (valid_to is null or valid_to>=current_date) order by version desc limit 1;
 if v.price_version_id is distinct from v_current then raise exception 'contract_current_price_required'; end if;
 return null;
end $$;
revoke all on function public.enforce_new_contract_current_price() from public,anon,authenticated,service_role;
create constraint trigger contract_version_current_price after insert on public.contract_versions
 deferrable initially deferred for each row execute function public.enforce_new_contract_current_price();
commit;
