-- Plattformsadmin delar ut listor som plattformen tilldelat.
--
-- En lista från den centrala listbanken landade hos företaget som en lista
-- ingen i företaget hade valt, och bara företagets ägare kunde dela ut den.
-- Den som tilldelade listan ska också kunna dela ut den: till vilka team i
-- företaget, och om den ska vara aktiv i ringvyn. Teamledare och ägare delar
-- ut som förut med set_customer_list_sharing.
--
-- Plattformsadmin är inte medlem i företaget, så funktionerna här härleder
-- företaget och listan ur tilldelningen och korskontrollerar varje team mot
-- samma företag. Ingen tenant tas emot som parameter.
begin;

-- Läsning: listans läge och företagets team, med vilka som redan har listan.
create or replace function public.platform_list_distribution(p_allocation_id uuid)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_tenant uuid;
  v_list uuid;
  v_status text;
begin
  if not public.is_platform_role() then raise exception 'platform_admin_required'; end if;
  select a.tenant_id, a.target_list_id into v_tenant, v_list
    from public.platform_list_allocations a where a.id = p_allocation_id;
  if v_tenant is null then raise exception 'allocation_not_found'; end if;
  if v_list is null then return jsonb_build_object('listId', null, 'teams', '[]'::jsonb); end if;
  select l.status into v_status from public.customer_lists l where l.tenant_id = v_tenant and l.id = v_list;
  return jsonb_build_object(
    'listId', v_list,
    'listStatus', v_status,
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name,
        'shared', exists(select 1 from public.customer_list_team_shares s where s.tenant_id = v_tenant and s.list_id = v_list and s.team_id = t.id)
      ) order by t.name)
      from public.teams t where t.tenant_id = v_tenant and t.status = 'active'
    ), '[]'::jsonb)
  );
end $$;

-- Utdelning: ersätter listans teamdelning och sätter den aktiv eller pausad.
create or replace function public.platform_share_allocated_list(p_allocation_id uuid, p_team_ids uuid[], p_active boolean)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_user uuid := auth.uid();
  v_tenant uuid;
  v_list uuid;
  v_alloc_status text;
  v_released integer := 0;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not public.is_platform_role() then raise exception 'platform_admin_required'; end if;

  select a.tenant_id, a.target_list_id, a.status into v_tenant, v_list, v_alloc_status
    from public.platform_list_allocations a where a.id = p_allocation_id for update;
  if v_tenant is null then raise exception 'allocation_not_found'; end if;
  if v_alloc_status = 'revoked' then raise exception 'allocation_revoked'; end if;
  if v_list is null or not exists(select 1 from public.customer_lists l where l.tenant_id = v_tenant and l.id = v_list) then
    raise exception 'allocation_list_missing';
  end if;
  if exists(select 1 from unnest(coalesce(p_team_ids, '{}'::uuid[])) x(team_id)
            where not exists(select 1 from public.teams t where t.tenant_id = v_tenant and t.id = x.team_id and t.status = 'active')) then
    raise exception 'team_not_found';
  end if;

  delete from public.customer_list_team_shares s
   where s.tenant_id = v_tenant and s.list_id = v_list and not (s.team_id = any(coalesce(p_team_ids, '{}'::uuid[])));
  insert into public.customer_list_team_shares(tenant_id, list_id, team_id, created_by)
    select v_tenant, v_list, x.team_id, v_user from unnest(coalesce(p_team_ids, '{}'::uuid[])) x(team_id)
    on conflict do nothing;
  update public.customer_lists
     set status = case when p_active then 'active' when status = 'active' then 'paused' else status end, updated_at = now()
   where tenant_id = v_tenant and id = v_list;

  -- Samma regel som set_customer_list_sharing: den som tappar åtkomst släpper sitt låsta prospekt.
  with released as (
    update public.customer_list_members lm
       set state = 'pending', claimed_by = null, claim_expires_at = null, updated_at = now()
     where lm.tenant_id = v_tenant and lm.list_id = v_list and lm.state = 'claimed'
       and lm.claimed_by is not null
       and not public.list_team_access(v_list, lm.claimed_by)
       and not exists(select 1 from public.customer_list_seller_assignments a
                      where a.tenant_id = v_tenant and a.list_id = v_list and a.user_id = lm.claimed_by and a.status = 'active')
       and not exists(select 1 from public.tenant_memberships m
                      where m.tenant_id = v_tenant and m.user_id = lm.claimed_by and m.status = 'active' and m.role in ('owner','admin'))
    returning 1
  ) select count(*) into v_released from released;

  insert into public.audit_logs(tenant_id, actor_user_id, action, entity_type, entity_id, after_data)
  values(v_tenant, v_user, 'customer_list.shared_by_platform', 'customer_list', v_list::text,
    jsonb_build_object('allocation_id', p_allocation_id, 'team_ids', coalesce(p_team_ids, '{}'::uuid[]), 'active', p_active, 'released_claims', v_released));
  return jsonb_build_object('listId', v_list, 'teams', coalesce(array_length(p_team_ids, 1), 0), 'active', p_active, 'releasedClaims', v_released);
end $$;

revoke all on function public.platform_list_distribution(uuid) from public, anon;
revoke all on function public.platform_share_allocated_list(uuid, uuid[], boolean) from public, anon;
grant execute on function public.platform_list_distribution(uuid) to authenticated;
grant execute on function public.platform_share_allocated_list(uuid, uuid[], boolean) to authenticated;

commit;
