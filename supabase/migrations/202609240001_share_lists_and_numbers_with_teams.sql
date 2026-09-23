begin;

-- Listor och nummer delas med team.
--
-- Användarens modell (2026-09-23): teamledare, ägare och administratörer delar
-- en lista med ett eller flera team och/eller en kampanj. Varje säljare i de
-- teamen får listan, och när hen ringer tar hen nästa prospekt ur en gemensam
-- kö. Numren ges till företaget och delas sedan ut till team.
--
-- Tidigare kunde en lista bara höra till ett team, och även då fick bara
-- säljare som var utpekade en och en ringa den. Turvis fördelning spärrade alla
-- utom den vars tur det var, även när den säljaren inte var inloggad.

-- 1. Vilka team en lista är delad med, och vilken kampanj den hör till.
create table if not exists public.customer_list_team_shares (
  tenant_id uuid not null,
  list_id uuid not null,
  team_id uuid not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (tenant_id, list_id, team_id),
  constraint customer_list_team_shares_list_fk
    foreign key (tenant_id, list_id) references public.customer_lists(tenant_id, id) on delete cascade,
  constraint customer_list_team_shares_team_fk
    foreign key (tenant_id, team_id) references public.teams(tenant_id, id) on delete cascade
);
create index if not exists customer_list_team_shares_team_idx on public.customer_list_team_shares(tenant_id, team_id);
alter table public.customer_list_team_shares enable row level security;
revoke all on public.customer_list_team_shares from anon;
grant select on public.customer_list_team_shares to authenticated;

alter table public.customer_lists add column if not exists campaign_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'customer_lists_campaign_tenant_fk') then
    alter table public.customer_lists add constraint customer_lists_campaign_tenant_fk
      foreign key (tenant_id, campaign_id) references public.campaigns(tenant_id, id) on delete set null (campaign_id);
  end if;
end $$;

-- 2. Får den här användaren ringa listan genom ett team?
--
-- Listans eget team, ett team listan delats med, eller ett av kampanjens team.
-- Medlemskapet ska vara aktivt och inte pausat, och teamets dagliga tak för
-- nya prospekt gäller som förut.
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
    where l.id = p_list_id
      and (
        tm.team_id = l.team_id
        or exists(select 1 from public.customer_list_team_shares s
                  where s.tenant_id = l.tenant_id and s.list_id = l.id and s.team_id = tm.team_id)
        or (l.campaign_id is not null and exists(select 1 from public.campaign_teams ct
                  where ct.tenant_id = l.tenant_id and ct.campaign_id = l.campaign_id and ct.team_id = tm.team_id))
      )
      and (
        tm.daily_lead_limit is null
        or (
          select count(*) from public.customer_list_members claimed
          join public.customer_lists claimed_list on claimed_list.tenant_id = claimed.tenant_id and claimed_list.id = claimed.list_id
          where claimed.tenant_id = l.tenant_id and claimed.last_claimed_by = p_user_id
            and claimed.last_claimed_at is not null
            and (claimed.last_claimed_at at time zone l.timezone)::date = (now() at time zone l.timezone)::date
        ) < tm.daily_lead_limit
      )
  )
$$;
revoke all on function public.list_team_access(uuid, uuid) from public, anon, authenticated;

-- Teamet samtalet räknas till: det team som ger säljaren tillgång till listan,
-- listans eget först, annars säljarens primära team bland de delade.
create or replace function public.list_team_for_seller(p_list_id uuid, p_user_id uuid)
returns uuid
language sql stable security definer set search_path to 'public'
as $$
  select coalesce((
    select tm.team_id
    from public.customer_lists l
    join public.team_members tm on tm.tenant_id = l.tenant_id and tm.user_id = p_user_id and not tm.assignment_paused
    join public.teams t on t.tenant_id = tm.tenant_id and t.id = tm.team_id and t.status = 'active'
    where l.id = p_list_id
      and (
        tm.team_id = l.team_id
        or exists(select 1 from public.customer_list_team_shares s where s.tenant_id = l.tenant_id and s.list_id = l.id and s.team_id = tm.team_id)
        or (l.campaign_id is not null and exists(select 1 from public.campaign_teams ct where ct.tenant_id = l.tenant_id and ct.campaign_id = l.campaign_id and ct.team_id = tm.team_id))
      )
    order by (tm.team_id = l.team_id) desc, tm.is_primary desc, tm.team_id
    limit 1
  ), (select l.team_id from public.customer_lists l where l.id = p_list_id))
