begin;

-- KUNDEXA production remediation: platform -> tenant -> invitation -> membership -> team.
-- Forward-only: historical migrations stay immutable and this migration becomes the
-- canonical owner of the hardened behaviour.

alter table public.tenants
  add column if not exists onboarding_status text not null default 'active',
  add column if not exists owner_user_id uuid references auth.users(id) on delete set null,
  add column if not exists owner_invitation_id uuid,
  add column if not exists onboarding_completed_at timestamptz,
  add column if not exists onboarding_error text;

alter table public.tenants drop constraint if exists tenants_onboarding_status_check;
alter table public.tenants add constraint tenants_onboarding_status_check
  check(onboarding_status in ('creating','awaiting_owner','onboarding','active','failed'));

alter table public.tenant_invitations
  add column if not exists orchestration_status text not null default 'legacy',
  add column if not exists idempotency_key text,
  add column if not exists failure_reason text,
  add column if not exists finalized_at timestamptz;

alter table public.tenant_invitations drop constraint if exists tenant_invitations_orchestration_status_check;
alter table public.tenant_invitations add constraint tenant_invitations_orchestration_status_check
  check(orchestration_status in ('legacy','reserved','finalized','accepted','failed'));

create unique index if not exists tenant_invitations_idempotency_idx
  on public.tenant_invitations(tenant_id,idempotency_key)
  where idempotency_key is not null;

-- Pre-hardening invited users must not hold operational team authority.
delete from public.team_members tm
using public.tenant_memberships m
where m.tenant_id=tm.tenant_id and m.user_id=tm.user_id and m.status='invited';

update public.team_members tm
set assignment_paused=true,updated_at=now()
from public.tenant_memberships m
where m.tenant_id=tm.tenant_id and m.user_id=tm.user_id
  and m.status='suspended' and not tm.assignment_paused;

update public.team_members tm
set role='member',updated_at=now()
from public.tenant_memberships m
where m.tenant_id=tm.tenant_id and m.user_id=tm.user_id
  and tm.role='manager' and m.role not in ('owner','admin','team_lead');

-- A pending invite colliding with an already-active membership is invalid. Do not
-- allow it to become a second role mutation path.
update public.tenant_invitations i
set status='failed',orchestration_status='failed',failure_reason='active_membership_already_exists',updated_at=now()
from auth.users u
join public.tenant_memberships m on m.user_id=u.id
where i.tenant_id=m.tenant_id and i.status='pending' and m.status='active'
  and lower(i.email::text)=lower(coalesce(u.email,''));

create or replace function public.assert_team_capacity(
  p_tenant_id uuid,
  p_team_id uuid,
  p_additional integer default 1,
  p_exclude_invitation_id uuid default null
) returns void
language plpgsql security definer set search_path=public as $$
declare v_max integer; v_members integer; v_pending integer;
begin
  if p_additional<0 then raise exception 'invalid_capacity_delta'; end if;
  select max_members into v_max from public.teams
    where tenant_id=p_tenant_id and id=p_team_id and status<>'archived' for update;
  if not found then raise exception 'team_not_found'; end if;
  if v_max is null then return; end if;
  select count(*)::integer into v_members from public.team_members
    where tenant_id=p_tenant_id and team_id=p_team_id;
  select count(*)::integer into v_pending from public.tenant_invitations i
    where i.tenant_id=p_tenant_id and i.status='pending' and i.expires_at>now()
      and p_team_id=any(i.team_ids)
      and (p_exclude_invitation_id is null or i.id<>p_exclude_invitation_id);
  if v_members+v_pending+p_additional>v_max then raise exception 'team_member_limit_reached'; end if;
end $$;

create or replace function public.can_manage_team(p_team_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.teams t
    where t.id=p_team_id and t.tenant_id=public.current_tenant_id() and t.status<>'archived'
      and (
        public.is_tenant_admin(t.tenant_id)
        or exists(
          select 1 from public.team_members tm
          join public.tenant_memberships m on m.tenant_id=tm.tenant_id and m.user_id=tm.user_id
          where tm.tenant_id=t.tenant_id and tm.team_id=t.id and tm.user_id=auth.uid()
            and tm.role='manager' and not tm.assignment_paused
            and m.status='active' and m.role='team_lead'
        )
      )
  )
$$;

