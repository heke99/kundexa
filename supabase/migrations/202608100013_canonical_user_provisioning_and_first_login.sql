begin;

-- Canonical Kundexa identity provisioning. Auth owns credentials; tenant/team authorization
-- stays in public memberships. Security/orchestration detail is intentionally private so
-- it is never exposed as a tenant Data API surface.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.user_security_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  must_change_password boolean not null default false,
  provisioned_at timestamptz,
  provisioned_by uuid references auth.users(id) on delete set null,
  password_changed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table private.user_security_state enable row level security;
revoke all on private.user_security_state from public, anon, authenticated;

create table if not exists private.tenant_invitation_provisioning (
  invitation_id uuid primary key references public.tenant_invitations(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  primary_team_id uuid,
  auth_user_was_created boolean,
  auth_provisioned_at timestamptz,
  provisioning_state text not null default 'reserved' check (provisioning_state in ('reserved','auth_provisioned','finalized','accepted','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id,primary_team_id) references public.teams(tenant_id,id) on delete restrict
);
alter table private.tenant_invitation_provisioning enable row level security;
revoke all on private.tenant_invitation_provisioning from public, anon, authenticated;
create index if not exists tenant_invitation_provisioning_tenant_idx on private.tenant_invitation_provisioning(tenant_id,provisioning_state);

-- Stable, private serialization key for platform tenant bootstrap. It prevents two
-- concurrent form submissions for the same legal entity/owner from creating parallel tenants.
create table if not exists private.tenant_owner_bootstrap_keys (
  bootstrap_key text primary key,
  tenant_id uuid references public.tenants(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table private.tenant_owner_bootstrap_keys enable row level security;
revoke all on private.tenant_owner_bootstrap_keys from public,anon,authenticated;

alter table public.tenant_invitations drop constraint if exists tenant_invitations_orchestration_status_check;
alter table public.tenant_invitations add constraint tenant_invitations_orchestration_status_check
  check(orchestration_status in ('legacy','reserved','auth_provisioned','finalized','accepted','failed'));

create or replace function public.current_user_security_state()
returns table(must_change_password boolean,password_changed_at timestamptz)
language sql stable security definer set search_path=public,private as $$
  select coalesce(s.must_change_password,false),s.password_changed_at
  from (select auth.uid() as user_id) u
  left join private.user_security_state s on s.user_id=u.user_id
  where u.user_id is not null
$$;
revoke all on function public.current_user_security_state() from public,anon;
grant execute on function public.current_user_security_state() to authenticated,service_role;

create or replace function public.tenant_user_security_states()
returns table(user_id uuid,must_change_password boolean)
language plpgsql stable security definer set search_path=public,private as $$
declare v_tenant uuid:=public.current_tenant_id();
begin
  if v_tenant is null or not public.is_tenant_admin(v_tenant) then raise exception 'tenant_admin_required'; end if;
  return query
    select m.user_id,coalesce(s.must_change_password,false)
    from public.tenant_memberships m
    left join private.user_security_state s on s.user_id=m.user_id
    where m.tenant_id=v_tenant;
end $$;
revoke all on function public.tenant_user_security_states() from public,anon;
grant execute on function public.tenant_user_security_states() to authenticated,service_role;

create or replace function public.get_user_security_state_for_provisioning(p_user_id uuid)
returns table(user_id uuid,must_change_password boolean,provisioned_at timestamptz,password_changed_at timestamptz)
language sql stable security definer set search_path=private as $$
  select s.user_id,s.must_change_password,s.provisioned_at,s.password_changed_at
  from private.user_security_state s where s.user_id=p_user_id
$$;
revoke all on function public.get_user_security_state_for_provisioning(uuid) from public,anon,authenticated;
grant execute on function public.get_user_security_state_for_provisioning(uuid) to service_role;

create or replace function public.provision_user_security_state(p_user_id uuid,p_provisioned_by uuid)
returns void language plpgsql security definer set search_path=private,auth as $$
begin
  if not exists(select 1 from auth.users where id=p_user_id) then raise exception 'auth_user_not_found'; end if;
  insert into private.user_security_state(user_id,must_change_password,provisioned_at,provisioned_by,password_changed_at,updated_at)
  values(p_user_id,true,now(),p_provisioned_by,null,now())
  on conflict(user_id) do update set
    must_change_password=case when private.user_security_state.password_changed_at is null then true else private.user_security_state.must_change_password end,
    provisioned_at=coalesce(private.user_security_state.provisioned_at,excluded.provisioned_at),
    provisioned_by=coalesce(private.user_security_state.provisioned_by,excluded.provisioned_by),
    updated_at=now();
end $$;
revoke all on function public.provision_user_security_state(uuid,uuid) from public,anon,authenticated;
grant execute on function public.provision_user_security_state(uuid,uuid) to service_role;

create or replace function public.mark_tenant_invitation_auth_provisioned(
  p_invitation_id uuid,p_user_id uuid,p_auth_user_was_created boolean
) returns void language plpgsql security definer set search_path=public,private,auth as $$
declare v_inv public.tenant_invitations%rowtype;
begin
  select * into v_inv from public.tenant_invitations where id=p_invitation_id and status='pending' for update;
  if not found then raise exception 'pending_invitation_not_found'; end if;
  if not exists(select 1 from auth.users u where u.id=p_user_id and lower(coalesce(u.email,''))=lower(v_inv.email::text)) then
    raise exception 'invited_user_email_mismatch';
  end if;
  update private.tenant_invitation_provisioning set
    auth_user_was_created=p_auth_user_was_created,auth_provisioned_at=now(),provisioning_state='auth_provisioned',updated_at=now()
  where invitation_id=p_invitation_id;
  if not found then raise exception 'invitation_primary_team_state_missing'; end if;
  update public.tenant_invitations set orchestration_status='auth_provisioned',updated_at=now() where id=p_invitation_id;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_inv.tenant_id,v_inv.invited_by,'tenant.auth_user_provisioned','auth_user',p_user_id::text,
    jsonb_build_object('invitation_id',p_invitation_id,'auth_user_was_created',p_auth_user_was_created,'password_change_required',p_auth_user_was_created));
end $$;
revoke all on function public.mark_tenant_invitation_auth_provisioned(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.mark_tenant_invitation_auth_provisioned(uuid,uuid,boolean) to service_role;

create or replace function public.complete_user_password_change(p_user_id uuid)
returns void language plpgsql security definer set search_path=public,private as $$
declare v_tenant uuid;
begin
  update private.user_security_state set must_change_password=false,password_changed_at=now(),updated_at=now()
  where user_id=p_user_id and must_change_password=true;
  if not found then return; end if;

  for v_tenant in
    select m.tenant_id from public.tenant_memberships m where m.user_id=p_user_id and m.status in ('invited','active')
    union
    select i.tenant_id from public.tenant_invitations i where i.invited_user_id=p_user_id and i.status='pending'
  loop
    insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_tenant,p_user_id,'security.password_change_completed','user_security_state',p_user_id::text,jsonb_build_object('must_change_password',false));
  end loop;

  update public.tenants t set
    onboarding_status=case when exists(select 1 from public.tenant_settings s where s.tenant_id=t.id)
      and exists(select 1 from public.tenant_legal_entities le where le.tenant_id=t.id and le.is_default and le.active)
      and exists(select 1 from public.teams tm where tm.tenant_id=t.id and tm.is_default and tm.status<>'archived') then 'active' else 'onboarding' end,
    onboarding_completed_at=case when exists(select 1 from public.tenant_settings s where s.tenant_id=t.id)
      and exists(select 1 from public.tenant_legal_entities le where le.tenant_id=t.id and le.is_default and le.active)
      and exists(select 1 from public.teams tm where tm.tenant_id=t.id and tm.is_default and tm.status<>'archived') then now() else null end,
    onboarding_error=null
  where t.owner_user_id=p_user_id and t.onboarding_status in ('awaiting_owner','onboarding')
    and exists(select 1 from public.tenant_memberships m where m.tenant_id=t.id and m.user_id=p_user_id and m.status='active' and m.role='owner');
end $$;
revoke all on function public.complete_user_password_change(uuid) from public,anon,authenticated;
grant execute on function public.complete_user_password_change(uuid) to service_role;

-- Explicit primary team. The existing hardened invitation RPC remains the permission/capacity
-- authority; this v2 wrapper stores the administrator's explicit choice separately.
create or replace function public.reserve_tenant_invitation_v2(
  p_tenant_id uuid,
  p_email text,
  p_role public.membership_role,
  p_team_ids uuid[] default '{}',
  p_primary_team_id uuid default null,
  p_message text default null,
  p_expires_at timestamptz default now()+interval '7 days',
  p_idempotency_key text default null
) returns uuid
language plpgsql security definer set search_path=public,private as $$
declare v_inv uuid; v_count integer;
begin
  select count(distinct x.team_id)::integer into v_count from unnest(coalesce(p_team_ids,'{}'::uuid[])) x(team_id);
  if p_role in ('sales','team_lead') and p_primary_team_id is null then raise exception 'primary_team_required'; end if;
  if v_count>0 and p_primary_team_id is null then raise exception 'primary_team_required'; end if;
  if p_primary_team_id is not null and not p_primary_team_id=any(coalesce(p_team_ids,'{}'::uuid[])) then raise exception 'primary_team_must_be_assigned'; end if;

  v_inv:=public.reserve_tenant_invitation(p_tenant_id,p_email,p_role,p_team_ids,p_message,p_expires_at,p_idempotency_key);
  insert into private.tenant_invitation_provisioning(invitation_id,tenant_id,primary_team_id,provisioning_state,updated_at)
  values(v_inv,p_tenant_id,p_primary_team_id,'reserved',now())
  on conflict(invitation_id) do update set tenant_id=excluded.tenant_id,primary_team_id=excluded.primary_team_id,
    auth_user_was_created=null,auth_provisioned_at=null,provisioning_state='reserved',updated_at=now();
  return v_inv;
end $$;
revoke all on function public.reserve_tenant_invitation_v2(uuid,text,public.membership_role,uuid[],uuid,text,timestamptz,text) from public,anon;
grant execute on function public.reserve_tenant_invitation_v2(uuid,text,public.membership_role,uuid[],uuid,text,timestamptz,text) to authenticated,service_role;

-- Tenant bootstrap and owner reservation are one database transaction. If Auth provisioning
-- fails later, a repeated platform submission resumes the same non-active tenant instead of
-- silently creating a parallel organization.
create or replace function public.create_or_resume_platform_tenant_owner(
  p_name text,p_legal_name text,p_organization_number text,p_country_code text,p_timezone text,p_locale text,
  p_owner_email text,p_expires_at timestamptz default now()+interval '7 days',p_idempotency_key text default null
) returns jsonb language plpgsql security definer set search_path=public,private as $$
declare
  v_actor uuid:=auth.uid(); v_email text:=lower(trim(coalesce(p_owner_email,''))); v_org text:=nullif(trim(coalesce(p_organization_number,'')),'');
  v_tenant uuid; v_team uuid; v_inv uuid; v_candidates integer; v_locked_tenant uuid; v_locked_onboarding text;
  v_bootstrap_key text;
begin
  if not public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role]) then raise exception 'platform_admin_required'; end if;
  if nullif(trim(coalesce(p_name,'')),'') is null or nullif(trim(coalesce(p_legal_name,'')),'') is null or v_email='' then raise exception 'tenant_owner_identity_required'; end if;

  v_bootstrap_key:=md5(lower(trim(p_legal_name))||'|'||coalesce(v_org,'')||'|'||v_email);
  insert into private.tenant_owner_bootstrap_keys(bootstrap_key) values(v_bootstrap_key) on conflict(bootstrap_key) do nothing;
  select tenant_id into v_locked_tenant from private.tenant_owner_bootstrap_keys where bootstrap_key=v_bootstrap_key for update;
  if v_locked_tenant is not null then
    select onboarding_status into v_locked_onboarding from public.tenants where id=v_locked_tenant for update;
    if found and v_locked_onboarding not in ('awaiting_owner','failed') then raise exception 'tenant_owner_bootstrap_already_exists'; end if;
  end if;

  select count(distinct t.id)::integer into v_candidates
  from public.tenants t
  where t.onboarding_status in ('awaiting_owner','failed')
    and (v_locked_tenant is null or t.id=v_locked_tenant)
    and lower(trim(t.legal_name))=lower(trim(p_legal_name))
    and coalesce(trim(t.organization_number),'')=coalesce(v_org,'')
    and exists(select 1 from public.tenant_invitations i where i.tenant_id=t.id and i.role='owner' and lower(i.email::text)=v_email);
  if v_locked_tenant is not null and v_locked_onboarding is null then
    update private.tenant_owner_bootstrap_keys set tenant_id=null,updated_at=now() where bootstrap_key=v_bootstrap_key;
    v_locked_tenant:=null;
  end if;
  if v_candidates>1 then raise exception 'ambiguous_recoverable_tenant'; end if;

  if v_candidates=1 then
    select t.id into v_tenant
    from public.tenants t
    where t.onboarding_status in ('awaiting_owner','failed')
      and (v_locked_tenant is null or t.id=v_locked_tenant)
      and lower(trim(t.legal_name))=lower(trim(p_legal_name))
      and coalesce(trim(t.organization_number),'')=coalesce(v_org,'')
      and exists(select 1 from public.tenant_invitations i where i.tenant_id=t.id and i.role='owner' and lower(i.email::text)=v_email)
    order by t.created_at desc limit 1 for update;
    update public.tenants set name=trim(p_name),legal_name=trim(p_legal_name),organization_number=v_org,country_code=upper(coalesce(nullif(trim(p_country_code),''),'SE')),
      timezone=coalesce(nullif(trim(p_timezone),''),'Europe/Stockholm'),locale=coalesce(nullif(trim(p_locale),''),'sv-SE'),onboarding_error=null,updated_at=now() where id=v_tenant;
    perform public.ensure_tenant_defaults(v_tenant);
  else
    v_tenant:=public.create_platform_tenant(p_name,p_legal_name,v_org,coalesce(nullif(trim(p_country_code),''),'SE'),coalesce(nullif(trim(p_timezone),''),'Europe/Stockholm'),coalesce(nullif(trim(p_locale),''),'sv-SE'));
  end if;

  update private.tenant_owner_bootstrap_keys set tenant_id=v_tenant,updated_at=now() where bootstrap_key=v_bootstrap_key;

  select id into v_team from public.teams where tenant_id=v_tenant and is_default and status<>'archived' order by created_at limit 1;
  if v_team is null then
    insert into public.teams(tenant_id,name,is_default,code) values(v_tenant,'Huvudteam',true,'main')
      on conflict(tenant_id,name) do update set is_default=true,status='active',updated_at=now() returning id into v_team;
  end if;

  v_inv:=public.reserve_tenant_invitation_v2(v_tenant,v_email,'owner'::public.membership_role,array[v_team],v_team,
    'Du har lagts till som tenantägare i Kundexa.',p_expires_at,p_idempotency_key);
  update public.tenants set onboarding_status='awaiting_owner',owner_invitation_id=v_inv,onboarding_error=null,updated_at=now() where id=v_tenant;
  insert into public.platform_audit_logs(actor_user_id,action,entity_type,entity_id,tenant_id,reason,metadata)
  values(v_actor,case when v_candidates=1 then 'tenant.owner_provisioning_resumed' else 'tenant.owner_provisioning_reserved' end,'tenant',v_tenant::text,v_tenant,
    'Tenantbas och owner-reservation klara',jsonb_build_object('owner_invitation_id',v_inv,'default_team_id',v_team,'resumed',v_candidates=1));
  return jsonb_build_object('tenant_id',v_tenant,'default_team_id',v_team,'invitation_id',v_inv,'resumed',v_candidates=1);
end $$;
revoke all on function public.create_or_resume_platform_tenant_owner(text,text,text,text,text,text,text,timestamptz,text) from public,anon;
grant execute on function public.create_or_resume_platform_tenant_owner(text,text,text,text,text,text,text,timestamptz,text) to authenticated;

create or replace function public.finalize_tenant_invitation(p_invitation_id uuid,p_invited_user_id uuid)
returns uuid language plpgsql security definer set search_path=public,private,auth as $$
declare
  v_actor uuid:=auth.uid(); v_inv public.tenant_invitations%rowtype; v_email text;
  v_existing public.tenant_memberships%rowtype; v_has_membership boolean:=false; v_is_platform boolean;
begin
  if v_actor is null then raise exception 'authentication_required'; end if;
  select * into v_inv from public.tenant_invitations
    where id=p_invitation_id and status='pending' and expires_at>now() and revoked_at is null for update;
  if not found then raise exception 'pending_invitation_not_found'; end if;
  if not exists(select 1 from private.tenant_invitation_provisioning p where p.invitation_id=v_inv.id) then
    if coalesce(array_length(v_inv.team_ids,1),0)=1 then
      insert into private.tenant_invitation_provisioning(invitation_id,tenant_id,primary_team_id,provisioning_state,updated_at)
      select v_inv.id,v_inv.tenant_id,x.team_id,'reserved',now() from unnest(v_inv.team_ids) x(team_id) limit 1;
    elsif coalesce(array_length(v_inv.team_ids,1),0)=0 then
      insert into private.tenant_invitation_provisioning(invitation_id,tenant_id,primary_team_id,provisioning_state,updated_at)
      values(v_inv.id,v_inv.tenant_id,null,'reserved',now());
    else
      raise exception 'primary_team_required';
    end if;
  end if;
  v_is_platform:=public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role]);
  if not v_is_platform and v_inv.tenant_id<>public.current_tenant_id() then raise exception 'tenant_mismatch'; end if;
  if not v_is_platform and not public.is_tenant_admin(v_inv.tenant_id) then
    if public.current_membership_role()<>'team_lead' or v_inv.role<>'sales' then raise exception 'invitation_permission_required'; end if;
    if exists(select 1 from unnest(v_inv.team_ids) x(team_id) where not public.can_manage_team(x.team_id)) then raise exception 'team_manage_permission_required'; end if;
  end if;
  select lower(coalesce(email,'')) into v_email from auth.users where id=p_invited_user_id;
  if v_email is null or v_email<>lower(v_inv.email::text) then raise exception 'invited_user_email_mismatch'; end if;

  select * into v_existing from public.tenant_memberships where tenant_id=v_inv.tenant_id and user_id=p_invited_user_id for update;
  v_has_membership:=found;
  if v_has_membership and v_existing.status='active' then raise exception 'active_tenant_member_already_exists'; end if;
  if v_has_membership and v_existing.status='suspended' then raise exception 'suspended_member_requires_reactivation'; end if;
  if v_has_membership and v_existing.status='removed' then raise exception 'removed_member_requires_reactivation_workflow'; end if;
  if v_has_membership then
    update public.tenant_memberships set role=v_inv.role,status='invited',invited_by=v_inv.invited_by,invited_at=coalesce(invited_at,now()),updated_at=now()
    where tenant_id=v_inv.tenant_id and user_id=p_invited_user_id;
  else
    insert into public.tenant_memberships(tenant_id,user_id,role,status,invited_by,invited_at)
    values(v_inv.tenant_id,p_invited_user_id,v_inv.role,'invited',v_inv.invited_by,now());
  end if;
  update private.tenant_invitation_provisioning set provisioning_state='finalized',updated_at=now() where invitation_id=v_inv.id;
  update public.tenant_invitations set invited_user_id=p_invited_user_id,orchestration_status='finalized',finalized_at=now(),failure_reason=null,updated_at=now() where id=v_inv.id;
  if v_inv.role='owner' then update public.tenants set onboarding_status='awaiting_owner',owner_user_id=p_invited_user_id,owner_invitation_id=v_inv.id,onboarding_error=null where id=v_inv.tenant_id; end if;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_inv.tenant_id,v_actor,'tenant.invitation_finalized','tenant_invitation',v_inv.id::text,jsonb_build_object('invited_user_id',p_invited_user_id,'role',v_inv.role));
  return v_inv.id;
