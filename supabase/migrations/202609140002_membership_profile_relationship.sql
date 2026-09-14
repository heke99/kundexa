-- `tenant_memberships.user_id` references auth.users, which PostgREST does not
-- expose. Every query that embeds `profiles:user_id(full_name)` on this table
-- therefore fails with PGRST200 "Could not find a relationship between
-- 'tenant_memberships' and 'user_id' in the schema cache" — and because
-- PostgREST reports that as an error rather than throwing, the pages rendered it
-- as no rows at all.
--
-- Measured by signing in as a seeded user and requesting every tab: the
-- "Ansvarig säljare" dropdown on /app/contracts/new came back empty, so no
-- contract could name an owner; /app/users showed memberships with no names; the
-- reassign picker on /app/callbacks and the seller names on /app/lists/[id] were
-- empty for the same reason.
--
-- `public.profiles.id` is itself `references auth.users(id) on delete cascade`,
-- so a membership row already cannot outlive its profile. Adding the second
-- reference states the relationship PostgREST needs without changing which rows
-- are legal. It is deferrable so a membership and its profile may still be
-- created in either order inside one transaction, matching
-- `tenant_memberships_primary_team_fk` in the same table.

do $$
declare v_orphans bigint;
begin
  select count(*) into v_orphans
  from public.tenant_memberships m
  where not exists (select 1 from public.profiles p where p.id = m.user_id);

  if v_orphans > 0 then
    raise exception 'cannot add membership→profile relationship: % membership row(s) have no profile', v_orphans;
  end if;
end $$;

alter table public.tenant_memberships
  drop constraint if exists tenant_memberships_user_profile_fk;

alter table public.tenant_memberships
  add constraint tenant_memberships_user_profile_fk
  foreign key (user_id) references public.profiles(id)
  on delete cascade
  deferrable initially deferred;
