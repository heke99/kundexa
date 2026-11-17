begin;
create function private.user_requires_mfa() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select auth.uid() is not null and (
   exists(select 1 from public.tenant_memberships where user_id=auth.uid() and status='active' and role in ('owner','admin'))
   or exists(select 1 from public.platform_memberships where user_id=auth.uid() and status='active'))
$$;
create function private.mfa_session_allowed() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(auth.role()='service_role',false) or (auth.uid() is not null and (not private.user_requires_mfa() or coalesce(auth.jwt()->>'aal','')='aal2'))
$$;
revoke all on function private.user_requires_mfa(),private.mfa_session_allowed() from public,anon,authenticated;
grant execute on function private.mfa_session_allowed() to authenticated;
create function public.current_user_mfa_required() returns boolean language sql stable security definer set search_path=public,pg_temp as $$select private.user_requires_mfa()$$;
revoke all on function public.current_user_mfa_required() from public,anon;
grant execute on function public.current_user_mfa_required() to authenticated;
create or replace function private.tenant_context_before_mfa()
returns uuid
language sql
stable
security definer
set search_path=public,pg_temp
as $$
  select coalesce(
    (
      select t.id
      from public.tenants t
      join public.tenant_memberships m
        on m.tenant_id=t.id and m.user_id=auth.uid() and m.status='active'
      where t.id=nullif(current_setting('app.kundexa_tenant_id',true),'')::uuid
        and t.status in ('trial','active')
    ),
    (
      select p.active_tenant_id
      from public.profiles p
      join public.tenant_memberships m
        on m.tenant_id=p.active_tenant_id and m.user_id=p.id and m.status='active'
      join public.tenants t on t.id=p.active_tenant_id and t.status in ('trial','active')
      where p.id=auth.uid()
    )
  )
$$;
revoke all on function private.tenant_context_before_mfa() from public,anon,authenticated;
create or replace function public.current_tenant_id() returns uuid language sql stable security definer set search_path=public,pg_temp as $$
 select case when private.mfa_session_allowed() then private.tenant_context_before_mfa() else null end
$$;
create or replace function public.is_tenant_member(p_tenant_id uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select private.mfa_session_allowed() and exists(select 1 from public.tenant_memberships where tenant_id=p_tenant_id and user_id=auth.uid() and status='active')
$$;
create or replace function public.is_tenant_admin(p_tenant_id uuid default public.current_tenant_id()) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select private.mfa_session_allowed() and exists(select 1 from public.tenant_memberships where tenant_id=p_tenant_id and user_id=auth.uid() and status='active' and role in ('owner','admin'))
$$;
create or replace function public.is_platform_role(p_roles public.platform_role[] default array['platform_owner'::public.platform_role,'platform_admin'::public.platform_role]) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select private.mfa_session_allowed() and exists(select 1 from public.platform_memberships where user_id=auth.uid() and status='active' and (p_roles is null or role=any(p_roles)))
$$;
-- Restrictive AND guard prevents an old permissive policy from bypassing MFA.
-- Do not apply to auth schema: enrolment/challenge remains possible at AAL1.
do $$ declare t record; begin
 for t in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity loop
   execute format('create policy mfa_session_guard on public.%I as restrictive for all to authenticated using ((select private.mfa_session_allowed())) with check ((select private.mfa_session_allowed()))',t.relname);
 end loop;
end $$;
commit;
