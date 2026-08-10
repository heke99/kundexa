begin;

-- Restore the team-member daily lead cap in the canonical list permission check.
-- Migration 202608100005 added assignment-level daily_capacity and stronger
-- active-team checks, but unintentionally stopped enforcing team_members.daily_lead_limit.
-- Keep both limits authoritative in the database.
create or replace function public.can_work_customer_list(p_list_id uuid)
returns boolean
language sql
stable
security definer
set search_path=public
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
            and exists(
              select 1
              from public.tenant_memberships m
              where m.tenant_id=l.tenant_id
                and m.user_id=a.user_id
                and m.status='active'
            )
            and (
              l.team_id is null
              or exists(
                select 1
                from public.team_members tm
                where tm.tenant_id=l.tenant_id
                  and tm.team_id=l.team_id
                  and tm.user_id=a.user_id
                  and not tm.assignment_paused
                  and (
                    tm.daily_lead_limit is null
                    or (
                      select count(*)
                      from public.customer_list_members claimed
                      join public.customer_lists claimed_list
                        on claimed_list.tenant_id=claimed.tenant_id
                       and claimed_list.id=claimed.list_id
                      where claimed.tenant_id=l.tenant_id
                        and claimed_list.team_id=l.team_id
                        and claimed.last_claimed_by=a.user_id
                        and claimed.last_claimed_at is not null
                        and (claimed.last_claimed_at at time zone l.timezone)::date
                          =(now() at time zone l.timezone)::date
                    ) < tm.daily_lead_limit
                  )
              )
            )
            and (
              a.daily_capacity is null
              or (
                select count(*)
                from public.calls c
                where c.tenant_id=l.tenant_id
                  and c.list_id=l.id
                  and c.user_id=a.user_id
                  and (c.created_at at time zone l.timezone)::date
                    =(now() at time zone l.timezone)::date
              ) < a.daily_capacity
            )
        )
      )
  )
$$;

comment on function public.can_work_customer_list(uuid) is
  'Canonical list/dialer authorization. Enforces active tenant/team membership, assignment windows, assignment daily_capacity and team_members.daily_lead_limit.';

commit;