end $$;

create or replace function public.activate_current_user_invitation()
returns uuid language plpgsql security definer set search_path=public,private,auth as $$
declare
  v_user uuid:=auth.uid(); v_email text; v_inv public.tenant_invitations%rowtype;
  v_existing public.tenant_memberships%rowtype; v_has_membership boolean:=false;
  v_team uuid; v_team_role text; v_primary uuid; v_must_change boolean:=false;
begin
  if v_user is null then return null; end if;
  select lower(coalesce(email,'')) into v_email from auth.users where id=v_user;
  select * into v_inv from public.tenant_invitations
    where status='pending' and expires_at>now() and revoked_at is null
      and (invited_user_id=v_user or lower(email::text)=v_email)
    order by created_at desc limit 1 for update;
  if not found then return null; end if;

  select p.primary_team_id into v_primary from private.tenant_invitation_provisioning p where p.invitation_id=v_inv.id;
  if not found then
    -- Legacy one-team invitations can be repaired deterministically. Never choose among multiple UUIDs.
    if coalesce(array_length(v_inv.team_ids,1),0)=1 then
      select x.team_id into v_primary from unnest(v_inv.team_ids) x(team_id) limit 1;
      insert into private.tenant_invitation_provisioning(invitation_id,tenant_id,primary_team_id,provisioning_state)
      values(v_inv.id,v_inv.tenant_id,v_primary,'finalized') on conflict(invitation_id) do nothing;
    elsif coalesce(array_length(v_inv.team_ids,1),0)>1 then raise exception 'primary_team_required'; end if;
  end if;
  if v_inv.role in ('sales','team_lead') and v_primary is null then raise exception 'primary_team_required'; end if;
  if v_primary is not null and not v_primary=any(coalesce(v_inv.team_ids,'{}'::uuid[])) then raise exception 'primary_team_must_be_assigned'; end if;

  select * into v_existing from public.tenant_memberships where tenant_id=v_inv.tenant_id and user_id=v_user for update;
  v_has_membership:=found;
  if v_has_membership and v_existing.status='active' then raise exception 'active_tenant_member_already_exists'; end if;
  if v_has_membership and v_existing.status='suspended' then raise exception 'suspended_member_requires_reactivation'; end if;
  if v_has_membership and v_existing.status='removed' then raise exception 'removed_member_requires_reactivation_workflow'; end if;
  foreach v_team in array coalesce(v_inv.team_ids,'{}'::uuid[]) loop perform public.assert_team_capacity(v_inv.tenant_id,v_team,1,v_inv.id); end loop;

  if v_has_membership then
    update public.tenant_memberships set role=v_inv.role,status='active',invited_by=coalesce(invited_by,v_inv.invited_by),invited_at=coalesce(invited_at,v_inv.created_at),joined_at=coalesce(joined_at,now()),deactivated_at=null,deactivated_by=null,updated_at=now()
    where tenant_id=v_inv.tenant_id and user_id=v_user;
  else
    insert into public.tenant_memberships(tenant_id,user_id,role,status,invited_by,invited_at,joined_at)
    values(v_inv.tenant_id,v_user,v_inv.role,'active',v_inv.invited_by,v_inv.created_at,now());
  end if;

  v_team_role:=case when v_inv.role='team_lead' then 'manager' else 'member' end;
  foreach v_team in array coalesce(v_inv.team_ids,'{}'::uuid[]) loop
    insert into public.team_members(tenant_id,team_id,user_id,role,is_primary,assignment_paused,joined_at,updated_at)
    values(v_inv.tenant_id,v_team,v_user,v_team_role,v_team=v_primary,false,now(),now())
    on conflict(team_id,user_id) do update set role=excluded.role,is_primary=excluded.is_primary,assignment_paused=false,updated_at=now();
  end loop;
  update public.team_members set is_primary=(team_id=v_primary),updated_at=now() where tenant_id=v_inv.tenant_id and user_id=v_user;
  update public.tenant_memberships set primary_team_id=v_primary,updated_at=now() where tenant_id=v_inv.tenant_id and user_id=v_user;

  update private.tenant_invitation_provisioning set provisioning_state='accepted',updated_at=now() where invitation_id=v_inv.id;
  update public.tenant_invitations set status='accepted',invited_user_id=v_user,orchestration_status='accepted',finalized_at=coalesce(finalized_at,now()),accepted_at=now(),updated_at=now() where id=v_inv.id;
  update public.profiles set active_tenant_id=coalesce(active_tenant_id,v_inv.tenant_id),updated_at=now() where id=v_user;
  select coalesce(s.must_change_password,false) into v_must_change from private.user_security_state s where s.user_id=v_user;
  if not found then v_must_change:=false; end if;
  if v_inv.role='owner' then
    update public.tenants set owner_user_id=v_user,owner_invitation_id=v_inv.id,
      onboarding_status=case when v_must_change then 'onboarding' else 'active' end,
      onboarding_completed_at=case when v_must_change then null else now() end,onboarding_error=null
    where id=v_inv.tenant_id;
  end if;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_inv.tenant_id,v_user,'tenant.invitation_accepted','tenant_membership',v_user::text,
    jsonb_build_object('tenant_id',v_inv.tenant_id,'invitation_id',v_inv.id,'role',v_inv.role,'team_ids',v_inv.team_ids,'primary_team_id',v_primary));
  return v_inv.tenant_id;