create or replace function public.can_operate_in_team(p_team_id uuid,p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1
    from public.teams t
    join public.tenant_memberships m on m.tenant_id=t.tenant_id and m.user_id=p_user_id and m.status='active'
    join public.tenants tenant on tenant.id=t.tenant_id and tenant.status in ('trial','active')
    join public.team_members tm on tm.tenant_id=t.tenant_id and tm.team_id=t.id and tm.user_id=p_user_id
    where t.id=p_team_id and t.tenant_id=public.current_tenant_id()
      and t.status='active' and not tm.assignment_paused
  )
$$;

create or replace function public.can_read_team(p_team_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select public.is_tenant_admin(public.current_tenant_id())
    or exists(
      select 1 from public.team_members tm
      join public.tenant_memberships m on m.tenant_id=tm.tenant_id and m.user_id=tm.user_id
      where tm.tenant_id=public.current_tenant_id() and tm.team_id=p_team_id and tm.user_id=auth.uid()
        and m.status='active'
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
) returns uuid
language plpgsql security definer set search_path=public,auth as $$
declare
  v_actor uuid:=auth.uid(); v_email text:=lower(trim(coalesce(p_email,'')));
  v_inv public.tenant_invitations%rowtype; v_team_ids uuid[]; v_team uuid;
  v_is_platform boolean; v_existing_status public.membership_status;
  v_has_membership boolean:=false; v_has_invitation boolean:=false;
begin
  if v_actor is null then raise exception 'authentication_required'; end if;
  if v_email='' or position('@' in v_email)=0 then raise exception 'valid_email_required'; end if;
  if p_expires_at<=now() then raise exception 'invitation_expiry_must_be_future'; end if;

  select coalesce(array_agg(distinct x.team_id order by x.team_id),'{}'::uuid[])
    into v_team_ids from unnest(coalesce(p_team_ids,'{}'::uuid[])) as x(team_id);

  v_is_platform:=public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role]);
  if not v_is_platform and p_tenant_id<>public.current_tenant_id() then raise exception 'tenant_mismatch'; end if;
  if not v_is_platform and not public.is_tenant_admin(p_tenant_id) then
    if public.current_membership_role()<>'team_lead' or p_role<>'sales' then raise exception 'invitation_permission_required'; end if;
    if coalesce(array_length(v_team_ids,1),0)=0 then raise exception 'team_required_for_team_lead_invitation'; end if;
    if exists(select 1 from unnest(v_team_ids) x(team_id) where not public.can_manage_team(x.team_id)) then raise exception 'team_manage_permission_required'; end if;
    if exists(select 1 from public.teams t where t.tenant_id=p_tenant_id and t.id=any(v_team_ids) and not t.invite_sellers_enabled) then raise exception 'team_seller_invitations_disabled'; end if;
  end if;
  if p_role='owner' and not v_is_platform and public.current_membership_role()<>'owner' then raise exception 'owner_invitation_requires_owner'; end if;
  if p_role='team_lead' and coalesce(array_length(v_team_ids,1),0)=0 then raise exception 'team_lead_requires_team'; end if;
  if exists(select 1 from unnest(v_team_ids) x(team_id) where not exists(
    select 1 from public.teams t where t.tenant_id=p_tenant_id and t.id=x.team_id and t.status<>'archived'
  )) then raise exception 'invitation_team_not_found'; end if;

  select m.status into v_existing_status
  from auth.users u join public.tenant_memberships m on m.user_id=u.id and m.tenant_id=p_tenant_id
  where lower(coalesce(u.email,''))=v_email order by m.updated_at desc limit 1 for update of m;
  v_has_membership:=found;
  if v_has_membership and v_existing_status='active' then raise exception 'active_tenant_member_already_exists'; end if;
  if v_has_membership and v_existing_status='suspended' then raise exception 'suspended_member_requires_reactivation'; end if;
  if v_has_membership and v_existing_status='removed' then raise exception 'removed_member_requires_reactivation_workflow'; end if;

  select * into v_inv from public.tenant_invitations i
    where i.tenant_id=p_tenant_id and lower(i.email::text)=v_email and i.status='pending'
    order by i.created_at desc limit 1 for update;
  v_has_invitation:=found;

  foreach v_team in array v_team_ids loop
    perform public.assert_team_capacity(p_tenant_id,v_team,1,case when v_has_invitation then v_inv.id else null end);
  end loop;

  if v_has_invitation then
    update public.tenant_invitations set
      role=p_role,team_ids=v_team_ids,message=nullif(trim(coalesce(p_message,'')),''),invited_by=v_actor,
      expires_at=p_expires_at,orchestration_status='reserved',
      idempotency_key=coalesce(nullif(trim(coalesce(p_idempotency_key,'')),''),idempotency_key),
      failure_reason=null,finalized_at=null,updated_at=now()
    where id=v_inv.id returning * into v_inv;
  else
    insert into public.tenant_invitations(tenant_id,email,role,status,invited_by,team_ids,message,expires_at,orchestration_status,idempotency_key)
    values(p_tenant_id,v_email,p_role,'pending',v_actor,v_team_ids,nullif(trim(coalesce(p_message,'')),''),p_expires_at,'reserved',nullif(trim(coalesce(p_idempotency_key,'')),''))
    returning * into v_inv;
  end if;

  update public.tenants set
    owner_invitation_id=case when p_role='owner' then v_inv.id else owner_invitation_id end,
    onboarding_status=case when p_role='owner' and onboarding_status in ('creating','failed') then 'awaiting_owner' else onboarding_status end,
    onboarding_error=null
  where id=p_tenant_id;

  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(p_tenant_id,v_actor,'tenant.invitation_reserved','tenant_invitation',v_inv.id::text,jsonb_build_object('email',v_email,'role',p_role,'team_ids',v_team_ids));
  return v_inv.id;
