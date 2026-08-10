begin;

-- Keep PL/pgSQL FOUND scoped to the statement that produced it. Capacity checks
-- and PERFORM statements also mutate FOUND, so persist the relevant state in
-- booleans before entering loops.

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
  v_has_existing_membership boolean:=false;
  v_has_invitation boolean:=false;
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
    if public.current_membership_role()<>'team_lead' or p_role<>'sales' then raise exception 'invitation_permission_required'; end if;
    if coalesce(array_length(v_team_ids,1),0)=0 then raise exception 'team_required_for_team_lead_invitation'; end if;
    if exists(
      select 1 from unnest(v_team_ids) as requested(team_id)
      where not public.can_manage_team(requested.team_id)
    ) then raise exception 'team_manage_permission_required'; end if;
    if exists(
      select 1 from public.teams t
      where t.tenant_id=p_tenant_id and t.id=any(v_team_ids) and not t.invite_sellers_enabled
    ) then raise exception 'team_seller_invitations_disabled'; end if;
  end if;

  if p_role='owner' and not v_is_platform and public.current_membership_role()<>'owner' then
    raise exception 'owner_invitation_requires_owner';
  end if;
  if p_role='team_lead' and coalesce(array_length(v_team_ids,1),0)=0 then raise exception 'team_lead_requires_team'; end if;

  if exists(
    select 1
    from unnest(v_team_ids) as requested(team_id)
    where not exists(
      select 1 from public.teams t
      where t.tenant_id=p_tenant_id and t.id=requested.team_id and t.status<>'archived'
    )
  ) then raise exception 'invitation_team_not_found'; end if;

  select m.status
    into v_existing_status
  from auth.users u
  join public.tenant_memberships m on m.user_id=u.id and m.tenant_id=p_tenant_id
  where lower(coalesce(u.email,''))=v_email
  order by m.updated_at desc
  limit 1
  for update of m;
  v_has_existing_membership:=found;

  if v_has_existing_membership and v_existing_status='active' then raise exception 'active_tenant_member_already_exists'; end if;
  if v_has_existing_membership and v_existing_status='suspended' then raise exception 'suspended_member_requires_reactivation'; end if;
  if v_has_existing_membership and v_existing_status='removed' then raise exception 'removed_member_requires_reactivation_workflow'; end if;

  select *
    into v_invitation
  from public.tenant_invitations i
  where i.tenant_id=p_tenant_id
    and lower(i.email::text)=v_email
    and i.status='pending'
  order by i.created_at desc
  limit 1
  for update;
  v_has_invitation:=found;

  foreach v_team in array v_team_ids loop
    perform public.assert_team_capacity(
      p_tenant_id,
      v_team,
      1,
      case when v_has_invitation then v_invitation.id else null end
    );
  end loop;

  if v_has_invitation then
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
    where id=v_invitation.id;
  else
    insert into public.tenant_invitations(
      tenant_id,email,role,status,invited_by,team_ids,message,expires_at,
      orchestration_status,idempotency_key
    ) values (
      p_tenant_id,v_email,p_role,'pending',v_actor,v_team_ids,
      nullif(trim(coalesce(p_message,'')),''),p_expires_at,'reserved',
      nullif(trim(coalesce(p_idempotency_key,'')),'')
    ) returning * into v_invitation;
  end if;

  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(
    p_tenant_id,v_actor,'tenant.invitation_reserved','tenant_invitation',v_invitation.id::text,
    jsonb_build_object('email',v_email,'role',p_role,'team_ids',v_team_ids)
  );

  return v_invitation.id;
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
  v_has_membership boolean:=false;
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

  if not found then return null; end if;
  if v_inv.role='team_lead' and coalesce(array_length(v_inv.team_ids,1),0)=0 then raise exception 'team_lead_requires_team'; end if;

  select * into v_existing
  from public.tenant_memberships
  where tenant_id=v_inv.tenant_id and user_id=v_user
  for update;
  v_has_membership:=found;

  if v_has_membership and v_existing.status='active' then raise exception 'active_tenant_member_already_exists'; end if;
  if v_has_membership and v_existing.status='suspended' then raise exception 'suspended_member_requires_reactivation'; end if;
  if v_has_membership and v_existing.status='removed' then raise exception 'removed_member_requires_reactivation_workflow'; end if;

  foreach v_team in array coalesce(v_inv.team_ids,'{}'::uuid[]) loop
    perform public.assert_team_capacity(v_inv.tenant_id,v_team,1,v_inv.id);
  end loop;

  if v_has_membership then
    update public.tenant_memberships
    set role=v_inv.role,
        status='active',
        invited_by=coalesce(invited_by,v_inv.invited_by),
        invited_at=coalesce(invited_at,v_inv.created_at),
        joined_at=coalesce(joined_at,now()),
        deactivated_at=null,
        deactivated_by=null,
        updated_at=now()
    where tenant_id=v_inv.tenant_id and user_id=v_user;
  else
    insert into public.tenant_memberships(
      tenant_id,user_id,role,status,invited_by,invited_at,joined_at
    ) values (
      v_inv.tenant_id,v_user,v_inv.role,'active',v_inv.invited_by,v_inv.created_at,now()
    );
  end if;

  v_team_role:=case when v_inv.role in ('owner','admin','team_lead') then 'manager' else 'member' end;
  if coalesce(array_length(v_inv.team_ids,1),0)>0 then v_primary_team:=v_inv.team_ids[1]; end if;

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
    set is_primary=false,updated_at=now()
    where tenant_id=v_inv.tenant_id and user_id=v_user and team_id<>v_primary_team;

    update public.tenant_memberships
    set primary_team_id=v_primary_team,updated_at=now()
    where tenant_id=v_inv.tenant_id and user_id=v_user;
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
  set active_tenant_id=coalesce(active_tenant_id,v_inv.tenant_id),updated_at=now()
  where id=v_user;

  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(
    v_inv.tenant_id,v_user,'tenant.invitation_accepted','tenant_membership',v_user::text,
    jsonb_build_object('tenant_id',v_inv.tenant_id,'invitation_id',v_inv.id,'role',v_inv.role,'team_ids',v_inv.team_ids)
  );

  return v_inv.tenant_id;
end $$;

commit;
