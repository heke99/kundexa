begin;

-- Production hardening for the tenant invitation -> membership -> team lifecycle.
-- This migration is intentionally forward-only. It replaces unsafe function
-- behaviour without rewriting historical migrations.

alter table public.tenant_invitations
  add column if not exists orchestration_status text not null default 'legacy',
  add column if not exists idempotency_key text,
  add column if not exists failure_reason text,
  add column if not exists finalized_at timestamptz;

alter table public.tenant_invitations
  drop constraint if exists tenant_invitations_orchestration_status_check;
alter table public.tenant_invitations
  add constraint tenant_invitations_orchestration_status_check
  check (orchestration_status in ('legacy','reserved','finalized','accepted','failed'));

create unique index if not exists tenant_invitations_idempotency_idx
  on public.tenant_invitations(tenant_id,idempotency_key)
  where idempotency_key is not null;

-- Existing invited users must not have operational team membership before they
-- accept the tenant invitation. The invitation already stores the intended teams
-- and the canonical acceptance function below restores them atomically.
delete from public.team_members tm
using public.tenant_memberships m
where m.tenant_id=tm.tenant_id
  and m.user_id=tm.user_id
  and m.status='invited';

-- A suspended membership can retain its team topology, but it must never be
-- operational until deliberately restored.
update public.team_members tm
set assignment_paused=true,
    updated_at=now()
from public.tenant_memberships m
where m.tenant_id=tm.tenant_id
  and m.user_id=tm.user_id
  and m.status='suspended'
  and not tm.assignment_paused;

-- Remove dangling manager authority from roles that can never manage teams.
update public.team_members tm
set role='member',
    updated_at=now()
from public.tenant_memberships m
where m.tenant_id=tm.tenant_id
  and m.user_id=tm.user_id
  and tm.role='manager'
  and m.role not in ('owner','admin','team_lead');

-- A pending invitation must never mutate an already active membership. Mark any
-- pre-hardening collisions failed so they cannot later be accepted accidentally.
update public.tenant_invitations i
set status='failed',
    orchestration_status='failed',
    failure_reason='active_membership_already_exists',
    updated_at=now()
from auth.users u
join public.tenant_memberships m on m.user_id=u.id
where i.tenant_id=m.tenant_id
  and i.status='pending'
  and m.status='active'
  and lower(i.email::text)=lower(coalesce(u.email,''));

create or replace function public.assert_team_capacity(
  p_tenant_id uuid,
  p_team_id uuid,
  p_additional integer default 1,
  p_exclude_invitation_id uuid default null
)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  v_max integer;
  v_members integer;
  v_pending integer;
begin
  if p_additional < 0 then raise exception 'invalid_capacity_delta'; end if;

  select t.max_members
    into v_max
  from public.teams t
  where t.tenant_id=p_tenant_id
    and t.id=p_team_id
    and t.status<>'archived'
  for update;

  if not found then raise exception 'team_not_found'; end if;
  if v_max is null then return; end if;

  select count(*)::integer
    into v_members
  from public.team_members tm
  where tm.tenant_id=p_tenant_id
    and tm.team_id=p_team_id;

  select count(*)::integer
    into v_pending
  from public.tenant_invitations i
  where i.tenant_id=p_tenant_id
    and i.status='pending'
    and i.expires_at>now()
    and p_team_id=any(i.team_ids)
    and (p_exclude_invitation_id is null or i.id<>p_exclude_invitation_id);

  if v_members + v_pending + p_additional > v_max then
    raise exception 'team_member_limit_reached';
  end if;
end $$;

revoke all on function public.assert_team_capacity(uuid,uuid,integer,uuid) from public, anon, authenticated;