end $$;

create or replace function public.finalize_tenant_invitation(p_invitation_id uuid,p_invited_user_id uuid)
returns uuid language plpgsql security definer set search_path=public,auth as $$
declare
  v_actor uuid:=auth.uid(); v_inv public.tenant_invitations%rowtype; v_email text;
  v_existing public.tenant_memberships%rowtype; v_has_membership boolean:=false; v_is_platform boolean;
begin
  if v_actor is null then raise exception 'authentication_required'; end if;
  select * into v_inv from public.tenant_invitations
    where id=p_invitation_id and status='pending' and expires_at>now() and revoked_at is null for update;
  if not found then raise exception 'pending_invitation_not_found'; end if;
  v_is_platform:=public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role]);
  if not v_is_platform and v_inv.tenant_id<>public.current_tenant_id() then raise exception 'tenant_mismatch'; end if;
  if not v_is_platform and not public.is_tenant_admin(v_inv.tenant_id) then
    if public.current_membership_role()<>'team_lead' or v_inv.role<>'sales' then raise exception 'invitation_permission_required'; end if;
    if exists(select 1 from unnest(v_inv.team_ids) x(team_id) where not public.can_manage_team(x.team_id)) then raise exception 'team_manage_permission_required'; end if;
  end if;
  select lower(coalesce(email,'')) into v_email from auth.users where id=p_invited_user_id;
  if v_email is null or v_email<>lower(v_inv.email::text) then raise exception 'invited_user_email_mismatch'; end if;

  select * into v_existing from public.tenant_memberships
    where tenant_id=v_inv.tenant_id and user_id=p_invited_user_id for update;
  v_has_membership:=found;
  if v_has_membership and v_existing.status='active' then raise exception 'active_tenant_member_already_exists'; end if;
  if v_has_membership and v_existing.status='suspended' then raise exception 'suspended_member_requires_reactivation'; end if;
  if v_has_membership and v_existing.status='removed' then raise exception 'removed_member_requires_reactivation_workflow'; end if;

  if v_has_membership then
    update public.tenant_memberships set role=v_inv.role,status='invited',invited_by=v_inv.invited_by,
      invited_at=coalesce(invited_at,now()),updated_at=now()
      where tenant_id=v_inv.tenant_id and user_id=p_invited_user_id;
  else
    insert into public.tenant_memberships(tenant_id,user_id,role,status,invited_by,invited_at)
      values(v_inv.tenant_id,p_invited_user_id,v_inv.role,'invited',v_inv.invited_by,now());
  end if;

  update public.tenant_invitations set invited_user_id=p_invited_user_id,orchestration_status='finalized',finalized_at=now(),failure_reason=null,updated_at=now()
    where id=v_inv.id;
  if v_inv.role='owner' then update public.tenants set onboarding_status='awaiting_owner',owner_user_id=p_invited_user_id,owner_invitation_id=v_inv.id,onboarding_error=null where id=v_inv.tenant_id; end if;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_inv.tenant_id,v_actor,'tenant.invitation_finalized','tenant_invitation',v_inv.id::text,jsonb_build_object('invited_user_id',p_invited_user_id,'role',v_inv.role));
  return v_inv.id;