end $$;

-- Team creation no longer makes an owner/admin a manager merely because they created the team.
create or replace function public.create_managed_team(
  p_name text,p_description text default null,p_department text default null,p_office text default null,p_code text default null,
  p_invite_sellers_enabled boolean default true,p_max_members integer default null,p_default_dialing_mode text default 'manual'
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_team uuid; v_allow_team_lead boolean; v_role public.membership_role:=public.current_membership_role();
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;
  if nullif(trim(coalesce(p_name,'')),'') is null then raise exception 'team_name_required'; end if;
  if p_default_dialing_mode not in ('manual','automatic') then raise exception 'invalid_default_dialing_mode'; end if;
  if p_max_members is not null and (p_max_members<1 or p_max_members>10000) then raise exception 'invalid_team_member_limit'; end if;
  select coalesce((settings->>'team_leads_can_create_teams')::boolean,true) into v_allow_team_lead from public.tenant_settings where tenant_id=v_tenant;
  if not public.is_tenant_admin(v_tenant) and not (v_role='team_lead' and coalesce(v_allow_team_lead,true)) then raise exception 'team_create_permission_required'; end if;
  insert into public.teams(tenant_id,name,description,department,office,code,invite_sellers_enabled,max_members,default_dialing_mode)
  values(v_tenant,trim(p_name),nullif(trim(coalesce(p_description,'')),''),nullif(trim(coalesce(p_department,'')),''),nullif(trim(coalesce(p_office,'')),''),nullif(lower(trim(coalesce(p_code,''))),''),p_invite_sellers_enabled,p_max_members,p_default_dialing_mode)
  returning id into v_team;
  if v_role='team_lead' then
    insert into public.team_members(tenant_id,team_id,user_id,role,is_primary,assignment_paused,joined_at,updated_at)
    values(v_tenant,v_team,v_user,'manager',false,false,now(),now())
    on conflict(team_id,user_id) do update set role='manager',assignment_paused=false,updated_at=now();
  end if;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_user,'team.created','team',v_team::text,jsonb_build_object('name',trim(p_name),'creator_role',v_role,'creator_auto_manager',v_role='team_lead'));
  return v_team;