create or replace function public.can_manage_team(p_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path=public
as $$
  select exists(
    select 1
    from public.teams t
    where t.id=p_team_id
      and t.tenant_id=public.current_tenant_id()
      and t.status<>'archived'
      and (
        public.is_tenant_admin(t.tenant_id)
        or exists(
          select 1
          from public.team_members tm
          join public.tenant_memberships m
            on m.tenant_id=tm.tenant_id
           and m.user_id=tm.user_id
          where tm.tenant_id=t.tenant_id
            and tm.team_id=t.id
            and tm.user_id=auth.uid()
            and tm.role='manager'
            and not tm.assignment_paused
            and m.status='active'
            and m.role in ('owner','admin','team_lead')
        )
      )
  )
$$;

create or replace function public.reserve_tenant_invitation(
  p_tenant_id uuid,
  p_email text,
  p_role public.membership_role,
  p_team_ids uuid[] default '{}',
  p_message text default null,
  p_expires_at timestamptz default now()+interval '7 days',
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path=public,auth
as $$
declare
  v_actor uuid:=auth.uid();
  v_email text:=lower(trim(coalesce(p_email,'')));
  v_invitation public.tenant_invitations%rowtype;
  v_team_ids uuid[];
  v_team uuid;
  v_is_platform boolean;
  v_existing_status public.membership_status;
begin
  if v_actor is null then raise exception 'authentication_required'; end if;
  if v_email='' or position('@' in v_email)=0 then raise exception 'valid_email_required'; end if;
  if p_expires_at<=now() then raise exception 'invitation_expiry_must_be_future'; end if;

  select coalesce(array_agg(distinct x.team_id order by x.team_id),'{}'::uuid[])
    into v_team_ids
  from unnest(coalesce(p_team_ids,'{}'::uuid[])) as x(team_id);

  v_is_platform:=public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role]);
  if not v_is_platform and p_tenant_id<>public.current_tenant_id() then raise exception 'tenant_mismatch'; end if;

  if not v_is_platform and not public.is_tenant_admin(p_tenant_id) then
    if public.current_membership_role()<>'team_lead' or p_role<>'sales' then
      raise exception 'invitation_permission_required';
    end if;
    if coalesce(array_length(v_team_ids,1),0)=0 then
      raise exception 'team_required_for_team_lead_invitation';
    end if;
    if exists(
      select 1 from unnest(v_team_ids) as requested(team_id)
      where not public.can_manage_team(requested.team_id)
    ) then raise exception 'team_manage_permission_required'; end if;
    if exists(
      select 1 from public.teams t
      where t.tenant_id=p_tenant_id
        and t.id=any(v_team_ids)
        and not t.invite_sellers_enabled
    ) then raise exception 'team_seller_invitations_disabled'; end if;
  end if;

  if p_role='owner' and not v_is_platform and public.current_membership_role()<>'owner' then
    raise exception 'owner_invitation_requires_owner';
  end if;
  if p_role='team_lead' and coalesce(array_length(v_team_ids,1),0)=0 then
    raise exception 'team_lead_requires_team';
  end if;

  if exists(
    select 1
    from unnest(v_team_ids) as requested(team_id)
    where not exists(
      select 1
      from public.teams t
      where t.tenant_id=p_tenant_id
        and t.id=requested.team_id
        and t.status<>'archived'
    )
  ) then raise exception 'invitation_team_not_found'; end if;

  select m.status
    into v_existing_status
  from auth.users u
  join public.tenant_memberships m
    on m.user_id=u.id
   and m.tenant_id=p_tenant_id
  where lower(coalesce(u.email,''))=v_email
  order by m.updated_at desc
  limit 1
  for update of m;

  if found and v_existing_status='active' then raise exception 'active_tenant_member_already_exists'; end if;
  if found and v_existing_status='suspended' then raise exception 'suspended_member_requires_reactivation'; end if;
  if found and v_existing_status='removed' then raise exception 'removed_member_requires_reactivation_workflow'; end if;

  select *
    into v_invitation
  from public.tenant_invitations i
  where i.tenant_id=p_tenant_id
    and lower(i.email::text)=v_email
    and i.status='pending'
  order by i.created_at desc
  limit 1
  for update;

  foreach v_team in array v_team_ids loop
    perform public.assert_team_capacity(
      p_tenant_id,
      v_team,
      1,
      case when found then v_invitation.id else null end
    );
  end loop;

  if found then
    update public.tenant_invitations
    set role=p_role,
        team_ids=v_team_ids,
        message=nullif(trim(coalesce(p_message,'')),''),
        invited_by=v_actor,
        expires_at=p_expires_at,
        orchestration_status='reserved',
        idempotency_key=coalesce(nullif(trim(coalesce(p_idempotency_key,'')),''),idempotency_key),
        failure_reason=null,
        finalized_at=null,
        updated_at=now()
    where id=v_invitation.id
    returning id into v_invitation.id;
  else
    insert into public.tenant_invitations(
      tenant_id,email,role,status,invited_by,team_ids,message,expires_at,
      orchestration_status,idempotency_key
    ) values (
      p_tenant_id,v_email,p_role,'pending',v_actor,v_team_ids,
      nullif(trim(coalesce(p_message,'')),''),p_expires_at,'reserved',
      nullif(trim(coalesce(p_idempotency_key,'')),'')
    ) returning id into v_invitation.id;
  end if;

  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(
    p_tenant_id,v_actor,'tenant.invitation_reserved','tenant_invitation',v_invitation.id::text,
    jsonb_build_object('email',v_email,'role',p_role,'team_ids',v_team_ids)
  );

  return v_invitation.id;