$$;
revoke all on function public.list_team_for_seller(uuid, uuid) from public, anon, authenticated;

-- 3. can_work_customer_list: den befintliga regeln, eller tillgång via team.
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

create policy customer_list_team_shares_select on public.customer_list_team_shares
  for select to authenticated
  using (tenant_id = public.current_tenant_id() and (public.can_manage_customer_list(list_id) or public.can_work_customer_list(list_id)));

-- 4. Dela en lista. Teamledare delar bara med team de leder.
create or replace function public.set_customer_list_sharing(p_list_id uuid, p_team_ids uuid[], p_campaign_id uuid)
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
  if not public.can_manage_customer_list(p_list_id) then raise exception 'list_manage_permission_required'; end if;
  v_admin := public.is_tenant_admin(v_tenant);

  if exists(select 1 from unnest(coalesce(p_team_ids, '{}'::uuid[])) x(team_id)
            where not exists(select 1 from public.teams t where t.tenant_id = v_tenant and t.id = x.team_id and t.status = 'active')) then
    raise exception 'team_not_found';
  end if;
  if not v_admin and exists(select 1 from unnest(coalesce(p_team_ids, '{}'::uuid[])) x(team_id) where not public.can_manage_team(x.team_id)) then
    raise exception 'team_share_permission_required';
  end if;
  if p_campaign_id is not null then
    if not exists(select 1 from public.campaigns c where c.tenant_id = v_tenant and c.id = p_campaign_id) then raise exception 'campaign_not_found'; end if;
    if not v_admin and exists(select 1 from public.campaign_teams ct where ct.tenant_id = v_tenant and ct.campaign_id = p_campaign_id and not public.can_manage_team(ct.team_id)) then
      raise exception 'campaign_share_permission_required';
    end if;
  end if;

  -- En teamledare tar bara bort delningar med team hen själv leder.
  delete from public.customer_list_team_shares s
   where s.tenant_id = v_tenant and s.list_id = p_list_id
     and not (s.team_id = any(coalesce(p_team_ids, '{}'::uuid[])))
     and (v_admin or public.can_manage_team(s.team_id));
  insert into public.customer_list_team_shares(tenant_id, list_id, team_id, created_by)
    select v_tenant, p_list_id, x.team_id, v_user from unnest(coalesce(p_team_ids, '{}'::uuid[])) x(team_id)
    on conflict do nothing;
  update public.customer_lists set campaign_id = p_campaign_id, updated_at = now()
   where tenant_id = v_tenant and id = p_list_id;

  -- Den som inte längre har tillgång släpper sitt låsta prospekt. Ett samtal
  -- som pågår rörs inte; det avslutas och släpps på vanligt sätt.
  with released as (
    update public.customer_list_members lm
       set state = 'pending', claimed_by = null, claim_expires_at = null, updated_at = now()
     where lm.tenant_id = v_tenant and lm.list_id = p_list_id and lm.state = 'claimed'
       and lm.claimed_by is not null
       and not public.list_team_access(p_list_id, lm.claimed_by)
       and not exists(select 1 from public.customer_list_seller_assignments a
                      where a.tenant_id = v_tenant and a.list_id = p_list_id and a.user_id = lm.claimed_by and a.status = 'active')
       and not exists(select 1 from public.tenant_memberships m
                      where m.tenant_id = v_tenant and m.user_id = lm.claimed_by and m.status = 'active' and m.role in ('owner','admin'))
    returning 1
  ) select count(*) into v_released from released;

  insert into public.audit_logs(tenant_id, actor_user_id, action, entity_type, entity_id, after_data)
  values(v_tenant, v_user, 'customer_list.shared', 'customer_list', p_list_id::text,
    jsonb_build_object('team_ids', coalesce(p_team_ids, '{}'::uuid[]), 'campaign_id', p_campaign_id, 'released_claims', v_released));
  return jsonb_build_object('teams', coalesce(array_length(p_team_ids, 1), 0), 'campaignId', p_campaign_id, 'releasedClaims', v_released);