end $$;

create or replace function public.fail_tenant_invitation(p_invitation_id uuid,p_reason text)
returns void language plpgsql security definer set search_path=public as $$
declare v_actor uuid:=auth.uid(); v_inv public.tenant_invitations%rowtype; v_is_platform boolean;
begin
  if v_actor is null then raise exception 'authentication_required'; end if;
  select * into v_inv from public.tenant_invitations where id=p_invitation_id and status='pending' for update;
  if not found then return; end if;
  v_is_platform:=public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role]);
  if not v_is_platform and v_inv.tenant_id<>public.current_tenant_id() then raise exception 'tenant_mismatch'; end if;
  if not v_is_platform and not public.is_tenant_admin(v_inv.tenant_id) and v_inv.invited_by<>v_actor then raise exception 'invitation_permission_required'; end if;
  update public.tenant_invitations set status='failed',orchestration_status='failed',failure_reason=left(coalesce(nullif(trim(p_reason),''),'unknown'),1000),updated_at=now() where id=v_inv.id;
  if v_inv.role='owner' then update public.tenants set onboarding_status='failed',onboarding_error=left(coalesce(nullif(trim(p_reason),''),'owner_invitation_failed'),1000) where id=v_inv.tenant_id and onboarding_status<>'active'; end if;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_inv.tenant_id,v_actor,'tenant.invitation_failed','tenant_invitation',v_inv.id::text,jsonb_build_object('reason',left(coalesce(p_reason,'unknown'),1000)));
end $$;

-- Compatibility for any older caller: no team_members are created here and an
-- existing active/suspended/removed member is rejected by reserve/finalize.
create or replace function public.register_tenant_invitation(
  p_tenant_id uuid,p_invited_user_id uuid,p_email text,p_role public.membership_role,
  p_team_ids uuid[] default '{}',p_message text default null,p_expires_at timestamptz default now()+interval '7 days'
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_inv uuid;
begin
  v_inv:=public.reserve_tenant_invitation(p_tenant_id,p_email,p_role,p_team_ids,p_message,p_expires_at,'legacy:'||p_invited_user_id::text||':'||lower(trim(p_email)));
  perform public.finalize_tenant_invitation(v_inv,p_invited_user_id);
  return v_inv;
end $$;

create or replace function public.activate_current_user_invitation()
returns uuid language plpgsql security definer set search_path=public,auth as $$
declare
  v_user uuid:=auth.uid(); v_email text; v_inv public.tenant_invitations%rowtype;
  v_existing public.tenant_memberships%rowtype; v_has_membership boolean:=false;
  v_team uuid; v_team_role text; v_primary uuid;
begin
  if v_user is null then return null; end if;
  select lower(coalesce(email,'')) into v_email from auth.users where id=v_user;
  select * into v_inv from public.tenant_invitations
    where status='pending' and expires_at>now() and revoked_at is null
      and (invited_user_id=v_user or lower(email::text)=v_email)
    order by created_at desc limit 1 for update;
  if not found then return null; end if;
  if v_inv.role='team_lead' and coalesce(array_length(v_inv.team_ids,1),0)=0 then raise exception 'team_lead_requires_team'; end if;

  select * into v_existing from public.tenant_memberships where tenant_id=v_inv.tenant_id and user_id=v_user for update;
  v_has_membership:=found;
  if v_has_membership and v_existing.status='active' then raise exception 'active_tenant_member_already_exists'; end if;
  if v_has_membership and v_existing.status='suspended' then raise exception 'suspended_member_requires_reactivation'; end if;
  if v_has_membership and v_existing.status='removed' then raise exception 'removed_member_requires_reactivation_workflow'; end if;
  foreach v_team in array coalesce(v_inv.team_ids,'{}'::uuid[]) loop perform public.assert_team_capacity(v_inv.tenant_id,v_team,1,v_inv.id); end loop;

  if v_has_membership then
    update public.tenant_memberships set role=v_inv.role,status='active',invited_by=coalesce(invited_by,v_inv.invited_by),
      invited_at=coalesce(invited_at,v_inv.created_at),joined_at=coalesce(joined_at,now()),deactivated_at=null,deactivated_by=null,updated_at=now()
      where tenant_id=v_inv.tenant_id and user_id=v_user;
  else
    insert into public.tenant_memberships(tenant_id,user_id,role,status,invited_by,invited_at,joined_at)
      values(v_inv.tenant_id,v_user,v_inv.role,'active',v_inv.invited_by,v_inv.created_at,now());
  end if;

  v_team_role:=case when v_inv.role in ('owner','admin','team_lead') then 'manager' else 'member' end;
  if coalesce(array_length(v_inv.team_ids,1),0)>0 then v_primary:=v_inv.team_ids[1]; end if;
  foreach v_team in array coalesce(v_inv.team_ids,'{}'::uuid[]) loop
    insert into public.team_members(tenant_id,team_id,user_id,role,is_primary,assignment_paused,joined_at,updated_at)
    values(v_inv.tenant_id,v_team,v_user,v_team_role,v_team=v_primary,false,now(),now())
    on conflict(team_id,user_id) do update set role=excluded.role,is_primary=excluded.is_primary,assignment_paused=false,updated_at=now();
  end loop;
  if v_primary is not null then
    update public.team_members set is_primary=false,updated_at=now() where tenant_id=v_inv.tenant_id and user_id=v_user and team_id<>v_primary;
    update public.tenant_memberships set primary_team_id=v_primary,updated_at=now() where tenant_id=v_inv.tenant_id and user_id=v_user;
  end if;

  update public.tenant_invitations set status='accepted',invited_user_id=v_user,orchestration_status='accepted',finalized_at=coalesce(finalized_at,now()),accepted_at=now(),updated_at=now() where id=v_inv.id;
  update public.profiles set active_tenant_id=coalesce(active_tenant_id,v_inv.tenant_id),updated_at=now() where id=v_user;
  if v_inv.role='owner' then
    update public.tenants set owner_user_id=v_user,owner_invitation_id=v_inv.id,onboarding_status='active',onboarding_completed_at=now(),onboarding_error=null where id=v_inv.tenant_id;
  end if;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_inv.tenant_id,v_user,'tenant.invitation_accepted','tenant_membership',v_user::text,jsonb_build_object('tenant_id',v_inv.tenant_id,'invitation_id',v_inv.id,'role',v_inv.role,'team_ids',v_inv.team_ids));
  return v_inv.tenant_id;