end $$;

create or replace function public.finalize_tenant_invitation(
  p_invitation_id uuid,
  p_invited_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path=public,auth
as $$
declare
  v_actor uuid:=auth.uid();
  v_inv public.tenant_invitations%rowtype;
  v_user_email text;
  v_existing public.tenant_memberships%rowtype;
  v_is_platform boolean;
begin
  if v_actor is null then raise exception 'authentication_required'; end if;

  select * into v_inv
  from public.tenant_invitations
  where id=p_invitation_id
    and status='pending'
    and expires_at>now()
  for update;
  if not found then raise exception 'pending_invitation_not_found'; end if;

  v_is_platform:=public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role]);
  if not v_is_platform and v_inv.tenant_id<>public.current_tenant_id() then raise exception 'tenant_mismatch'; end if;
  if not v_is_platform and not public.is_tenant_admin(v_inv.tenant_id) then
    if public.current_membership_role()<>'team_lead' or v_inv.role<>'sales' then
      raise exception 'invitation_permission_required';
    end if;
    if exists(
      select 1 from unnest(v_inv.team_ids) as requested(team_id)
      where not public.can_manage_team(requested.team_id)
    ) then raise exception 'team_manage_permission_required'; end if;
  end if;

  select lower(coalesce(email,'')) into v_user_email
  from auth.users
  where id=p_invited_user_id;
  if v_user_email is null or v_user_email<>lower(v_inv.email::text) then
    raise exception 'invited_user_email_mismatch';
  end if;

  select * into v_existing
  from public.tenant_memberships
  where tenant_id=v_inv.tenant_id
    and user_id=p_invited_user_id
  for update;

  if found and v_existing.status='active' then raise exception 'active_tenant_member_already_exists'; end if;
  if found and v_existing.status='suspended' then raise exception 'suspended_member_requires_reactivation'; end if;
  if found and v_existing.status='removed' then raise exception 'removed_member_requires_reactivation_workflow'; end if;

  if found then
    update public.tenant_memberships
    set role=v_inv.role,
        status='invited',
        invited_by=v_inv.invited_by,
        invited_at=coalesce(invited_at,now()),
        updated_at=now()
    where tenant_id=v_inv.tenant_id
      and user_id=p_invited_user_id;
  else
    insert into public.tenant_memberships(
      tenant_id,user_id,role,status,invited_by,invited_at
    ) values (
      v_inv.tenant_id,p_invited_user_id,v_inv.role,'invited',v_inv.invited_by,now()
    );
  end if;

  update public.tenant_invitations
  set invited_user_id=p_invited_user_id,
      orchestration_status='finalized',
      finalized_at=now(),
      failure_reason=null,
      updated_at=now()
  where id=v_inv.id;

  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(
    v_inv.tenant_id,v_actor,'tenant.invitation_finalized','tenant_invitation',v_inv.id::text,
    jsonb_build_object('invited_user_id',p_invited_user_id,'role',v_inv.role)
  );

  return v_inv.id;
