-- ---------------------------------------------------------------------------
-- Ingen ska testa plattformens konto en gång per företag
-- ---------------------------------------------------------------------------
-- E-postintegrationen skapades som `pending` och blev `active` först när någon
-- tryckte "Testa anslutning". Den ordningen var riktig när varje företag hade
-- en egen nyckel och en egen verifierad domän: då fanns något företagsunikt att
-- pröva.
--
-- Det finns inte längre. Nyckeln är Kundexas, domänen är Kundexas, och testet
-- prövar samma konto varje gång. Att kräva det en gång per företag är att
-- ställa samma fråga om och om igen och kalla svaret för en inställning -- och
-- under tiden står avtalsposten stilla för ett företag som inte saknar
-- någonting.
--
-- Statusen betyder härefter vad den ser ut att betyda: får företaget skicka.
-- Det är ett ja från början, och en avstängning är ett aktivt beslut.
--
-- Plattformskontots hälsa är en annan fråga, och den ställs på ett ställe:
-- integrationssidan frågar leverantören vilka domäner nyckeln ser, och
-- `/api/ready` rapporterar om nycklarna alls är satta. Den frågan blir inte
-- bättre besvarad av att upprepas per företag.

update public.tenant_integrations
   set status = 'active',
       last_verified_at = coalesce(last_verified_at, now()),
       configuration = configuration - 'last_error',
       updated_at = now()
 where provider_type = 'email'
   and provider = 'resend'
   and status <> 'active';

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

  -- Aktiv från början: företaget skickar genom Kundexas konto, och det finns
  -- ingenting företagsunikt kvar att konfigurera eller pröva.
  insert into public.tenant_integrations(
    tenant_id, provider_type, provider, name, status, last_verified_at, configuration
  ) values (
    p_tenant_id, 'email', 'resend', 'Resend', 'active', now(),
    jsonb_build_object('account_mode', 'platform_managed')
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
  select count(*) into v_left from public.tenants t
   where not exists (
     select 1 from public.tenant_integrations i
      where i.tenant_id=t.id and i.provider_type='email' and i.provider='resend'
        and i.status='active');
  if v_left > 0 then
    raise exception 'tenants_without_active_email_integration: %', v_left;
  end if;
end $$;
