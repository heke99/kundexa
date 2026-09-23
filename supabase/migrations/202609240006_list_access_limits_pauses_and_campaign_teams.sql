begin;

-- Delade listor: dagsgräns, paus, kampanjteam, återkomster och samtalets team.
--
-- Genomgången 2026-09-23 av delningen från 202609240001:
-- - FAILURE-0107: anspråket stämplar `last_claimed_at`, och gränsen räknades
--   efter anspråket. Reservationen kontrollerar åtkomsten igen och nekade därför
--   det N:te prospektet med `list_work_permission_required`.
-- - FAILURE-0108: en pausad enskild tilldelning stoppade inte en säljare som
--   hade åtkomst via ett team, och bara listans eget team kunde tilldelas.
-- - FAILURE-0109: inget skrev `campaign_teams`, så en lista delad via en kampanj
--   nådde ingen. `set_campaign_teams` skriver den nu.
-- - FAILURE-0110: "Lägg om" krävde `compliance_status='allowed'`, ett värde som
--   ingenting skriver.
-- - FAILURE-0111: global återkomst hamnade hos listans eget team, och en
--   återkomst tagen på Återkomster-sidan syntes inte i listans kö.
-- - FAILURE-0112: samtalet räknades till kundens team, inte teamet som gav åtkomst.
-- - FAILURE-0116: en teamledare kunde koppla bort en kampanj hen inte leder.

