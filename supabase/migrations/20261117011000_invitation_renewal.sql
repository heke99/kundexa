begin;
-- Extend only a fully provisioned, expired invitation. This does not send email,
-- activate a membership, reset credentials or change role/team assignments.
create function public.renew_tenant_invitation(p_invitation_id uuid)
returns timestamptz language plpgsql security definer set search_path=public,private,pg_temp as $$
declare
 v_tenant uuid:=public.current_tenant_id(); v_actor uuid:=auth.uid();
 v_inv public.tenant_invitations%rowtype; v_status public.membership_status; v_expiry timestamptz; v_team uuid;
begin
 if v_tenant is null or v_actor is null then raise exception 'authentication_required'; end if;
 if not public.has_current_role(array['owner','admin']) then raise exception 'invitation_renewal_permission_required'; end if;
 select * into v_inv from public.tenant_invitations where tenant_id=v_tenant and id=p_invitation_id for update;
 if not found then raise exception 'invitation_not_found'; end if;
 if public.current_membership_role()<>'owner' and v_inv.role in ('owner','admin') then raise exception 'owner_required'; end if;
 if v_inv.status<>'pending' or v_inv.revoked_at is not null then raise exception 'pending_invitation_required'; end if;
 if v_inv.invited_user_id is null or v_inv.orchestration_status<>'finalized' then raise exception 'finalized_invitation_required'; end if;
 select status into v_status from public.tenant_memberships where tenant_id=v_tenant and user_id=v_inv.invited_user_id for update;
 if not found or v_status<>'invited' then raise exception 'invited_membership_required'; end if;
 -- A retry/double-click cannot keep pushing out an already renewed invitation.
 if v_inv.expires_at>now() then return v_inv.expires_at; end if;
 for v_team in select unnest(coalesce(v_inv.team_ids,'{}'::uuid[])) order by 1 loop
   perform public.assert_team_capacity(v_tenant,v_team,1,v_inv.id);
 end loop;
 v_expiry:=now()+interval '7 days';
 update public.tenant_invitations set expires_at=v_expiry,updated_at=now() where tenant_id=v_tenant and id=v_inv.id;
 insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,before_data,after_data)
 values(v_tenant,v_actor,'tenant.invitation_renewed','tenant_invitation',v_inv.id::text,
   jsonb_build_object('expires_at',v_inv.expires_at),jsonb_build_object('expires_at',v_expiry,'email_sent',false));
 return v_expiry;
end $$;
revoke all on function public.renew_tenant_invitation(uuid) from public,anon,service_role;
grant execute on function public.renew_tenant_invitation(uuid) to authenticated;

-- A finalized invitation belongs to its bound Auth identity. Email matching is
-- only a legacy fallback when no identity was bound; changing/reusing an email
-- must not permit another identity to take a provisioned invitation.
do $$ declare original text; revised text;
begin
 select pg_get_functiondef('public.activate_current_user_invitation()'::regprocedure) into original;
 revised:=replace(original,'(invited_user_id=v_user or lower(email::text)=v_email)',
   '(invited_user_id=v_user or (invited_user_id is null and lower(email::text)=v_email))');
 if original=revised then raise exception 'invitation_identity_guard_anchor_missing'; end if;
 execute revised;
end $$;
-- Keep the invitation projection consistent with canonical member revocation.
create function public.revoke_pending_member_invitations() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.status in ('removed','suspended') and old.status is distinct from new.status then
   update public.tenant_invitations set status='revoked',revoked_at=coalesce(revoked_at,now()),updated_at=now()
   where tenant_id=new.tenant_id and invited_user_id=new.user_id and status='pending';
 end if;
 return new;
end $$;
revoke all on function public.revoke_pending_member_invitations() from public,anon,authenticated,service_role;
create trigger membership_invitation_revocation after update of status on public.tenant_memberships
 for each row execute function public.revoke_pending_member_invitations();

do $$ declare original text; revised text;
begin
 select pg_get_functiondef('public.update_tenant_member_v3(uuid,public.membership_role,public.membership_status,uuid,uuid[],uuid,boolean)'::regprocedure) into original;
 revised:=replace(original,
   'if v_before.role=''owner'' and (p_role<>''owner'' or p_status<>''active'') then',
   'if v_before.status=''active'' and v_before.role=''owner'' and (p_role<>''owner'' or p_status<>''active'') then');
 if original=revised then raise exception 'invitation_owner_guard_anchor_missing'; end if;
 execute revised;
end $$;
commit;