end $$;

create or replace function public.create_managed_team_v2(
  p_name text,p_description text default null,p_department text default null,p_office text default null,p_code text default null,
  p_invite_sellers_enabled boolean default true,p_max_members integer default null,p_default_dialing_mode text default 'manual',p_manager_user_id uuid default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_actor uuid:=auth.uid(); v_actor_role public.membership_role:=public.current_membership_role(); v_team uuid; v_manager_role public.membership_role;
begin
  v_team:=public.create_managed_team(p_name,p_description,p_department,p_office,p_code,p_invite_sellers_enabled,p_max_members,p_default_dialing_mode);
  if v_actor_role='team_lead' then
    if p_manager_user_id is not null and p_manager_user_id<>v_actor then raise exception 'team_lead_can_only_manage_own_created_team'; end if;
    return v_team;
  end if;
  if p_manager_user_id is null then return v_team; end if;
  select role into v_manager_role from public.tenant_memberships where tenant_id=v_tenant and user_id=p_manager_user_id and status='active';
  if not found or v_manager_role not in ('owner','admin','team_lead') then raise exception 'manager_membership_role_required'; end if;
  perform public.assert_team_capacity(v_tenant,v_team,1,null);
  insert into public.team_members(tenant_id,team_id,user_id,role,is_primary,assignment_paused,joined_at,updated_at)
  values(v_tenant,v_team,p_manager_user_id,'manager',false,false,now(),now())
  on conflict(team_id,user_id) do update set role='manager',assignment_paused=false,updated_at=now();
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_actor,'team.manager_assigned','team_member',v_team::text||':'||p_manager_user_id::text,jsonb_build_object('team_id',v_team,'manager_user_id',p_manager_user_id));
  return v_team;