-- 1. Åtkomst genom team.
--
-- Rollen ska vara en som ringer. Visning, ekonomi och kvalitet får inte listans
-- prospekt bara för att de sitter i ett team. En pausad enskild tilldelning
-- väger tyngre än teamet. Dagsgränsen räknar prospekt som teamet når, och det
-- prospekt säljaren håller just nu räknas inte mot nästa.
create or replace function public.list_team_access(p_list_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path to 'public'
as $$
  select exists(
    select 1
    from public.customer_lists l
    join public.team_members tm on tm.tenant_id = l.tenant_id and tm.user_id = p_user_id and not tm.assignment_paused
    join public.teams t on t.tenant_id = tm.tenant_id and t.id = tm.team_id and t.status = 'active'
    join public.tenant_memberships m on m.tenant_id = l.tenant_id and m.user_id = p_user_id and m.status = 'active'
      and m.role in ('owner','admin','team_lead','sales')
    where l.id = p_list_id
      and (
        tm.team_id = l.team_id
        or exists(select 1 from public.customer_list_team_shares s
                  where s.tenant_id = l.tenant_id and s.list_id = l.id and s.team_id = tm.team_id)
        or (l.campaign_id is not null and exists(select 1 from public.campaign_teams ct
                  where ct.tenant_id = l.tenant_id and ct.campaign_id = l.campaign_id and ct.team_id = tm.team_id))
      )
      and not exists(
        select 1 from public.customer_list_seller_assignments a
        where a.tenant_id = l.tenant_id and a.list_id = l.id and a.user_id = p_user_id and a.status = 'paused'
      )
      and (
        tm.daily_lead_limit is null
        or (
          select count(*) from public.customer_list_members claimed
          join public.customer_lists cl on cl.tenant_id = claimed.tenant_id and cl.id = claimed.list_id
          where claimed.tenant_id = l.tenant_id and claimed.last_claimed_by = p_user_id
            and claimed.last_claimed_at is not null
            and (claimed.last_claimed_at at time zone l.timezone)::date = (now() at time zone l.timezone)::date
            and not (claimed.claimed_by = p_user_id and claimed.state in ('claimed','dialing','after_call'))
            and (
              cl.team_id = tm.team_id
              or exists(select 1 from public.customer_list_team_shares s2
                        where s2.tenant_id = cl.tenant_id and s2.list_id = cl.id and s2.team_id = tm.team_id)
              or (cl.campaign_id is not null and exists(select 1 from public.campaign_teams ct2
                        where ct2.tenant_id = cl.tenant_id and ct2.campaign_id = cl.campaign_id and ct2.team_id = tm.team_id))
            )
        ) < tm.daily_lead_limit
      )
  )
$$;
revoke all on function public.list_team_access(uuid, uuid) from public, anon, authenticated;

-- 2. Samma rättelse av dagsgränsen i den enskilda tilldelningens gren.
create or replace function public.can_work_customer_list(p_list_id uuid)
returns boolean
language sql stable security definer set search_path to 'public'
as $$
  select exists(
    select 1
    from public.customer_lists l
    where l.id=p_list_id
      and l.tenant_id=public.current_tenant_id()
      and l.status='active'
      and (l.starts_at is null or l.starts_at<=now())
      and (l.ends_at is null or l.ends_at>now())
      and (
        public.list_team_access(l.id, auth.uid())
        or (
          (
            l.team_id is null
            or public.can_operate_in_team(l.team_id,auth.uid())
            or public.is_tenant_admin(l.tenant_id)
          )
          and (
            public.can_manage_customer_list(l.id)
            or exists(
              select 1
              from public.customer_list_seller_assignments a
              where a.tenant_id=l.tenant_id
                and a.list_id=l.id
                and a.user_id=auth.uid()
                and a.status='active'
                and (a.starts_at is null or a.starts_at<=now())
                and (a.ends_at is null or a.ends_at>now())
                and exists(select 1 from public.tenant_memberships m where m.tenant_id=l.tenant_id and m.user_id=a.user_id and m.status='active')
                and (
                  l.team_id is null
                  or exists(
                    select 1 from public.team_members tm
                    where tm.tenant_id=l.tenant_id and tm.team_id=l.team_id and tm.user_id=a.user_id and not tm.assignment_paused
                      and (
                        tm.daily_lead_limit is null
                        or (
                          select count(*) from public.customer_list_members claimed
                          join public.customer_lists claimed_list on claimed_list.tenant_id=claimed.tenant_id and claimed_list.id=claimed.list_id
                          where claimed.tenant_id=l.tenant_id and claimed_list.team_id=l.team_id and claimed.last_claimed_by=a.user_id
                            and claimed.last_claimed_at is not null
                            and (claimed.last_claimed_at at time zone l.timezone)::date=(now() at time zone l.timezone)::date
                            and not (claimed.claimed_by=a.user_id and claimed.state in ('claimed','dialing','after_call'))
                        ) < tm.daily_lead_limit
                      )
                  )
                )
                and (
                  a.daily_capacity is null
                  or (
                    select count(*) from public.calls c
                    where c.tenant_id=l.tenant_id and c.list_id=l.id and c.user_id=a.user_id
                      and (c.created_at at time zone l.timezone)::date=(now() at time zone l.timezone)::date
                  ) < a.daily_capacity
                )
            )
          )
        )
      )
  )
$$;

-- 3. Enskilda säljare: den som får listan genom något av dess team kan tilldelas
--    (och därmed pausas) en och en, inte bara listans eget team.
create or replace function public.set_customer_list_sellers(p_list_id uuid, p_user_ids uuid[])
returns integer
language plpgsql security definer set search_path to 'public'
as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_team uuid; v_campaign uuid; v_has_teams boolean; v_count integer;
begin
  if not public.can_manage_customer_list(p_list_id) then raise exception 'list_manage_permission_required'; end if;
  select team_id, campaign_id into v_team, v_campaign from public.customer_lists where tenant_id=v_tenant and id=p_list_id;
  v_has_teams := v_team is not null
    or exists(select 1 from public.customer_list_team_shares s where s.tenant_id=v_tenant and s.list_id=p_list_id)
    or (v_campaign is not null and exists(select 1 from public.campaign_teams ct where ct.tenant_id=v_tenant and ct.campaign_id=v_campaign));
  if exists(
    select 1 from unnest(coalesce(p_user_ids,'{}'::uuid[])) x(user_id)
    where not exists(select 1 from public.tenant_memberships m where m.tenant_id=v_tenant and m.user_id=x.user_id and m.status='active' and m.role in ('sales','team_lead','admin','owner'))
      or (v_has_teams and not exists(
        select 1 from public.team_members tm
        where tm.tenant_id=v_tenant and tm.user_id=x.user_id
          and (
            tm.team_id=v_team
            or exists(select 1 from public.customer_list_team_shares s where s.tenant_id=v_tenant and s.list_id=p_list_id and s.team_id=tm.team_id)
            or (v_campaign is not null and exists(select 1 from public.campaign_teams ct where ct.tenant_id=v_tenant and ct.campaign_id=v_campaign and ct.team_id=tm.team_id))
          )))
  ) then raise exception 'seller_not_active_in_list_team'; end if;

  -- Borttagna säljare släpper låsta prospekt och sina "egna" prospekt, så att
  -- kön inte har platser som bara en borttagen säljare kan ta.
  update public.customer_list_members lm
     set state = case when lm.state = 'claimed' then 'pending' else lm.state end,
         claimed_by = case when lm.state = 'claimed' then null else lm.claimed_by end,
         claim_expires_at = case when lm.state = 'claimed' then null else lm.claim_expires_at end,
         assigned_user_id = null, updated_at = now()
   where lm.tenant_id = v_tenant and lm.list_id = p_list_id
     and lm.state not in ('completed','blocked')
     and (lm.assigned_user_id = any(
            select a.user_id from public.customer_list_seller_assignments a
             where a.tenant_id = v_tenant and a.list_id = p_list_id and a.status <> 'ended'
               and not (a.user_id = any(coalesce(p_user_ids,'{}'::uuid[]))))
          or (lm.state = 'claimed' and lm.claimed_by = any(
            select a.user_id from public.customer_list_seller_assignments a
             where a.tenant_id = v_tenant and a.list_id = p_list_id and a.status <> 'ended'
               and not (a.user_id = any(coalesce(p_user_ids,'{}'::uuid[])))
               and not public.list_team_access(p_list_id, a.user_id))));

  update public.customer_list_seller_assignments set status='ended',ends_at=coalesce(ends_at,now()),updated_at=now()
    where tenant_id=v_tenant and list_id=p_list_id and status<>'ended'
      and not (user_id=any(coalesce(p_user_ids,'{}'::uuid[])));
  insert into public.customer_list_seller_assignments(tenant_id,list_id,user_id,created_by)
    select v_tenant,p_list_id,x.user_id,v_user from unnest(coalesce(p_user_ids,'{}'::uuid[])) x(user_id)
    on conflict(list_id,user_id) do update
      set status = case when public.customer_list_seller_assignments.status = 'paused' then 'paused' else 'active' end,
          ends_at = null, updated_at = now();
  get diagnostics v_count=row_count;
  return v_count;
end $$;

-- 4. En teamledare kopplar inte bort en kampanj vars team hen inte leder.
do $migration$
declare
  v_definition text;
  v_anchor constant text := $a$  if p_campaign_id is not null then
    if not exists(select 1 from public.campaigns c where c.tenant_id = v_tenant and c.id = p_campaign_id) then raise exception 'campaign_not_found'; end if;$a$;
begin
  select pg_get_functiondef('public.set_customer_list_sharing(uuid,uuid[],uuid)'::regprocedure) into v_definition;
  if position('old_campaign_needs_its_leader' in v_definition) > 0 then return; end if;
  if position(v_anchor in v_definition) = 0 then raise exception 'set_customer_list_sharing_anchor_missing'; end if;
  execute replace(v_definition, v_anchor, $r$  -- old_campaign_needs_its_leader
  if not v_admin and exists(
    select 1 from public.customer_lists l
    join public.campaign_teams ct on ct.tenant_id = l.tenant_id and ct.campaign_id = l.campaign_id
    where l.tenant_id = v_tenant and l.id = p_list_id
      and l.campaign_id is distinct from p_campaign_id
      and not public.can_manage_team(ct.team_id)
  ) then raise exception 'campaign_share_permission_required'; end if;
$r$ || v_anchor);
end
$migration$;

-- 4b. En delning med ett team som pausats ligger kvar när listan sparas.
--     Formuläret skickar med den, och RPC:n godtar ett team som inte är aktivt
--     just om listan redan är delad med det. Nya delningar kräver fortfarande
--     ett aktivt team.
do $migration$
declare
  v_definition text;
  v_anchor constant text := $a$            where not exists(select 1 from public.teams t where t.tenant_id = v_tenant and t.id = x.team_id and t.status = 'active')) then
    raise exception 'team_not_found';$a$;
