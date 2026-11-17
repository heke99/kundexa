begin;

-- No existing commercial data is rewritten. Enforce readiness at future approval,
-- binding, price publication and draft creation, including direct table writes.
create function public.assert_contract_readiness(
  p_tenant uuid, p_product uuid, p_title text, p_body text, p_terms text,
  p_price jsonb default null
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_price jsonb := p_price;
  v_name text;
  v_terms text := btrim(regexp_replace(coalesce(p_terms,''),'<[^>]*>',' ','g'));
begin
  perform 1 from public.products where tenant_id=p_tenant and id=p_product and active for update;
  if not found then raise exception 'contract_active_product_required'; end if;
  if nullif(btrim(regexp_replace(coalesce(p_title,''),'<[^>]*>',' ','g')),'') is null
    or nullif(btrim(regexp_replace(coalesce(p_body,''),'<[^>]*>',' ','g')),'') is null then
    raise exception 'contract_complete_content_required';
  end if;
  if v_terms='' or v_terms ~* '(här[[:space:]]+ska|\mTODO\M|\mTBD\M|\[fyll[[:space:]]+i)' then
    raise exception 'contract_final_terms_required';
  end if;
  if v_price is null then
    select to_jsonb(p) into v_price from public.product_price_versions p
      where p.tenant_id=p_tenant and p.product_id=p_product and p.active
        and p.valid_from<=current_date and (p.valid_to is null or p.valid_to>=current_date)
      order by p.version desc limit 1 for share;
  end if;
  if v_price is null or jsonb_typeof(v_price)<>'object' then raise exception 'contract_effective_price_required'; end if;
  -- Exact same required syntax as the renderer: ?fallback is optional. A field
  -- used both optionally and required is still required. Numeric zero is valid.
  for v_name in select distinct m[1] from regexp_matches(
    coalesce(p_title,'')||E'\n'||coalesce(p_body,'')||E'\n'||coalesce(p_terms,''),
    '\{\{[[:space:]]*price\.([a-zA-Z0-9_.-]+)[[:space:]]*\}\}', 'g') as m
  loop
    if v_price->v_name is null or v_price->v_name='null'::jsonb or v_price->>v_name='' then
      raise exception 'contract_required_price_value_missing:%',v_name;
    end if;
  end loop;
end $$;
revoke all on function public.assert_contract_readiness(uuid,uuid,text,text,text,jsonb) from public,anon,authenticated,service_role;

create function public.enforce_template_readiness() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_product uuid; v_version public.contract_template_versions%rowtype;
begin
  if tg_table_name='contract_template_versions' then
    if new.status='approved' and (tg_op='INSERT' or old.status is distinct from new.status) then
      select product_id into v_product from public.contract_templates where tenant_id=new.tenant_id and id=new.template_id;
      perform public.assert_contract_readiness(new.tenant_id,v_product,new.title_template,new.body_template,new.terms_template);
    end if;
  elsif new.active and new.current_version_id is not null and
    (tg_op='INSERT' or not old.active or row(old.current_version_id,old.product_id) is distinct from row(new.current_version_id,new.product_id)) then
    select * into v_version from public.contract_template_versions where tenant_id=new.tenant_id and template_id=new.id and id=new.current_version_id and status='approved';
    if not found then raise exception 'approved_contract_template_required'; end if;
    perform public.assert_contract_readiness(new.tenant_id,new.product_id,v_version.title_template,v_version.body_template,v_version.terms_template);
  end if;
  return new;
end $$;
revoke all on function public.enforce_template_readiness() from public,anon,authenticated,service_role;
create trigger template_version_readiness before insert or update on public.contract_template_versions
  for each row execute function public.enforce_template_readiness();
create trigger template_binding_readiness before insert or update on public.contract_templates
  for each row execute function public.enforce_template_readiness();

create function public.enforce_price_template_readiness() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_version public.contract_template_versions%rowtype;
begin
  if not new.active then return new; end if;
  for v_version in select v.* from public.contract_templates t
    join public.contract_template_versions v on v.tenant_id=t.tenant_id and v.template_id=t.id and v.id=t.current_version_id and v.status='approved'
    where t.tenant_id=new.tenant_id and t.product_id=new.product_id and t.active
  loop
    perform public.assert_contract_readiness(new.tenant_id,new.product_id,v_version.title_template,v_version.body_template,v_version.terms_template,to_jsonb(new));
  end loop;
  return new;
end $$;
revoke all on function public.enforce_price_template_readiness() from public,anon,authenticated,service_role;
create trigger price_template_readiness before insert or update on public.product_price_versions
  for each row execute function public.enforce_price_template_readiness();

-- A deferred constraint sees the final version, after v1 creates it and v2 binds
-- its template in the same transaction. Historical documents are not rewritten.
create function public.enforce_contract_version_readiness() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.contract_versions%rowtype; c public.contracts%rowtype;
  t public.contract_templates%rowtype; tv public.contract_template_versions%rowtype; p jsonb;
begin
  select * into v from public.contract_versions where tenant_id=new.tenant_id and id=new.id;
  if not found then return null; end if;
  select * into c from public.contracts where tenant_id=v.tenant_id and id=v.contract_id;
  if v.template_version_id is null then
    if c.template_id is not null then raise exception 'approved_contract_template_required'; end if;
    return null;
  end if;
  select * into t from public.contract_templates where tenant_id=c.tenant_id and id=c.template_id;
  if not found or t.product_id is distinct from c.product_id then raise exception 'contract_template_belongs_to_other_product'; end if;
  select * into tv from public.contract_template_versions where tenant_id=v.tenant_id and id=v.template_version_id and template_id=t.id and status='approved';
  if not found then raise exception 'approved_contract_template_required'; end if;
  select to_jsonb(pv) into p from public.product_price_versions pv where pv.tenant_id=c.tenant_id and pv.product_id=c.product_id
    and pv.id=v.price_version_id and pv.active and pv.valid_from<=current_date and (pv.valid_to is null or pv.valid_to>=current_date) for share;
  if p is null then raise exception 'contract_effective_price_required'; end if;
  perform public.assert_contract_readiness(c.tenant_id,c.product_id,tv.title_template,tv.body_template,tv.terms_template,p);
  return null;
end $$;
revoke all on function public.enforce_contract_version_readiness() from public,anon,authenticated,service_role;
create constraint trigger contract_version_readiness after insert or update of template_version_id,price_version_id on public.contract_versions
  deferrable initially deferred for each row execute function public.enforce_contract_version_readiness();

commit;