end $$;
revoke all on function public.create_managed_team_v2(text,text,text,text,text,boolean,integer,text,uuid) from public,anon;
grant execute on function public.create_managed_team_v2(text,text,text,text,text,boolean,integer,text,uuid) to authenticated;

-- Explicit primary team for role/status changes. v2 remains as a compatibility wrapper
-- and never selects a primary by UUID ordering.
create or replace function public.update_tenant_member_v3(
  p_user_id uuid,p_role public.membership_role,p_status public.membership_status,p_reassign_user_id uuid default null,
  p_team_ids uuid[] default '{}',p_primary_team_id uuid default null,p_restore_team_assignments boolean default true
) returns void language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid:=public.current_tenant_id(); v_actor uuid:=auth.uid(); v_actor_role public.membership_role:=public.current_membership_role();
  v_before public.tenant_memberships%rowtype; v_owner_count integer; v_team_ids uuid[]; v_team uuid;
begin
  if v_tenant is null or v_actor is null or v_actor_role not in ('owner','admin') then raise exception 'tenant_admin_required'; end if;
  select * into v_before from public.tenant_memberships where tenant_id=v_tenant and user_id=p_user_id for update;
  if not found then raise exception 'tenant_member_not_found'; end if;
  if v_before.status='removed' and p_status<>'removed' then raise exception 'removed_member_requires_reactivation_workflow'; end if;
  if p_status='invited' and v_before.status<>'invited' then raise exception 'active_member_cannot_return_to_invited'; end if;
  if v_before.status='invited' and p_status not in ('invited','removed') then raise exception 'invitation_must_be_accepted_by_user'; end if;
  if v_actor=p_user_id and (p_role is distinct from v_before.role or p_status<>'active') then raise exception 'cannot_change_own_role_or_status'; end if;
  if v_actor_role='admin' and (v_before.role in ('owner','admin') or p_role in ('owner','admin')) then raise exception 'owner_required_for_privileged_role'; end if;
  if v_before.role='owner' and (p_role<>'owner' or p_status<>'active') then
    select count(*) into v_owner_count from public.tenant_memberships where tenant_id=v_tenant and role='owner' and status='active';
    if v_owner_count<=1 then raise exception 'tenant_requires_active_owner'; end if;
  end if;
  if p_reassign_user_id=p_user_id then raise exception 'invalid_reassignment_target'; end if;
  if p_reassign_user_id is not null and not exists(select 1 from public.tenant_memberships where tenant_id=v_tenant and user_id=p_reassign_user_id and status='active') then raise exception 'active_reassignment_target_required'; end if;
  select coalesce(array_agg(distinct x.team_id order by x.team_id),'{}'::uuid[]) into v_team_ids from unnest(coalesce(p_team_ids,'{}'::uuid[])) x(team_id);
  if p_status='active' and p_role in ('sales','team_lead') and p_primary_team_id is null then raise exception 'primary_team_required'; end if;
  if p_primary_team_id is not null and not p_primary_team_id=any(v_team_ids) then raise exception 'primary_team_must_be_assigned'; end if;
  if exists(select 1 from unnest(v_team_ids) x(team_id) where not exists(select 1 from public.teams t where t.tenant_id=v_tenant and t.id=x.team_id and t.status<>'archived')) then raise exception 'team_not_found'; end if;

  if p_status in ('suspended','removed') then
    update public.customer_list_seller_assignments set status=case when p_status='removed' then 'ended' else 'paused' end,updated_at=now() where tenant_id=v_tenant and user_id=p_user_id and status='active';
    update public.customer_list_members set assigned_user_id=p_reassign_user_id,updated_at=now() where tenant_id=v_tenant and assigned_user_id=p_user_id and state not in ('completed','blocked');
    update public.customer_list_members set claimed_by=null,claim_expires_at=null,state=case when state in ('claimed','dialing') then 'pending' else state end,updated_at=now() where tenant_id=v_tenant and claimed_by=p_user_id;
    update public.customers set assigned_user_id=p_reassign_user_id,updated_at=now() where tenant_id=v_tenant and assigned_user_id=p_user_id;
    update public.activities set assigned_user_id=p_reassign_user_id,updated_at=now() where tenant_id=v_tenant and assigned_user_id=p_user_id and status in ('open','in_progress');
    update public.deals set owner_user_id=p_reassign_user_id,updated_at=now() where tenant_id=v_tenant and owner_user_id=p_user_id and status='open';
    if p_status='removed' then delete from public.team_members where tenant_id=v_tenant and user_id=p_user_id;
    else update public.team_members set assignment_paused=true,updated_at=now() where tenant_id=v_tenant and user_id=p_user_id; end if;
  end if;

  update public.tenant_memberships set role=p_role,status=p_status,
    primary_team_id=case when p_status='active' then p_primary_team_id when p_status='removed' then null else primary_team_id end,
    deactivated_at=case when p_status in ('suspended','removed') then now() else null end,
    deactivated_by=case when p_status in ('suspended','removed') then v_actor else null end,
    joined_at=case when p_status='active' then coalesce(joined_at,now()) else joined_at end,updated_at=now()
  where tenant_id=v_tenant and user_id=p_user_id;

  if p_status='active' and v_before.status='suspended' and p_restore_team_assignments then
    update public.team_members set assignment_paused=false,updated_at=now() where tenant_id=v_tenant and user_id=p_user_id;
    update public.customer_list_seller_assignments set status='active',updated_at=now() where tenant_id=v_tenant and user_id=p_user_id and status='paused';
  end if;

  if p_status='active' then
    -- The submitted team set is authoritative. Remove stale memberships first so the
    -- role/team editor cannot silently leave operational access to unchecked teams.
    delete from public.team_members
    where tenant_id=v_tenant and user_id=p_user_id and not (team_id=any(v_team_ids));
    update public.team_members set role=case when p_role='team_lead' then 'manager' else 'member' end,
      is_primary=(team_id=p_primary_team_id),updated_at=now()
    where tenant_id=v_tenant and user_id=p_user_id and team_id=any(v_team_ids);
    foreach v_team in array v_team_ids loop
      perform public.assert_team_capacity(v_tenant,v_team,case when exists(select 1 from public.team_members where tenant_id=v_tenant and team_id=v_team and user_id=p_user_id) then 0 else 1 end,null);
      insert into public.team_members(tenant_id,team_id,user_id,role,is_primary,assignment_paused,joined_at,updated_at)
      values(v_tenant,v_team,p_user_id,case when p_role='team_lead' then 'manager' else 'member' end,v_team=p_primary_team_id,false,now(),now())
      on conflict(team_id,user_id) do update set role=excluded.role,is_primary=excluded.is_primary,assignment_paused=false,updated_at=now();
    end loop;
  end if;

  if p_status in ('suspended','removed') then
    update public.profiles p set active_tenant_id=(select m.tenant_id from public.tenant_memberships m join public.tenants t on t.id=m.tenant_id where m.user_id=p_user_id and m.status='active' and m.tenant_id<>v_tenant and t.status in ('trial','active') order by m.joined_at desc nulls last,m.created_at desc limit 1),updated_at=now()
    where p.id=p_user_id and p.active_tenant_id=v_tenant;
  end if;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,before_data,after_data)
  values(v_tenant,v_actor,'tenant.member_updated','tenant_membership',p_user_id::text,
    jsonb_build_object('role',v_before.role,'status',v_before.status,'primary_team_id',v_before.primary_team_id),
    jsonb_build_object('role',p_role,'status',p_status,'team_ids',v_team_ids,'primary_team_id',p_primary_team_id,'restore_team_assignments',p_restore_team_assignments,'reassigned_to',p_reassign_user_id));
  if v_before.status is distinct from p_status then
    insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,before_data,after_data)
    values(v_tenant,v_actor,
      case
        when p_status='suspended' then 'tenant.member_suspended'
        when p_status='removed' then 'tenant.member_removed'
        when p_status='active' and v_before.status='suspended' then 'tenant.member_reactivated'
        else 'tenant.member_status_changed'
      end,
      'tenant_membership',p_user_id::text,
      jsonb_build_object('status',v_before.status),jsonb_build_object('status',p_status));
  end if;