end $$;

create or replace function public.update_tenant_member_v2(
  p_user_id uuid,p_role public.membership_role,p_status public.membership_status,
  p_reassign_user_id uuid default null,p_team_ids uuid[] default '{}',p_restore_team_assignments boolean default true
) returns void language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid:=public.current_tenant_id(); v_actor uuid:=auth.uid(); v_actor_role public.membership_role:=public.current_membership_role();
  v_before public.tenant_memberships%rowtype; v_owner_count integer; v_team_ids uuid[]; v_team uuid; v_primary uuid;
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

  select coalesce(array_agg(distinct x.team_id order by x.team_id),'{}'::uuid[]) into v_team_ids
    from unnest(coalesce(p_team_ids,'{}'::uuid[])) x(team_id);
  if p_role='team_lead' and p_status='active' and coalesce(array_length(v_team_ids,1),0)=0 then raise exception 'team_lead_requires_managed_team'; end if;
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
    deactivated_at=case when p_status in ('suspended','removed') then now() else null end,
    deactivated_by=case when p_status in ('suspended','removed') then v_actor else null end,
    joined_at=case when p_status='active' then coalesce(joined_at,now()) else joined_at end,updated_at=now()
  where tenant_id=v_tenant and user_id=p_user_id;

  if p_status='active' and v_before.status='suspended' and p_restore_team_assignments then
    update public.team_members set assignment_paused=false,updated_at=now() where tenant_id=v_tenant and user_id=p_user_id;
    update public.customer_list_seller_assignments set status='active',updated_at=now() where tenant_id=v_tenant and user_id=p_user_id and status='paused';
  end if;

  if p_role='team_lead' and p_status='active' then
    update public.team_members set role='member',updated_at=now() where tenant_id=v_tenant and user_id=p_user_id and role='manager' and not (team_id=any(v_team_ids));
    if coalesce(array_length(v_team_ids,1),0)>0 then v_primary:=v_team_ids[1]; end if;
    foreach v_team in array v_team_ids loop
      perform public.assert_team_capacity(v_tenant,v_team,case when exists(select 1 from public.team_members where tenant_id=v_tenant and team_id=v_team and user_id=p_user_id) then 0 else 1 end,null);
      insert into public.team_members(tenant_id,team_id,user_id,role,is_primary,assignment_paused,joined_at,updated_at)
      values(v_tenant,v_team,p_user_id,'manager',v_team=v_primary,false,now(),now())
      on conflict(team_id,user_id) do update set role='manager',is_primary=excluded.is_primary,assignment_paused=false,updated_at=now();
    end loop;
    update public.tenant_memberships set primary_team_id=v_primary,updated_at=now() where tenant_id=v_tenant and user_id=p_user_id;
  elsif p_role not in ('owner','admin','team_lead') then
    update public.team_members set role='member',updated_at=now() where tenant_id=v_tenant and user_id=p_user_id and role='manager';
  end if;

  if p_status in ('suspended','removed') then
    update public.profiles p set active_tenant_id=(select m.tenant_id from public.tenant_memberships m join public.tenants t on t.id=m.tenant_id where m.user_id=p_user_id and m.status='active' and m.tenant_id<>v_tenant and t.status in ('trial','active') order by m.joined_at desc nulls last,m.created_at desc limit 1),updated_at=now()
      where p.id=p_user_id and p.active_tenant_id=v_tenant;
  end if;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,before_data,after_data)
  values(v_tenant,v_actor,'tenant.member_updated','tenant_membership',p_user_id::text,jsonb_build_object('role',v_before.role,'status',v_before.status),jsonb_build_object('role',p_role,'status',p_status,'managed_team_ids',v_team_ids,'restore_team_assignments',p_restore_team_assignments,'reassigned_to',p_reassign_user_id));
