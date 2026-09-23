begin;

-- Avtalet och produkten kontrolleras när transaktionen är klar, inte när raden föds.
--
-- 202609220003 lade kontrollen som en BEFORE INSERT-trigger. Men
-- `create_contract_draft` skapar avtalsraden utan `template_id`; mallen sätts
-- först av `create_contract_draft_v2` i en UPDATE strax efter. När raden föddes
-- hade produkten alltså ett aktivt avtal medan raden ännu saknade mall, och
-- varje avtal som skapades från en produkt stoppades med
-- `contract_product_requires_its_contract` (FAILURE-0101). Testet skapade bara
-- avtal utan produkt och såg det aldrig.
--
-- Nu är det en uppskjuten constraint-trigger. Den körs vid commit, läser om
-- raden och ser det avtal som faktiskt sparas. Samma regel gäller även när
-- produkten eller mallen ändras i efterhand.
create or replace function public.enforce_contract_product_template() returns trigger
language plpgsql security definer set search_path=public
as $$
declare
  v_contract record;
  v_template_product uuid;
  v_product_template uuid;
begin
  select tenant_id, product_id, template_id into v_contract from public.contracts where id=new.id;
  -- Raden togs bort i samma transaktion: inget avtal sparas, inget att pröva.
  if not found then return null; end if;
  if v_contract.template_id is not null then
    select product_id into v_template_product from public.contract_templates
      where tenant_id=v_contract.tenant_id and id=v_contract.template_id;
    if v_template_product is not null and v_template_product is distinct from v_contract.product_id then
      raise exception 'contract_template_belongs_to_other_product';
    end if;
  end if;
  if v_contract.product_id is not null then
    select id into v_product_template from public.contract_templates
      where tenant_id=v_contract.tenant_id and product_id=v_contract.product_id and active;
    if v_product_template is not null and v_product_template is distinct from v_contract.template_id then
      raise exception 'contract_product_requires_its_contract';
    end if;
  end if;
  return null;
end
$$;
revoke all on function public.enforce_contract_product_template() from public, anon, authenticated;

drop trigger if exists contracts_enforce_product_template on public.contracts;
create constraint trigger contracts_enforce_product_template
  after insert or update of product_id, template_id on public.contracts
  deferrable initially deferred
  for each row execute function public.enforce_contract_product_template();

-- Avtalsansvariga får skapa avtal.
--
-- Sidan och `create_contract_draft_v3` släpper in `contract_manager`, men den
-- inre `create_contract_draft` krävde `can_write_customer`, vars rollista inte
-- har rollen. Avtalsansvariga fick därför alltid
-- `customer_write_permission_required` (FAILURE-0123). Rollen får fortfarande
-- inte ändra kundkortet. Den behöver bara kunna se kunden avtalet gäller.
do $migration$
declare
  v_definition text;
  v_anchor constant text := $a$  if not public.can_write_customer(p_customer_id) then raise exception 'customer_write_permission_required'; end if;$a$;
begin
  select pg_get_functiondef('public.create_contract_draft(text,uuid,uuid,uuid,text,text,text,jsonb,text,text)'::regprocedure) into v_definition;
  if position('contract_manager_may_draft' in v_definition) > 0 then return; end if;
  if position(v_anchor in v_definition) = 0 then raise exception 'create_contract_draft_anchor_missing'; end if;
  execute replace(v_definition, v_anchor, $r$  -- contract_manager_may_draft
  if not (
    public.can_write_customer(p_customer_id)
    or (public.has_current_role(array['contract_manager']) and public.can_access_customer(p_customer_id))
  ) then raise exception 'customer_write_permission_required'; end if;$r$);
end
$migration$;

commit;