begin
  select pg_get_functiondef('public.set_customer_list_sharing(uuid,uuid[],uuid)'::regprocedure) into v_definition;
  if position('paused_team_share_kept' in v_definition) > 0 then return; end if;
  if position(v_anchor in v_definition) = 0 then raise exception 'set_customer_list_sharing_team_anchor_missing'; end if;
  execute replace(v_definition, v_anchor, $r$            -- paused_team_share_kept
            where not exists(select 1 from public.teams t where t.tenant_id = v_tenant and t.id = x.team_id and t.status = 'active')
              and not exists(select 1 from public.customer_list_team_shares s
                             where s.tenant_id = v_tenant and s.list_id = p_list_id and s.team_id = x.team_id)) then
    raise exception 'team_not_found';$r$);
end
$migration$;

-- 5. Kampanjens team. Admin väljer fritt; en teamledare lägger till och tar
--    bort bara team hen leder. Den som tappar åtkomsten släpper låsta prospekt.
create or replace function public.set_campaign_teams(p_campaign_id uuid, p_team_ids uuid[])
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_admin boolean;
  v_released integer := 0;
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;
  if not exists(select 1 from public.campaigns c where c.tenant_id = v_tenant and c.id = p_campaign_id) then
    raise exception 'campaign_not_found';
  end if;
  v_admin := public.is_tenant_admin(v_tenant);
  if not v_admin and not public.has_current_role(array['team_lead']) then raise exception 'campaign_team_permission_required'; end if;
  if exists(select 1 from unnest(coalesce(p_team_ids, '{}'::uuid[])) x(team_id)
            where not exists(select 1 from public.teams t where t.tenant_id = v_tenant and t.id = x.team_id and t.status = 'active')) then
    raise exception 'team_not_found';
  end if;
  if not v_admin and exists(select 1 from unnest(coalesce(p_team_ids, '{}'::uuid[])) x(team_id) where not public.can_manage_team(x.team_id)) then
    raise exception 'campaign_team_permission_required';
  end if;

  delete from public.campaign_teams ct
   where ct.tenant_id = v_tenant and ct.campaign_id = p_campaign_id
     and not (ct.team_id = any(coalesce(p_team_ids, '{}'::uuid[])))
     and (v_admin or public.can_manage_team(ct.team_id));
  insert into public.campaign_teams(tenant_id, campaign_id, team_id)
    select v_tenant, p_campaign_id, x.team_id from unnest(coalesce(p_team_ids, '{}'::uuid[])) x(team_id)
    on conflict do nothing;

  with released as (
    update public.customer_list_members lm
       set state = 'pending', claimed_by = null, claim_expires_at = null, updated_at = now()
      from public.customer_lists l
     where l.tenant_id = v_tenant and l.campaign_id = p_campaign_id
       and lm.tenant_id = l.tenant_id and lm.list_id = l.id and lm.state = 'claimed'
       and lm.claimed_by is not null
       and not public.list_team_access(l.id, lm.claimed_by)
       and not exists(select 1 from public.customer_list_seller_assignments a
                      where a.tenant_id = v_tenant and a.list_id = l.id and a.user_id = lm.claimed_by and a.status = 'active')
       and not exists(select 1 from public.tenant_memberships m
                      where m.tenant_id = v_tenant and m.user_id = lm.claimed_by and m.status = 'active' and m.role in ('owner','admin'))
    returning 1
  ) select count(*) into v_released from released;

  insert into public.audit_logs(tenant_id, actor_user_id, action, entity_type, entity_id, after_data)
  values(v_tenant, v_user, 'campaign.teams_set', 'campaign', p_campaign_id::text,
    jsonb_build_object('team_ids', coalesce(p_team_ids, '{}'::uuid[]), 'released_claims', v_released));
  return jsonb_build_object('teams', coalesce(array_length(p_team_ids, 1), 0), 'releasedClaims', v_released);