end $$;

create or replace function public.fail_tenant_invitation(
  p_invitation_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  v_actor uuid:=auth.uid();
  v_inv public.tenant_invitations%rowtype;
  v_is_platform boolean;
begin
  if v_actor is null then raise exception 'authentication_required'; end if;
  select * into v_inv
  from public.tenant_invitations
  where id=p_invitation_id
    and status='pending'
  for update;
  if not found then return; end if;

  v_is_platform:=public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role]);
  if not v_is_platform and v_inv.tenant_id<>public.current_tenant_id() then raise exception 'tenant_mismatch'; end if;
  if not v_is_platform and not public.is_tenant_admin(v_inv.tenant_id) and v_inv.invited_by<>v_actor then
    raise exception 'invitation_permission_required';
  end if;

  update public.tenant_invitations
  set status='failed',
      orchestration_status='failed',
      failure_reason=left(nullif(trim(coalesce(p_reason,'')),''),1000),
      updated_at=now()
  where id=v_inv.id;

  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(
    v_inv.tenant_id,v_actor,'tenant.invitation_failed','tenant_invitation',v_inv.id::text,
    jsonb_build_object('reason',left(coalesce(p_reason,'unknown'),1000))
  );
end $$;

-- Compatibility wrapper for older callers. It is now safe: it may create an
-- invited tenant_membership but never creates team_members and never changes an
-- already-active membership.
create or replace function public.register_tenant_invitation(
  p_tenant_id uuid,
  p_invited_user_id uuid,
  p_email text,
  p_role public.membership_role,
  p_team_ids uuid[] default '{}',
  p_message text default null,
  p_expires_at timestamptz default now()+interval '7 days'
)
returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  v_invitation uuid;
begin
  v_invitation:=public.reserve_tenant_invitation(
    p_tenant_id,
    p_email,
    p_role,
    p_team_ids,
    p_message,
    p_expires_at,
    'legacy:'||p_invited_user_id::text||':'||lower(trim(p_email))
  );
  perform public.finalize_tenant_invitation(v_invitation,p_invited_user_id);
  return v_invitation;
end $$;

create or replace function public.activate_current_user_invitation()
returns uuid
language plpgsql
security definer
set search_path=public,auth
as $$
declare
  v_user uuid:=auth.uid();
  v_email text;
  v_inv public.tenant_invitations%rowtype;
  v_existing public.tenant_memberships%rowtype;
  v_team uuid;
  v_team_role text;
  v_primary_team uuid;
