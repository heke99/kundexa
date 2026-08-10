-- The primary-team relationship is completed atomically by membership/team orchestration.
-- Keep the FK strict at transaction commit while allowing either side to be written first
-- inside the same transaction.
alter table public.tenant_memberships
  alter constraint tenant_memberships_primary_team_fk
  deferrable initially deferred;