end $$;
revoke all on function public.update_tenant_member_v3(uuid,public.membership_role,public.membership_status,uuid,uuid[],uuid,boolean) from public,anon;
grant execute on function public.update_tenant_member_v3(uuid,public.membership_role,public.membership_status,uuid,uuid[],uuid,boolean) to authenticated;

create or replace function public.update_tenant_member_v2(
  p_user_id uuid,p_role public.membership_role,p_status public.membership_status,
  p_reassign_user_id uuid default null,p_team_ids uuid[] default '{}',p_restore_team_assignments boolean default true
) returns void language plpgsql security definer set search_path=public as $$
declare v_primary uuid; v_count integer;
begin
  select count(distinct x.team_id)::integer into v_count from unnest(coalesce(p_team_ids,'{}'::uuid[])) x(team_id);
  if v_count=1 then select x.team_id into v_primary from unnest(p_team_ids) x(team_id) limit 1;
  else select primary_team_id into v_primary from public.tenant_memberships where tenant_id=public.current_tenant_id() and user_id=p_user_id; end if;
  if v_primary is not null and not v_primary=any(coalesce(p_team_ids,'{}'::uuid[])) then v_primary:=null; end if;
  perform public.update_tenant_member_v3(p_user_id,p_role,p_status,p_reassign_user_id,p_team_ids,v_primary,p_restore_team_assignments);
