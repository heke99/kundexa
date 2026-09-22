-- ---------------------------------------------------------------------------
-- Avsändaridentiteten härleds, den skrivs inte in
-- ---------------------------------------------------------------------------
-- `from_name`, `reply_to` och `test_recipient` låg som kopior i varje företags
-- integrationsrad, och tre fält i ett formulär matade dem. Inget av de tre var
-- en uppgift bara den personen kunde svara på:
--
--   from_name       är det utställande bolagets namn, och det står redan i
--                   `tenants.legal_name`. Kopian kunde bli inaktuell -- byter
--                   bolaget namn följde utskicken inte med.
--
--   reply_to        hör till avtalet, inte till integrationen. Svaret ska gå
--                   till bolaget som ställt ut avtalet, och det bolaget har en
--                   adress i `tenant_legal_entities.email`. Hos Gridex pekade
--                   kopian dessutom på Kundexas egen adress, så kundens svar
--                   hade landat hos fel part.
--
--   test_recipient  var en adress någon fick skriva in för att få testa. Den
--                   som vill veta om anslutningen fungerar är den som trycker
--                   på knappen, och den adressen står i inloggningen.
--
-- Nycklarna tas bort i stället för att lämnas kvar. En kvarglömd kopia som
-- ingen kodväg längre skriver är en fälla för nästa läsare: den ser ut som en
-- inställning, men ändrar ingenting.

update public.tenant_integrations
   set configuration = configuration - 'from_name' - 'reply_to' - 'test_recipient',
       updated_at = now()
 where provider_type = 'email'
   and provider = 'resend'
   and configuration ?| array['from_name','reply_to','test_recipient'];

-- Nya företag ska inte heller få kopiorna vid uppsättningen.
create or replace function public.ensure_tenant_defaults(p_tenant_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant public.tenants%rowtype;
  v_pipeline uuid;
begin
  if not (
    public.is_tenant_admin(p_tenant_id)
    or public.is_platform_role(array[
      'platform_owner'::public.platform_role,
      'platform_admin'::public.platform_role
    ])
  ) then raise exception 'admin_required'; end if;

  select * into v_tenant from public.tenants where id=p_tenant_id;
  if not found then raise exception 'tenant_not_found'; end if;

  insert into public.tenant_settings(tenant_id) values(p_tenant_id)
  on conflict(tenant_id) do nothing;

  insert into public.tenant_legal_entities(
    tenant_id,legal_name,organization_number,country_code,is_default,active
  ) values(
    p_tenant_id,v_tenant.legal_name,v_tenant.organization_number,v_tenant.country_code,true,true
  ) on conflict do nothing;

  -- E-postintegrationen. Kontomodellen är given och står här, inte i ett
  -- formulär: det finns ingen annan modell att välja. Avsändarnamnet står inte
  -- heller här längre -- det läses ur företaget vid utskicket.
  insert into public.tenant_integrations(
    tenant_id, provider_type, provider, name, status, configuration
  ) values (
    p_tenant_id, 'email', 'resend', 'Resend', 'pending',
    jsonb_build_object('account_mode', 'platform_managed', 'last_test_status', 'pending')
  ) on conflict(tenant_id,provider_type,provider,name) do nothing;

  insert into public.tenant_features(tenant_id,feature_key,enabled,configuration)
  select p_tenant_id,v.feature_key,v.enabled,'{}'::jsonb
  from (values
    ('crm',true),('contracts',true),('automations',true),
    ('outbound_calls',false),('inbound_calls',false),
    ('outbound_sms',false),('inbound_sms',false),
    ('outbound_email',true),('call_recording',false),
    ('web_acceptance',true),('sms_acceptance',false),
    ('contract_delivery_sms',false),('contract_delivery_email',true),
    ('data_enrichment',false),('mass_campaigns',false),('exports',false)
  ) as v(feature_key,enabled)
  on conflict(tenant_id,feature_key) do nothing;

  insert into public.customer_statuses(tenant_id,key,label,color,sort_order,is_system)
  values
    (p_tenant_id,'new','Nytt prospekt','#64748b',10,true),
    (p_tenant_id,'assigned','Tilldelad','#6366f1',20,true),
    (p_tenant_id,'contacting','Kontaktförsök','#f59e0b',30,true),
    (p_tenant_id,'qualified','Kvalificerad','#06b6d4',40,true),
    (p_tenant_id,'interested','Intresserad','#8b5cf6',50,true),
    (p_tenant_id,'contract_sent','Avtal skickat','#3b82f6',60,true),
    (p_tenant_id,'signed','Signerat','#10b981',70,true),
    (p_tenant_id,'lost','Förlorad','#ef4444',80,true),
    (p_tenant_id,'blocked','Spärrad','#111827',90,true)
  on conflict(tenant_id,key) do nothing;

  insert into public.pipelines(tenant_id,name,pipeline_type,active)
  values(p_tenant_id,'Nyförsäljning','new_sales',true)
  on conflict(tenant_id,name) do update set active=true
  returning id into v_pipeline;

  insert into public.pipeline_stages(tenant_id,pipeline_id,name,sort_order,probability,color,is_won,is_lost)
  values
    (p_tenant_id,v_pipeline,'Nytt lead',10,5,'#64748b',false,false),
    (p_tenant_id,v_pipeline,'Kontaktförsök',20,15,'#f59e0b',false,false),
    (p_tenant_id,v_pipeline,'Kontaktad',30,25,'#06b6d4',false,false),
    (p_tenant_id,v_pipeline,'Kvalificerad',40,45,'#8b5cf6',false,false),
    (p_tenant_id,v_pipeline,'Offert',50,65,'#3b82f6',false,false),
    (p_tenant_id,v_pipeline,'Avtal skickat',60,80,'#2563eb',false,false),
    (p_tenant_id,v_pipeline,'Signerat',70,100,'#10b981',true,false),
    (p_tenant_id,v_pipeline,'Förlorad',80,0,'#ef4444',false,true)
  on conflict(pipeline_id,sort_order) do nothing;
end
$function$;

do $$
declare
  v_left bigint;
begin
  select count(*) into v_left from public.tenant_integrations
   where provider_type='email' and provider='resend'
     and configuration ?| array['from_name','reply_to','test_recipient'];
  if v_left > 0 then
    raise exception 'sender_identity_copies_remain: % rader', v_left;
  end if;
end $$;