begin
  if v_user is null then return null; end if;
  select lower(coalesce(email,'')) into v_email from auth.users where id=v_user;

  select * into v_inv
  from public.tenant_invitations
  where status='pending'
    and expires_at>now()
    and (invited_user_id=v_user or lower(email::text)=v_email)
  order by created_at desc
  limit 1
  for update;

  -- No legacy tenant_memberships fallback: a valid pending invitation is the
  -- sole source of truth for activation.
  if not found then return null; end if;

  if v_inv.role='team_lead' and coalesce(array_length(v_inv.team_ids,1),0)=0 then
    raise exception 'team_lead_requires_team';
  end if;

  select * into v_existing
  from public.tenant_memberships
  where tenant_id=v_inv.tenant_id
    and user_id=v_user
  for update;

  if found and v_existing.status='active' then raise exception 'active_tenant_member_already_exists'; end if;
  if found and v_existing.status='suspended' then raise exception 'suspended_member_requires_reactivation'; end if;
  if found and v_existing.status='removed' then raise exception 'removed_member_requires_reactivation_workflow'; end if;

  foreach v_team in array coalesce(v_inv.team_ids,'{}'::uuid[]) loop
    perform public.assert_team_capacity(v_inv.tenant_id,v_team,1,v_inv.id);
  end loop;

  if found then
    update public.tenant_memberships
    set role=v_inv.role,
        status='active',
        invited_by=coalesce(invited_by,v_inv.invited_by),
        invited_at=coalesce(invited_at,v_inv.created_at),
        joined_at=coalesce(joined_at,now()),
        deactivated_at=null,
        deactivated_by=null,
        updated_at=now()
    where tenant_id=v_inv.tenant_id
      and user_id=v_user;
  else
    insert into public.tenant_memberships(
      tenant_id,user_id,role,status,invited_by,invited_at,joined_at
    ) values (
      v_inv.tenant_id,v_user,v_inv.role,'active',v_inv.invited_by,v_inv.created_at,now()
    );
  end if;

  v_team_role:=case when v_inv.role in ('owner','admin','team_lead') then 'manager' else 'member' end;
  if coalesce(array_length(v_inv.team_ids,1),0)>0 then
    v_primary_team:=v_inv.team_ids[1];
  end if;

  foreach v_team in array coalesce(v_inv.team_ids,'{}'::uuid[]) loop
    insert into public.team_members(
      tenant_id,team_id,user_id,role,is_primary,assignment_paused,joined_at,updated_at
    ) values (
      v_inv.tenant_id,v_team,v_user,v_team_role,v_team=v_primary_team,false,now(),now()
    )
    on conflict(team_id,user_id) do update set
      role=excluded.role,
      is_primary=excluded.is_primary,
      assignment_paused=false,
      updated_at=now();
  end loop;

  if v_primary_team is not null then
    update public.team_members
    set is_primary=false,
        updated_at=now()
    where tenant_id=v_inv.tenant_id
      and user_id=v_user
      and team_id<>v_primary_team;
    update public.tenant_memberships
    set primary_team_id=v_primary_team,
        updated_at=now()
    where tenant_id=v_inv.tenant_id
      and user_id=v_user;
  end if;

  update public.tenant_invitations
  set status='accepted',
      invited_user_id=v_user,
      orchestration_status='accepted',
      finalized_at=coalesce(finalized_at,now()),
      accepted_at=now(),
      updated_at=now()
  where id=v_inv.id;

  update public.profiles
  set active_tenant_id=coalesce(active_tenant_id,v_inv.tenant_id),
      updated_at=now()
  where id=v_user;

  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(
    v_inv.tenant_id,v_user,'tenant.invitation_accepted','tenant_membership',v_user::text,
    jsonb_build_object('tenant_id',v_inv.tenant_id,'invitation_id',v_inv.id,'role',v_inv.role,'team_ids',v_inv.team_ids)
  );

  return v_inv.tenant_id;
end $$;

create or replace function public.set_managed_team_member(
  p_team_id uuid,
  p_user_id uuid,
  p_team_role text default 'member',
  p_is_primary boolean default false,
  p_daily_lead_limit integer default null,
  p_assignment_paused boolean default false
)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_actor uuid:=auth.uid();
  v_member_role public.membership_role;
  v_exists boolean;