end $$;
revoke all on function public.set_customer_list_sharing(uuid, uuid[], uuid) from public, anon;
grant execute on function public.set_customer_list_sharing(uuid, uuid[], uuid) to authenticated;

-- 5. Enskilt tilldelade säljare: pausade förblir pausade, borttagna släpper sitt.
create or replace function public.set_customer_list_sellers(p_list_id uuid, p_user_ids uuid[])
returns integer
language plpgsql security definer set search_path to 'public'
as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_team uuid; v_count integer;
begin
  if not public.can_manage_customer_list(p_list_id) then raise exception 'list_manage_permission_required'; end if;
  select team_id into v_team from public.customer_lists where tenant_id=v_tenant and id=p_list_id;
  if exists(
    select 1 from unnest(coalesce(p_user_ids,'{}'::uuid[])) x(user_id)
    where not exists(select 1 from public.tenant_memberships m where m.tenant_id=v_tenant and m.user_id=x.user_id and m.status='active' and m.role in ('sales','team_lead','admin','owner'))
      or (v_team is not null and not exists(select 1 from public.team_members tm where tm.tenant_id=v_tenant and tm.team_id=v_team and tm.user_id=x.user_id))
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

-- 6. Kön: turordning fördelar men spärrar inte, och en återkomst tar inte
--    över ett prospekt som en annan säljare har låst.
do $migration$
declare
  v_definition text;
  v_turn constant text := $a$    if v_round_robin_user is null then raise exception 'round_robin_has_no_eligible_sellers'; end if;
    if v_round_robin_user<>v_user then raise exception 'round_robin_turn_owned_by_another_seller'; end if;$a$;
  v_callback constant text := $a$      select * into v_member from public.customer_list_members where tenant_id=v_tenant and list_id=p_list_id and customer_id=v_callback.customer_id for update;
      v_callback_id:=v_callback.id;$a$;
begin
  select pg_get_functiondef('public.claim_next_list_member(uuid,uuid)'::regprocedure) into v_definition;
  if position('queue_is_shared_not_turn_based' in v_definition) > 0 then return; end if;
  if position(v_turn in v_definition) = 0 or position(v_callback in v_definition) = 0 then
    raise exception 'claim_next_list_member_anchor_missing';
  end if;
  v_definition := replace(v_definition, v_turn, $r$    -- queue_is_shared_not_turn_based: turen styr ordningen men spärrar ingen.$r$);
  v_definition := replace(v_definition, v_callback, $r$      select * into v_member from public.customer_list_members where tenant_id=v_tenant and list_id=p_list_id and customer_id=v_callback.customer_id
        and (claimed_by is null or claimed_by=v_user or claim_expires_at<now()) for update;
      if v_member.id is null and exists(select 1 from public.customer_list_members where tenant_id=v_tenant and list_id=p_list_id and customer_id=v_callback.customer_id) then
        update public.activities set status='open',claimed_by=null,claim_expires_at=null,updated_at=now() where id=v_callback.id;
      else
        v_callback_id:=v_callback.id;
      end if;$r$);
  execute v_definition;
end
$migration$;

-- 7. Samtalet räknas till rätt team och får rätt nummer.
--
-- Ett listsamtal kräver att säljaren fortfarande får ringa listan (en borttagen
-- säljare kunde ringa det prospekt hen redan låst), räknas till teamet som gav
-- tillgången, och numret tas från listan, kampanjen, teamet och sist företaget.
-- Ett manuellt samtal utan kund- eller återkomstteam räknas till säljarens
-- primära team, så att teamets nummer används.
do $migration$
declare
  v_definition text;
  v_list_team constant text := $a$  if v_list_id is not null then
    select l.team_id into v_effective_team_id from public.customer_lists l where l.tenant_id = v_tenant and l.id = v_list_id;
  else
    v_effective_team_id := coalesce(v_callback_team_id, v_customer.assigned_team_id);
  end if;$a$;
  v_resolve constant text := $a$    v_tenant, v_effective_team_id, v_list_id, v_customer.campaign_id, p_caller_id_phone_number_id$a$;
begin
  select pg_get_functiondef('public.reserve_outbound_call(uuid,uuid,text,uuid,uuid,uuid,uuid,text,text,uuid,uuid)'::regprocedure) into v_definition;
  if position('list_shared_to_teams' in v_definition) > 0 then return; end if;
  if position(v_list_team in v_definition) = 0 or position(v_resolve in v_definition) = 0 then
    raise exception 'reserve_outbound_call_anchor_missing';
  end if;
  v_definition := replace(v_definition, v_list_team, $r$  -- list_shared_to_teams
  if v_list_id is not null then
    if not public.can_work_customer_list(v_list_id) then raise exception 'list_work_permission_required'; end if;
    v_effective_team_id := public.list_team_for_seller(v_list_id, v_user);
  else
    v_effective_team_id := coalesce(v_callback_team_id, v_customer.assigned_team_id, (
      select tm.team_id from public.team_members tm join public.teams t on t.tenant_id = tm.tenant_id and t.id = tm.team_id and t.status = 'active'
      where tm.tenant_id = v_tenant and tm.user_id = v_user and not tm.assignment_paused
      order by tm.is_primary desc, tm.team_id limit 1));
  end if;$r$);
  v_definition := replace(v_definition, v_resolve, $r$    v_tenant, v_effective_team_id, v_list_id,
    coalesce((select l.campaign_id from public.customer_lists l where l.tenant_id = v_tenant and l.id = v_list_id), v_customer.campaign_id),
    p_caller_id_phone_number_id$r$);
  execute v_definition;
end
$migration$;

-- Ett nummer säljaren valt själv märks som eget val, inte som listans.
alter table public.dial_attempts drop constraint if exists dial_attempts_caller_id_source_check;
alter table public.dial_attempts add constraint dial_attempts_caller_id_source_check check (
  caller_id_source is null or caller_id_source in ('explicit','list','campaign','team','tenant_default')
);
do $migration$
declare
  v_definition text;
  v_anchor constant text := $a$select p_explicit_phone_number_id as id, 'list'::text as src, 0 as rank$a$;
begin
  select pg_get_functiondef('public.resolve_caller_id_phone_number(uuid,uuid,uuid,uuid,uuid)'::regprocedure) into v_definition;
  if position(v_anchor in v_definition) = 0 then
    if position($a$'explicit'::text as src$a$ in v_definition) > 0 then return; end if;
    raise exception 'resolve_caller_id_anchor_missing';
  end if;
  execute replace(v_definition, v_anchor, $r$select p_explicit_phone_number_id as id, 'explicit'::text as src, 0 as rank$r$);
end
$migration$;

-- 8. Teamledare delar ut företagets nummer till sina egna team.
create or replace function public.set_team_caller_id(p_team_id uuid, p_phone_number_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare v_tenant uuid := public.current_tenant_id(); v_user uuid := auth.uid();
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;
  if not public.can_manage_team(p_team_id) then raise exception 'team_manage_permission_required'; end if;
  if p_phone_number_id is not null and not exists(
    select 1 from public.phone_numbers n where n.tenant_id = v_tenant and n.id = p_phone_number_id and n.status = 'active' and n.supports_voice
  ) then raise exception 'phone_number_not_available'; end if;
  update public.teams set caller_id_phone_number_id = p_phone_number_id, updated_at = now()
   where tenant_id = v_tenant and id = p_team_id;
  insert into public.audit_logs(tenant_id, actor_user_id, action, entity_type, entity_id, after_data)
  values(v_tenant, v_user, 'telephony.caller_id_changed', 'team', p_team_id::text,
    jsonb_build_object('scope', 'team', 'scope_id', p_team_id, 'phone_number_id', p_phone_number_id));
end $$;
revoke all on function public.set_team_caller_id(uuid, uuid) from public, anon;
grant execute on function public.set_team_caller_id(uuid, uuid) to authenticated;

commit;