end $$;
revoke all on function public.set_campaign_teams(uuid, uuid[]) from public, anon;
grant execute on function public.set_campaign_teams(uuid, uuid[]) to authenticated;

-- 6. "Lägg om" köar det som inte är spärrat. Samtalet prövas ändå mot
--    kontaktpolicyn vid reservationen, precis som för varje annat prospekt.
do $migration$
declare
  v_definition text;
  v_old constant text := $a$m.compliance_status = 'allowed'$a$;
  v_new constant text := $a$m.compliance_status not in ('blocked','pending_nix','manual_review')$a$;
  v_fn text;
begin
  foreach v_fn in array array['public.requeue_customer_list_members','public.customer_list_requeue_candidates'] loop
    select pg_get_functiondef(p.oid) into v_definition
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname || '.' || p.proname = v_fn;
    if v_definition is null then raise exception 'requeue_function_missing:%', v_fn; end if;
    if position(v_new in v_definition) > 0 then continue; end if;
    if position(v_old in v_definition) = 0 then raise exception 'requeue_anchor_missing:%', v_fn; end if;
    execute replace(v_definition, v_old, v_new);
  end loop;
end
$migration$;

-- 7. En global återkomst går till teamet som gav säljaren åtkomst till listan.
do $migration$
declare
  v_definition text;
  v_anchor constant text := $a$    v_team:=v_list.team_id;$a$;