begin
  if not public.can_manage_team(p_team_id) then raise exception 'team_manage_permission_required'; end if;
  if p_team_role not in ('manager','member') then raise exception 'invalid_team_role'; end if;
  if p_daily_lead_limit is not null and (p_daily_lead_limit<1 or p_daily_lead_limit>10000) then
    raise exception 'invalid_daily_lead_limit';
  end if;

  select role into v_member_role
  from public.tenant_memberships
  where tenant_id=v_tenant
    and user_id=p_user_id
    and status='active';
  if not found then raise exception 'active_tenant_member_required'; end if;

  if not public.is_tenant_admin(v_tenant) then
    if v_member_role<>'sales' or p_team_role<>'member' then
      raise exception 'team_lead_can_only_manage_sellers';
    end if;
  elsif p_team_role='manager' and v_member_role not in ('owner','admin','team_lead') then
    raise exception 'manager_membership_role_required';
  end if;

  select exists(
    select 1 from public.team_members
    where tenant_id=v_tenant and team_id=p_team_id and user_id=p_user_id
  ) into v_exists;
  if not v_exists then perform public.assert_team_capacity(v_tenant,p_team_id,1,null); end if;

  if p_is_primary then
    update public.team_members
    set is_primary=false,
        updated_at=now()
    where tenant_id=v_tenant
      and user_id=p_user_id
      and team_id<>p_team_id;
    update public.tenant_memberships
    set primary_team_id=p_team_id,
        updated_at=now()
    where tenant_id=v_tenant
      and user_id=p_user_id;
  end if;

  insert into public.team_members(
    tenant_id,team_id,user_id,role,is_primary,daily_lead_limit,assignment_paused,joined_at,updated_at
  ) values (
    v_tenant,p_team_id,p_user_id,p_team_role,p_is_primary,p_daily_lead_limit,p_assignment_paused,now(),now()
  )
  on conflict(team_id,user_id) do update set
    role=excluded.role,
    is_primary=excluded.is_primary,
    daily_lead_limit=excluded.daily_lead_limit,
    assignment_paused=excluded.assignment_paused,
    updated_at=now();

  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(
    v_tenant,v_actor,'team.member_set','team_member',p_team_id::text||':'||p_user_id::text,
    jsonb_build_object('team_id',p_team_id,'user_id',p_user_id,'team_role',p_team_role,'primary',p_is_primary,'assignment_paused',p_assignment_paused)
  );
end $$;