end $$;

create or replace function public.set_managed_team_member(
  p_team_id uuid,p_user_id uuid,p_team_role text default 'member',p_is_primary boolean default false,
  p_daily_lead_limit integer default null,p_assignment_paused boolean default false
) returns void language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_actor uuid:=auth.uid(); v_member_role public.membership_role; v_delta integer:=0;
begin
  if not public.can_manage_team(p_team_id) then raise exception 'team_manage_permission_required'; end if;
  if p_team_role not in ('manager','member') then raise exception 'invalid_team_role'; end if;
  select role into v_member_role from public.tenant_memberships where tenant_id=v_tenant and user_id=p_user_id and status='active';
  if not found then raise exception 'active_tenant_member_required'; end if;
  if not public.is_tenant_admin(v_tenant) then
    if v_member_role<>'sales' or p_team_role<>'member' then raise exception 'team_lead_can_only_manage_sellers'; end if;
  elsif p_team_role='manager' and v_member_role not in ('owner','admin','team_lead') then raise exception 'manager_membership_role_required'; end if;
  if not exists(select 1 from public.team_members where tenant_id=v_tenant and team_id=p_team_id and user_id=p_user_id) then v_delta:=1; end if;
  perform public.assert_team_capacity(v_tenant,p_team_id,v_delta,null);
  if p_is_primary then
    update public.team_members set is_primary=false,updated_at=now() where tenant_id=v_tenant and user_id=p_user_id and team_id<>p_team_id;
    update public.tenant_memberships set primary_team_id=p_team_id,updated_at=now() where tenant_id=v_tenant and user_id=p_user_id;
  end if;
  insert into public.team_members(tenant_id,team_id,user_id,role,is_primary,daily_lead_limit,assignment_paused,joined_at,updated_at)
  values(v_tenant,p_team_id,p_user_id,p_team_role,p_is_primary,p_daily_lead_limit,p_assignment_paused,now(),now())
  on conflict(team_id,user_id) do update set role=excluded.role,is_primary=excluded.is_primary,daily_lead_limit=excluded.daily_lead_limit,assignment_paused=excluded.assignment_paused,updated_at=now();
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_actor,'team.member_set','team_member',p_team_id::text||':'||p_user_id::text,jsonb_build_object('team_id',p_team_id,'user_id',p_user_id,'team_role',p_team_role,'primary',p_is_primary,'assignment_paused',p_assignment_paused));
end $$;

