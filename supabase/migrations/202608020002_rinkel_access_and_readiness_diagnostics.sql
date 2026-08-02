begin;

-- Keep the seller-facing readiness endpoint deterministic and diagnostic.
-- The previous implementation returned NULL when the central integration row
-- was missing and collapsed every provider state into a generic UI message.
create or replace function public.telephony_status_for_current_user()
returns jsonb
language sql
stable
security definer
set search_path=public
as $$
with platform as (
  select
    pi.status,
    pi.webhook_status,
    pi.last_verified_at,
    pi.last_connection_test_at,
    pi.last_error_code,
    pi.last_error_message,
    coalesce((pi.capabilities->>'dial')::boolean,false) as dial,
    coalesce((pi.capabilities->>'webhooks')::boolean,false) as webhooks
  from public.platform_integrations pi
  where pi.provider='rinkel'
    and pi.disabled_at is null
  order by pi.created_at desc
  limit 1
), resolved_platform as (
  select
    exists(select 1 from platform) as record_exists,
    coalesce((select status from platform),'not_configured') as status,
    coalesce((select webhook_status from platform),'not_configured') as webhook_status,
    (select last_verified_at from platform) as last_verified_at,
    (select last_connection_test_at from platform) as last_connection_test_at,
    (select last_error_code from platform) as last_error_code,
    (select last_error_message from platform) as last_error_message,
    coalesce((select dial from platform),false) as dial,
    coalesce((select webhooks from platform),false) as webhooks
), state as (
  select
    p.*,
    tp.telephony_enabled,
    tp.manual_dialer_enabled,
    tp.automatic_dialer_enabled,
    m.id as mapping_id,
    u.external_device_id,
    exists(
      select 1
      from public.rinkel_number_allocations a
      where a.tenant_id=public.current_tenant_id()
        and a.status='active'
        and a.valid_to is null
    ) as tenant_has_number,
    exists(
      select 1
      from public.rinkel_number_grants g
      where g.tenant_id=public.current_tenant_id()
        and g.number_allocation_id=m.default_number_allocation_id
        and g.active
        and (
          g.user_id=auth.uid()
          or g.team_id in (
            select team_id
            from public.team_members
            where tenant_id=public.current_tenant_id()
              and user_id=auth.uid()
          )
          or (g.user_id is null and g.team_id is null)
        )
    ) as has_grant
  from resolved_platform p
  left join public.telephony_policies tp
    on tp.tenant_id=public.current_tenant_id()
  left join public.rinkel_user_mappings_v2 m
    on m.tenant_id=public.current_tenant_id()
   and m.kundexa_user_id=auth.uid()
   and m.active
  left join public.rinkel_user_allocations ua
    on ua.id=m.rinkel_user_allocation_id
   and ua.status='active'
   and ua.valid_to is null
  left join public.platform_rinkel_users u
    on u.id=ua.rinkel_user_id
   and u.active
), diagnosed as (
  select
    state.*,
    case
      when not record_exists then 'RINKEL_PLATFORM_NOT_CONFIGURED'
      when status='not_configured' then 'RINKEL_PLATFORM_NOT_CONFIGURED'
      when status='testing' then 'RINKEL_PLATFORM_TESTING'
      when status='authentication_failed' then 'RINKEL_AUTHENTICATION_ERROR'
      when status='plan_unsupported' then 'RINKEL_PLAN_UNSUPPORTED'
      when status='unavailable' then 'RINKEL_UNAVAILABLE'
      when status='disabled' then 'TELEPHONY_PLATFORM_DISABLED'
      when status='error' then 'RINKEL_PLATFORM_ERROR'
      when status not in ('connected','degraded') then 'RINKEL_PLATFORM_NOT_READY'
      when not dial then 'RINKEL_DIAL_CAPABILITY_MISSING'
      when not coalesce(telephony_enabled,false) then 'TELEPHONY_DISABLED'
      when not tenant_has_number then 'RINKEL_TENANT_NUMBER_MISSING'
      when mapping_id is null then 'RINKEL_USER_MAPPING_MISSING'
      when external_device_id is null then 'RINKEL_DEVICE_MISSING'
      when not coalesce(has_grant,false) then 'RINKEL_NUMBER_ACCESS_DENIED'
      when not coalesce(manual_dialer_enabled,false) then 'MANUAL_DIALER_DISABLED'
      else null
    end as error_code
  from state
)
select jsonb_build_object(
  'platformConfigured',record_exists and status<>'not_configured',
  'platformReady',coalesce(status in ('connected','degraded') and dial,false),
  'tenantEnabled',coalesce(telephony_enabled,false),
  'tenantHasNumber',coalesce(tenant_has_number,false),
  'userMapped',mapping_id is not null,
  'userHasDevice',external_device_id is not null,
  'userHasNumberAccess',coalesce(has_grant,false),
  'manualReady',coalesce(
    status in ('connected','degraded')
    and dial
    and telephony_enabled
    and manual_dialer_enabled
    and tenant_has_number
    and mapping_id is not null
    and external_device_id is not null
    and has_grant,
    false
  ),
  'automaticReady',coalesce(
    status in ('connected','degraded')
    and dial
    and telephony_enabled
    and automatic_dialer_enabled
    and tenant_has_number
    and mapping_id is not null
    and external_device_id is not null
    and has_grant
    and webhook_status='active'
    and webhooks,
    false
  ),
  'webhookReady',coalesce(webhook_status='active' and webhooks,false),
  'status',status,
  'errorCode',error_code,
  'errorMessage',case error_code
    when 'RINKEL_PLATFORM_NOT_CONFIGURED' then 'Rinkel är inte konfigurerat eller verifierat av plattformsadministratören.'
    when 'RINKEL_PLATFORM_TESTING' then 'Rinkel-anslutningen testas just nu.'
    when 'RINKEL_AUTHENTICATION_ERROR' then coalesce(nullif(last_error_message,''),'Rinkel API-nyckeln nekades.')
    when 'RINKEL_PLAN_UNSUPPORTED' then coalesce(nullif(last_error_message,''),'Rinkel-kontot saknar nödvändig integrationsåtkomst.')
    when 'RINKEL_UNAVAILABLE' then coalesce(nullif(last_error_message,''),'Rinkel kunde inte nås vid den senaste kontrollen.')
    when 'TELEPHONY_PLATFORM_DISABLED' then 'Central Rinkel-telefoni är pausad.'
    when 'RINKEL_PLATFORM_ERROR' then coalesce(nullif(last_error_message,''),'Den centrala Rinkel-integrationen har ett konfigurationsfel.')
    when 'RINKEL_PLATFORM_NOT_READY' then 'Den centrala Rinkel-integrationen är inte redo.'
    when 'RINKEL_DIAL_CAPABILITY_MISSING' then 'Rinkel-anslutningen saknar verifierad uppringningsbehörighet.'
    when 'TELEPHONY_DISABLED' then 'Telefoni är pausad för företaget.'
    when 'RINKEL_TENANT_NUMBER_MISSING' then 'Inget Rinkel-nummer har tilldelats företaget.'
    when 'RINKEL_USER_MAPPING_MISSING' then 'Du saknar en telefonimappning.'
    when 'RINKEL_DEVICE_MISSING' then 'Din Rinkel-användare saknar en aktiv enhet.'
    when 'RINKEL_NUMBER_ACCESS_DENIED' then 'Du saknar åtkomst till ett utgående Rinkel-nummer.'
    when 'MANUAL_DIALER_DISABLED' then 'Manuell uppringning är avstängd för företaget.'
    else null
  end
)
from diagnosed
$$;

revoke all on function public.telephony_status_for_current_user() from public,anon;
grant execute on function public.telephony_status_for_current_user() to authenticated;

comment on function public.telephony_status_for_current_user() is
  'Returns deterministic, tenant-safe Rinkel readiness and a stable actionable error code/message for the current user.';

commit;