create or replace function public.update_tenant_member(
  p_user_id uuid,
  p_role public.membership_role,
  p_status public.membership_status,
  p_reassign_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_actor uuid:=auth.uid();
  v_actor_role public.membership_role:=public.current_membership_role();
  v_before public.tenant_memberships%rowtype;
  v_owner_count integer;
  v_primary_team uuid;
begin
  if v_tenant is null or v_actor is null or v_actor_role not in ('owner','admin') then raise exception 'tenant_admin_required'; end if;

  select * into v_before
  from public.tenant_memberships
  where tenant_id=v_tenant and user_id=p_user_id
  for update;
  if not found then raise exception 'tenant_member_not_found'; end if;

  if p_status not in ('invited','active','suspended','removed') then raise exception 'invalid_membership_status'; end if;
  if p_status='invited' and v_before.status<>'invited' then raise exception 'active_member_cannot_return_to_invited'; end if;
  if v_before.status='invited' and p_status not in ('invited','removed') then raise exception 'invitation_must_be_accepted_by_user'; end if;
  if v_before.status='removed' and p_status<>'removed' then raise exception 'removed_member_requires_reactivation_workflow'; end if;

  if v_actor=p_user_id and (p_role is distinct from v_before.role or p_status<>'active') then
    raise exception 'cannot_change_own_role_or_status';
  end if;
  if v_actor_role='admin' and (v_before.role in ('owner','admin') or p_role in ('owner','admin')) then
    raise exception 'owner_required_for_privileged_role';
  end if;

  if v_before.role='owner' and (p_role<>'owner' or p_status<>'active') then
    select count(*) into v_owner_count
    from public.tenant_memberships
    where tenant_id=v_tenant and role='owner' and status='active';
    if v_owner_count<=1 then raise exception 'tenant_requires_active_owner'; end if;
  end if;

  if p_reassign_user_id=p_user_id then raise exception 'invalid_reassignment_target'; end if;
  if p_reassign_user_id is not null and not exists(
    select 1 from public.tenant_memberships
    where tenant_id=v_tenant and user_id=p_reassign_user_id and status='active'
  ) then raise exception 'active_reassignment_target_required'; end if;

  if p_role='team_lead' and p_status='active' then
    select tm.team_id
      into v_primary_team
    from public.team_members tm
    join public.teams t
      on t.tenant_id=tm.tenant_id
     and t.id=tm.team_id
    where tm.tenant_id=v_tenant
      and tm.user_id=p_user_id
      and t.status<>'archived'
    order by (tm.team_id=v_before.primary_team_id) desc,tm.is_primary desc,tm.joined_at asc
    limit 1
    for update of tm;
    if v_primary_team is null then raise exception 'team_lead_requires_team_assignment'; end if;
  end if;

  if p_status='removed' then
    update public.tenant_invitations
    set status='revoked',revoked_at=now(),updated_at=now()
    where tenant_id=v_tenant and invited_user_id=p_user_id and status='pending';
  end if;

  if p_status in ('suspended','removed') then
    update public.customer_list_seller_assignments
    set status=case when p_status='removed' then 'ended' else 'paused' end,
        updated_at=now()
    where tenant_id=v_tenant and user_id=p_user_id and status='active';

    update public.customer_list_members
    set assigned_user_id=p_reassign_user_id,
        updated_at=now()
    where tenant_id=v_tenant
      and assigned_user_id=p_user_id
      and state not in ('completed','blocked');

    update public.customer_list_members
    set claimed_by=null,
        claim_expires_at=null,
        state=case when state='claimed' then 'pending' else state end,
        updated_at=now()
    where tenant_id=v_tenant
      and claimed_by=p_user_id
      and state in ('pending','claimed','retry','callback','skipped');

    update public.customers
    set assigned_user_id=p_reassign_user_id,
        updated_at=now()
    where tenant_id=v_tenant and assigned_user_id=p_user_id;

    update public.activities
    set assigned_user_id=p_reassign_user_id,
        updated_at=now()
    where tenant_id=v_tenant
      and assigned_user_id=p_user_id
      and status in ('open','in_progress');

    update public.deals
    set owner_user_id=p_reassign_user_id,
        updated_at=now()
    where tenant_id=v_tenant
      and owner_user_id=p_user_id
      and status='open';

    if p_status='removed' then
      delete from public.team_members
      where tenant_id=v_tenant and user_id=p_user_id;
    else
      update public.team_members
      set assignment_paused=true,
          updated_at=now()
      where tenant_id=v_tenant and user_id=p_user_id;
    end if;
  end if;

  update public.tenant_memberships
  set role=p_role,
      status=p_status,
      deactivated_at=case when p_status in ('suspended','removed') then now() else null end,
      deactivated_by=case when p_status in ('suspended','removed') then v_actor else null end,
      joined_at=case when p_status='active' then coalesce(joined_at,now()) else joined_at end,
      updated_at=now()
  where tenant_id=v_tenant and user_id=p_user_id;

  if p_role='team_lead' and p_status='active' then
    update public.team_members
    set role='member',
        is_primary=false,
        updated_at=now()
    where tenant_id=v_tenant
      and user_id=p_user_id
      and role='manager';

    update public.team_members
    set role='manager',
        is_primary=true,
        assignment_paused=false,
        updated_at=now()
    where tenant_id=v_tenant
      and team_id=v_primary_team
      and user_id=p_user_id;

    update public.tenant_memberships
    set primary_team_id=v_primary_team,
        updated_at=now()
    where tenant_id=v_tenant and user_id=p_user_id;
  elsif p_role not in ('owner','admin','team_lead') then
    update public.team_members
    set role='member',
        updated_at=now()
    where tenant_id=v_tenant
      and user_id=p_user_id
      and role='manager';
  end if;

  if p_status in ('suspended','removed') then
    update public.profiles p
    set active_tenant_id=(
      select m.tenant_id
      from public.tenant_memberships m
      join public.tenants t on t.id=m.tenant_id
      where m.user_id=p_user_id
        and m.status='active'
        and m.tenant_id<>v_tenant
        and t.status in ('trial','active')
      order by m.joined_at desc nulls last,m.created_at desc
      limit 1
    ),
    updated_at=now()
    where p.id=p_user_id and p.active_tenant_id=v_tenant;
  end if;

  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,before_data,after_data)
  values(
    v_tenant,v_actor,'tenant.member_updated','tenant_membership',p_user_id::text,
    jsonb_build_object('role',v_before.role,'status',v_before.status),
    jsonb_build_object('role',p_role,'status',p_status,'reassigned_to',p_reassign_user_id,'primary_team_id',v_primary_team)
  );