create or replace function public.create_platform_tenant(
  p_name text,p_legal_name text,p_organization_number text default null,p_country_code text default 'SE',
  p_timezone text default 'Europe/Stockholm',p_locale text default 'sv-SE'
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_actor uuid:=auth.uid(); v_tenant uuid; v_slug text; v_team uuid;
begin
  if not public.is_platform_role(array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role]) then raise exception 'platform_admin_required'; end if;
  if nullif(trim(coalesce(p_name,'')),'') is null or nullif(trim(coalesce(p_legal_name,'')),'') is null then raise exception 'tenant_name_required'; end if;
  v_slug:=trim(both '-' from regexp_replace(lower(trim(p_name)),'[^a-z0-9]+','-','g'))||'-'||substr(replace(gen_random_uuid()::text,'-',''),1,6);
  insert into public.tenants(slug,name,legal_name,organization_number,country_code,timezone,locale,status,onboarding_status)
  values(v_slug,trim(p_name),trim(p_legal_name),nullif(trim(coalesce(p_organization_number,'')),''),upper(p_country_code),p_timezone,p_locale,'trial','creating') returning id into v_tenant;
  perform public.ensure_tenant_defaults(v_tenant);
  insert into public.teams(tenant_id,name,is_default,code) values(v_tenant,'Huvudteam',true,'main')
    on conflict(tenant_id,name) do update set is_default=true returning id into v_team;
  update public.tenants set onboarding_status='awaiting_owner' where id=v_tenant;
  insert into public.platform_audit_logs(actor_user_id,action,entity_type,entity_id,tenant_id,reason,metadata)
  values(v_actor,'tenant.created_by_platform','tenant',v_tenant::text,v_tenant,'Skapad från plattformsadministrationen',jsonb_build_object('name',trim(p_name),'default_team_id',v_team,'onboarding_status','awaiting_owner'));
  return v_tenant;
end $$;

-- Narrow organization visibility. SECURITY DEFINER helpers above prevent policy
-- recursion while keeping seller visibility limited to own team membership.
drop policy if exists teams_tenant_select on public.teams;
drop policy if exists team_members_tenant_select on public.team_members;
drop policy if exists activities_callback_aware_select on public.activities;
drop policy if exists activities_scoped_select on public.activities;

create policy teams_role_scoped_select on public.teams for select to authenticated using(
  tenant_id=public.current_tenant_id() and (public.is_tenant_admin(tenant_id) or public.can_read_team(id))
);
create policy team_members_role_scoped_select on public.team_members for select to authenticated using(
  tenant_id=public.current_tenant_id() and (public.is_tenant_admin(tenant_id) or user_id=auth.uid() or public.can_manage_team(team_id))
);
create policy activities_role_scoped_select on public.activities for select to authenticated using(
  tenant_id=public.current_tenant_id() and (
    public.has_current_role(array['owner','admin','backoffice','quality'])
    or assigned_user_id=auth.uid() or created_by=auth.uid()
    or (assigned_team_id is not null and public.can_manage_team(assigned_team_id))
    or (customer_id is not null and public.can_access_customer(customer_id))
    or (type='callback' and callback_scope='global' and assigned_team_id is not null and public.can_operate_in_team(assigned_team_id,auth.uid()))
  )
);

revoke all on function public.assert_team_capacity(uuid,uuid,integer,uuid) from public,anon,authenticated;
revoke all on function public.can_manage_team(uuid) from public,anon;
revoke all on function public.can_operate_in_team(uuid,uuid) from public,anon;
revoke all on function public.can_read_team(uuid) from public,anon;
revoke all on function public.reserve_tenant_invitation(uuid,text,public.membership_role,uuid[],text,timestamptz,text) from public,anon;
revoke all on function public.finalize_tenant_invitation(uuid,uuid) from public,anon;
revoke all on function public.fail_tenant_invitation(uuid,text) from public,anon;
revoke all on function public.update_tenant_member_v2(uuid,public.membership_role,public.membership_status,uuid,uuid[],boolean) from public,anon;

grant execute on function public.can_manage_team(uuid) to authenticated;
grant execute on function public.can_operate_in_team(uuid,uuid) to authenticated;
grant execute on function public.can_read_team(uuid) to authenticated;
grant execute on function public.reserve_tenant_invitation(uuid,text,public.membership_role,uuid[],text,timestamptz,text) to authenticated;
grant execute on function public.finalize_tenant_invitation(uuid,uuid) to authenticated;
grant execute on function public.fail_tenant_invitation(uuid,text) to authenticated;
grant execute on function public.update_tenant_member_v2(uuid,public.membership_role,public.membership_status,uuid,uuid[],boolean) to authenticated;

commit;