end $$;

create or replace function public.fail_tenant_invitation(p_invitation_id uuid,p_reason text)
returns void language plpgsql security definer set search_path=public,private as $$
declare v_actor uuid:=auth.uid(); v_inv public.tenant_invitations%rowtype; v_is_platform boolean;
begin
  if v_actor is null then raise exception 'authentication_required'; end if;
  select * into v_inv from public.tenant_invitations where id=p_invitation_id and status='pending' for update;
  if not found then return; end if;
  v_is_platform:=public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role]);
  if not v_is_platform and v_inv.tenant_id<>public.current_tenant_id() then raise exception 'tenant_mismatch'; end if;
  if not v_is_platform and not public.is_tenant_admin(v_inv.tenant_id) and v_inv.invited_by<>v_actor then raise exception 'invitation_permission_required'; end if;
  update public.tenant_invitations set status='failed',orchestration_status='failed',failure_reason=left(coalesce(nullif(trim(p_reason),''),'unknown'),1000),updated_at=now() where id=v_inv.id;
  update private.tenant_invitation_provisioning set provisioning_state='failed',updated_at=now() where invitation_id=v_inv.id;
  if v_inv.role='owner' then update public.tenants set onboarding_status='failed',onboarding_error=left(coalesce(nullif(trim(p_reason),''),'owner_invitation_failed'),1000) where id=v_inv.tenant_id and onboarding_status<>'active'; end if;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_inv.tenant_id,v_actor,'tenant.invitation_failed','tenant_invitation',v_inv.id::text,jsonb_build_object('reason',left(coalesce(p_reason,'unknown'),1000)));
end $$;

-- Repair only deterministic legacy primary-team states. Never choose among multiple
-- teams by UUID/order. Ambiguous active operational members fail the migration so an
-- administrator must resolve them explicitly instead of receiving a silent reassignment.
update public.tenant_memberships m
set primary_team_id=tm.team_id,updated_at=now()
from public.team_members tm
where m.primary_team_id is null
  and tm.tenant_id=m.tenant_id and tm.user_id=m.user_id and tm.is_primary;