begin
  select pg_get_functiondef('public.complete_dialer_work(uuid,text,text,text,timestamptz,boolean,uuid,numeric,numeric,text)'::regprocedure) into v_definition;
  if position('callback_team_that_gave_access' in v_definition) > 0 then return; end if;
  if position(v_anchor in v_definition) = 0 then raise exception 'complete_dialer_work_callback_anchor_missing'; end if;
  execute replace(v_definition, v_anchor, $r$    -- callback_team_that_gave_access
    v_team:=public.list_team_for_seller(v_call.list_id, v_user);$r$);
end
$migration$;

-- 8. Kön tar först säljarens egen återkomst som hen tagit på Återkomster-sidan.
do $migration$
declare
  v_definition text;
  v_anchor constant text := $a$    where a.tenant_id=v_tenant and a.list_id=p_list_id and a.type='callback' and a.status='open' and coalesce(a.snoozed_until,a.due_at)<=now()
      and (a.assigned_user_id=v_user or (a.callback_scope='global' and (a.assigned_team_id is null or public.can_operate_in_team(a.assigned_team_id,v_user))))
    order by coalesce(a.snoozed_until,a.due_at),a.created_at for update skip locked limit 1;$a$;
begin
  select pg_get_functiondef('public.claim_next_list_member(uuid,uuid)'::regprocedure) into v_definition;
  if position('own_claimed_callback_first' in v_definition) > 0 then return; end if;
  if position(v_anchor in v_definition) = 0 then raise exception 'claim_next_list_member_callback_anchor_missing'; end if;
  execute replace(v_definition, v_anchor, $r$    -- own_claimed_callback_first
    where a.tenant_id=v_tenant and a.list_id=p_list_id and a.type='callback'
      and (
        (a.status='in_progress' and a.claimed_by=v_user and a.claim_expires_at>now())
        or (a.status='open' and coalesce(a.snoozed_until,a.due_at)<=now()
          and (a.assigned_user_id=v_user or (a.callback_scope='global' and (a.assigned_team_id is null or public.can_operate_in_team(a.assigned_team_id,v_user)))))
      )
    order by (a.status='in_progress') desc, coalesce(a.snoozed_until,a.due_at),a.created_at for update skip locked limit 1;$r$);
end
$migration$;

-- 9. Samtalet räknas till teamet som gav åtkomsten, samma team som valde numret.
do $migration$
declare
  v_definition text;
  v_anchor constant text := $a$    v_tenant, 'sinch', p_customer_id, p_contact_person_id, v_user, v_customer.assigned_team_id, 'outbound',$a$;
begin
  select pg_get_functiondef('public.reserve_outbound_call(uuid,uuid,text,uuid,uuid,uuid,uuid,text,text,uuid,uuid)'::regprocedure) into v_definition;
  if position('call_counts_to_access_team' in v_definition) > 0 then return; end if;
  if position(v_anchor in v_definition) = 0 then raise exception 'reserve_outbound_call_team_anchor_missing'; end if;
  execute replace(v_definition, v_anchor, $r$    -- call_counts_to_access_team
    v_tenant, 'sinch', p_customer_id, p_contact_person_id, v_user, coalesce(v_effective_team_id, v_customer.assigned_team_id), 'outbound',$r$);
end
$migration$;

commit;
