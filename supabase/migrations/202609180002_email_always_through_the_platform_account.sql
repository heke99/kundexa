-- ---------------------------------------------------------------------------
-- All avtalspost går via Kundexas e-postkonto
-- ---------------------------------------------------------------------------
-- `account_mode` kunde peka på ett tenantägt Resend-konto, och defaulten skilde
-- sig mellan de fem ställen som läste den: tre sa `tenant_owned`, två sa
-- `platform_managed`. Ett företag utan uttrycklig inställning fick alltså olika
-- svar beroende på vilken kodväg som frågade -- utskicket kunde prövas mot en
-- nyckel och skickas med en annan.
--
-- Modellen är nu en enda: Kundexas konto och Kundexas verifierade domän. Det är
-- inte bara en förenkling, det är vad leverantören kräver. Avsändardomänen måste
-- vara verifierad hos dem, och det är Kundexa som äger den verifieringen. Ett
-- företag som skrev in sin egen adress fick varje utskick avvisat.
--
-- Det som skiljer företagens utskick åt är avsändarnamnet -- avtalets utställande
-- bolag -- och svarsadressen. Båda är per företag och båda finns kvar.

-- Varje företag ska ha en e-postintegration. Utan raden stoppas utskicket i
-- formuläret med "integrationen måste vara aktiv", vilket är ett riktigt svar på
-- fel fråga: modellen är given, det som saknas är en testmottagare och ett test.
insert into public.tenant_integrations(
  tenant_id, provider_type, provider, name, status, configuration
)
select
  t.id, 'email', 'resend', 'Resend', 'pending',
  jsonb_build_object(
    'account_mode', 'platform_managed',
    'from_name', coalesce(nullif(trim(t.legal_name), ''), t.name),
    'last_test_status', 'pending'
  )
from public.tenants t
where not exists (
  select 1 from public.tenant_integrations i
  where i.tenant_id = t.id and i.provider_type = 'email' and i.provider = 'resend'
);

-- Befintliga rader pekas om. Ingen nyckel raderas här: krypterade uppgifter är
-- inte vår att kasta, och en tenantnyckel som ligger kvar används ändå inte av
-- någon kodväg längre. Den som vill städa bort dem gör det med berått mod.
update public.tenant_integrations
   set configuration = configuration || jsonb_build_object('account_mode', 'platform_managed'),
       updated_at = now()
 where provider_type = 'email'
   and provider = 'resend'
   and coalesce(configuration->>'account_mode', '') <> 'platform_managed';

-- Nya företag får raden vid uppsättningen, av samma skäl: den ska finnas innan
-- någon försöker skicka sitt första avtal.
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
  -- formulär: det finns ingen annan modell att välja.
  insert into public.tenant_integrations(
    tenant_id, provider_type, provider, name, status, configuration
  ) values (
    p_tenant_id, 'email', 'resend', 'Resend', 'pending',
    jsonb_build_object(
      'account_mode', 'platform_managed',
      'from_name', coalesce(nullif(trim(v_tenant.legal_name), ''), v_tenant.name),
      'last_test_status', 'pending'
    )
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
  v_missing bigint;
  v_wrong bigint;
begin
  select count(*) into v_missing from public.tenants t
   where not exists (select 1 from public.tenant_integrations i
     where i.tenant_id=t.id and i.provider_type='email' and i.provider='resend');
  select count(*) into v_wrong from public.tenant_integrations
   where provider_type='email' and provider='resend'
     and coalesce(configuration->>'account_mode','') <> 'platform_managed';
  if v_missing > 0 or v_wrong > 0 then
    raise exception 'email_integration_backfill_incomplete: % saknas, % med fel kontomodell', v_missing, v_wrong;
  end if;
end $$;