with single_team as (
  select tm.tenant_id,tm.user_id,(array_agg(tm.team_id))[1] as team_id
  from public.team_members tm
  join public.tenant_memberships m on m.tenant_id=tm.tenant_id and m.user_id=tm.user_id
  where m.status='active' and m.role in ('sales','team_lead') and m.primary_team_id is null
  group by tm.tenant_id,tm.user_id
  having count(*)=1
)
update public.tenant_memberships m
set primary_team_id=s.team_id,updated_at=now()
from single_team s
where m.tenant_id=s.tenant_id and m.user_id=s.user_id and m.primary_team_id is null;

update public.team_members tm
set is_primary=false,updated_at=now()
from public.tenant_memberships m
where m.tenant_id=tm.tenant_id and m.user_id=tm.user_id and m.primary_team_id is not null
  and tm.is_primary and tm.team_id<>m.primary_team_id;

update public.team_members tm
set is_primary=true,
    role=case when m.status='active' and m.role='team_lead' then 'manager' else tm.role end,
    updated_at=now()
from public.tenant_memberships m
where m.tenant_id=tm.tenant_id and m.user_id=tm.user_id and m.primary_team_id=tm.team_id
  and (not tm.is_primary or (m.status='active' and m.role='team_lead' and tm.role<>'manager'));

do $$
begin
  if exists(
    select 1 from public.tenant_memberships m
    where m.status='active' and m.role in ('sales','team_lead')
      and (
        m.primary_team_id is null
        or not exists(
          select 1 from public.team_members tm
          where tm.tenant_id=m.tenant_id and tm.user_id=m.user_id
            and tm.team_id=m.primary_team_id and tm.is_primary
            and (m.role<>'team_lead' or tm.role='manager')
        )
      )
  ) then
    raise exception 'legacy_active_operational_members_require_explicit_primary_team_resolution';
  end if;
end $$;

create or replace function private.assert_membership_team_invariants()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_tenant uuid; v_user uuid; v_membership public.tenant_memberships%rowtype; v_primary uuid; v_role text;
begin
  if tg_op='DELETE' then v_tenant:=old.tenant_id; v_user:=old.user_id; else v_tenant:=new.tenant_id; v_user:=new.user_id; end if;
  select * into v_membership from public.tenant_memberships where tenant_id=v_tenant and user_id=v_user;
  if not found then return null; end if;
  if v_membership.status='active' and v_membership.role in ('sales','team_lead') and v_membership.primary_team_id is null then raise exception 'active_operational_member_requires_primary_team'; end if;
  if v_membership.primary_team_id is not null then
    select tm.team_id,tm.role into v_primary,v_role from public.team_members tm
      where tm.tenant_id=v_tenant and tm.user_id=v_user and tm.team_id=v_membership.primary_team_id and tm.is_primary;
    if not found then raise exception 'membership_primary_team_relation_required'; end if;
    if v_membership.status='active' and v_membership.role='team_lead' and v_role<>'manager' then raise exception 'team_lead_primary_team_requires_manager_role'; end if;
  end if;
  if exists(select 1 from public.team_members tm where tm.tenant_id=v_tenant and tm.user_id=v_user and tm.is_primary and tm.team_id is distinct from v_membership.primary_team_id) then
    raise exception 'team_member_primary_must_match_membership';
  end if;
  return null;
end $$;
revoke all on function private.assert_membership_team_invariants() from public,anon,authenticated;

drop trigger if exists tenant_membership_team_invariants_from_membership on public.tenant_memberships;
create constraint trigger tenant_membership_team_invariants_from_membership
after insert or update on public.tenant_memberships deferrable initially deferred
for each row execute function private.assert_membership_team_invariants();

drop trigger if exists tenant_membership_team_invariants_from_team on public.team_members;
create constraint trigger tenant_membership_team_invariants_from_team
after insert or update or delete on public.team_members deferrable initially deferred
for each row execute function private.assert_membership_team_invariants();

-- Repair prior legal-entity gaps without changing the established default service.
insert into public.tenant_legal_entities(tenant_id,legal_name,organization_number,country_code,is_default,active)
select t.id,t.legal_name,t.organization_number,t.country_code,true,true
from public.tenants t
where not exists(select 1 from public.tenant_legal_entities le where le.tenant_id=t.id and le.is_default and le.active);

-- Keep common tenant/team/invitation lookups selective without duplicating PK/unique indexes.
create index if not exists tenant_memberships_user_status_idx on public.tenant_memberships(user_id,status,tenant_id);
create index if not exists tenant_memberships_tenant_status_user_idx on public.tenant_memberships(tenant_id,status,user_id);
create index if not exists tenant_memberships_primary_team_lookup_idx on public.tenant_memberships(tenant_id,primary_team_id) where primary_team_id is not null;
create index if not exists team_members_user_tenant_idx on public.team_members(user_id,tenant_id,team_id);
create index if not exists team_members_assignment_lookup_idx on public.team_members(team_id,assignment_paused,user_id);
create index if not exists tenant_invitations_email_status_idx on public.tenant_invitations(lower(email::text),status,tenant_id);
create index if not exists tenant_invitations_user_status_idx on public.tenant_invitations(invited_user_id,status) where invited_user_id is not null;

-- Public signup and the old half-bootstrap RPC are no longer external tenant-creation paths.
-- The canonical authenticated platform path is create_or_resume_platform_tenant_owner().
revoke all on function public.create_tenant_with_owner(text,text,text) from public,anon,authenticated;
grant execute on function public.create_tenant_with_owner(text,text,text) to service_role;
revoke all on function public.create_platform_tenant(text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.create_platform_tenant(text,text,text,text,text,text) to service_role;

commit;
