begin;

-- Avtalet hör till produkten.
--
-- Mallar och produkter levde var för sig: säljaren valde "vilken mall" och
-- "vilken produkt" i två listor, och ingenting hindrade att elavtalets mall
-- skickades med bredbandets pris. Nu bär mallen den produkt den gäller, och en
-- produkt har högst ett aktivt avtal. Säljaren väljer produkten; avtalet följer.
alter table public.contract_templates add column if not exists product_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname='contract_templates_product_tenant_fk') then
    -- Kolumnlistan i `set null` betyder att bara produktkopplingen släpps om
    -- produkten tas bort. Utan den skulle den sammansatta nyckeln även nolla
    -- tenant_id, och raden skulle bryta sin egen tenantgräns.
    alter table public.contract_templates add constraint contract_templates_product_tenant_fk
      foreign key (tenant_id,product_id) references public.products(tenant_id,id) on delete set null (product_id);
  end if;
end
$$;

create unique index if not exists contract_templates_one_active_per_product_uidx
  on public.contract_templates(tenant_id,product_id)
  where product_id is not null and active;

-- Skapa en ny version av produktens avtal, i samma transaktion som kopplingen.
--
-- Ett avtal som skapas men inte hinner kopplas är en mall ingen kan välja. Den
-- befintliga funktionen gör versionen; den här gör versionen och kopplingen
-- eller ingenting.
create or replace function public.create_product_contract_template_version(
  p_product_id uuid,
  p_template_id uuid,
  p_name text,
  p_contract_type text,
  p_audience text,
  p_description text,
  p_legal_entity_id uuid,
  p_title_template text,
  p_body_template text,
  p_terms_template text,
  p_variables jsonb default '[]'::jsonb,
  p_variables_schema jsonb default '{}'::jsonb,
  p_signing_configuration jsonb default '{}'::jsonb
)
returns uuid
language plpgsql security definer set search_path=public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_version_id uuid;
  v_template uuid;
  v_previous_product uuid;
begin
  if v_user is null or v_tenant is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin','contract_manager','team_lead']) then
    raise exception 'contract_template_permission_required';
  end if;
  if p_product_id is null then raise exception 'contract_template_product_required'; end if;
  -- Produkten måste vara det egna företagets. Ett id från en annan tenant ska
  -- se ut precis som ett id som inte finns.
  if not exists(select 1 from public.products where tenant_id=v_tenant and id=p_product_id) then
    raise exception 'product_not_found';
  end if;
  if p_template_id is not null then
    select product_id into v_previous_product from public.contract_templates
      where tenant_id=v_tenant and id=p_template_id for update;
    if not found then raise exception 'contract_template_not_found'; end if;
  end if;
  -- Den andra mallen på samma produkt ger annars ett råfel från det unika
  -- indexet. Ett namngivet fel går att förklara för den som sitter framför det.
  if exists(
    select 1 from public.contract_templates
    where tenant_id=v_tenant and product_id=p_product_id and active
      and id is distinct from p_template_id
  ) then
    raise exception 'product_already_has_contract';
  end if;

  v_version_id := public.create_contract_template_version(
    p_template_id,p_name,p_contract_type,p_audience,p_description,p_legal_entity_id,
    p_title_template,p_body_template,p_terms_template,p_variables,p_variables_schema,p_signing_configuration
  );
  select template_id into v_template from public.contract_template_versions where id=v_version_id;

  update public.contract_templates set product_id=p_product_id,updated_at=now()
    where tenant_id=v_tenant and id=v_template;
  if v_previous_product is distinct from p_product_id then
    insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,before_data,after_data)
      values(v_tenant,v_user,'contract_template.product_linked','contract_template',v_template::text,
        jsonb_build_object('product_id',v_previous_product),jsonb_build_object('product_id',p_product_id));
  end if;
  return v_version_id;
end
$$;

revoke all on function public.create_product_contract_template_version(uuid,uuid,text,text,text,text,uuid,text,text,text,jsonb,jsonb,jsonb) from public,anon;
grant execute on function public.create_product_contract_template_version(uuid,uuid,text,text,text,text,uuid,text,text,text,jsonb,jsonb,jsonb) to authenticated;

-- Ett avtal följer sin produkt, också i databasen.
--
-- Formuläret väljer mallen utifrån produkten, men ett formulär är inte en
-- gräns. Mallen som hör till en produkt får bara användas med den produkten,
-- och en produkt som har ett avtal får bara säljas med det avtalet.
create or replace function public.enforce_contract_product_template() returns trigger
language plpgsql set search_path=public
as $$
declare
  v_template_product uuid;
  v_product_template uuid;
begin
  if new.template_id is not null then
    select product_id into v_template_product from public.contract_templates
      where tenant_id=new.tenant_id and id=new.template_id;
    if v_template_product is not null and v_template_product is distinct from new.product_id then
      raise exception 'contract_template_belongs_to_other_product';
    end if;
  end if;
  if new.product_id is not null then
    select id into v_product_template from public.contract_templates
      where tenant_id=new.tenant_id and product_id=new.product_id and active;
    if v_product_template is not null and v_product_template is distinct from new.template_id then
      raise exception 'contract_product_requires_its_contract';
    end if;
  end if;
  return new;
end
$$;

revoke all on function public.enforce_contract_product_template() from public,anon,authenticated;

drop trigger if exists contracts_enforce_product_template on public.contracts;
create trigger contracts_enforce_product_template
  before insert on public.contracts
  for each row execute function public.enforce_contract_product_template();

commit;