end $$;

create or replace function public.reactivate_removed_tenant_member(
  p_user_id uuid,
  p_role public.membership_role,
  p_primary_team_id uuid default null
)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_actor uuid:=auth.uid();
  v_actor_role public.membership_role:=public.current_membership_role();
  v_before public.tenant_memberships%rowtype;
  v_team_role text;
begin
  if v_tenant is null or v_actor is null or v_actor_role not in ('owner','admin') then raise exception 'tenant_admin_required'; end if;
  if v_actor=p_user_id then raise exception 'cannot_reactivate_self'; end if;
  if v_actor_role='admin' and p_role in ('owner','admin') then raise exception 'owner_required_for_privileged_role'; end if;
  if p_role='team_lead' and p_primary_team_id is null then raise exception 'team_lead_requires_team_assignment'; end if;

  select * into v_before
  from public.tenant_memberships
  where tenant_id=v_tenant and user_id=p_user_id
  for update;
  if not found then raise exception 'tenant_member_not_found'; end if;
  if v_before.status<>'removed' then raise exception 'removed_membership_required'; end if;

  if p_primary_team_id is not null then
    perform public.assert_team_capacity(v_tenant,p_primary_team_id,1,null);
  end if;

  update public.tenant_memberships
  set role=p_role,
      status='active',
      primary_team_id=p_primary_team_id,
      deactivated_at=null,
      deactivated_by=null,
      joined_at=coalesce(joined_at,now()),
      updated_at=now()
  where tenant_id=v_tenant and user_id=p_user_id;

  if p_primary_team_id is not null then
    v_team_role:=case when p_role in ('owner','admin','team_lead') then 'manager' else 'member' end;
    insert into public.team_members(
      tenant_id,team_id,user_id,role,is_primary,assignment_paused,joined_at,updated_at
    ) values (
      v_tenant,p_primary_team_id,p_user_id,v_team_role,true,false,now(),now()
    )
    on conflict(team_id,user_id) do update set
      role=excluded.role,
      is_primary=true,
      assignment_paused=false,
      updated_at=now();
  end if;

  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,before_data,after_data)
  values(
    v_tenant,v_actor,'tenant.member_reactivated','tenant_membership',p_user_id::text,
    jsonb_build_object('role',v_before.role,'status',v_before.status),
    jsonb_build_object('role',p_role,'status','active','primary_team_id',p_primary_team_id)
  );
end $$;

revoke all on function public.reserve_tenant_invitation(uuid,text,public.membership_role,uuid[],text,timestamptz,text) from public, anon;
revoke all on function public.finalize_tenant_invitation(uuid,uuid) from public, anon;
revoke all on function public.fail_tenant_invitation(uuid,text) from public, anon;
revoke all on function public.reactivate_removed_tenant_member(uuid,public.membership_role,uuid) from public, anon;

grant execute on function public.reserve_tenant_invitation(uuid,text,public.membership_role,uuid[],text,timestamptz,text) to authenticated;
grant execute on function public.finalize_tenant_invitation(uuid,uuid) to authenticated;
grant execute on function public.fail_tenant_invitation(uuid,text) to authenticated;
grant execute on function public.reactivate_removed_tenant_member(uuid,public.membership_role,uuid) to authenticated;

commit;
