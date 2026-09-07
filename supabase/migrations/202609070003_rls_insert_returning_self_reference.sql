-- Creating a customer or a contract was impossible from the application.
--
-- `customers_scoped_select` guarded reads with `can_access_customer(id)`, and
-- `can_access_customer` establishes access by selecting the row back out of
-- `public.customers`. `contracts_scoped_select` and `can_access_contract` had the
-- same shape.
--
-- PostgreSQL applies SELECT policies to `INSERT ... RETURNING`, and a STABLE
-- function evaluates against the statement's snapshot, in which the row being
-- inserted does not yet exist. The lookup inside the policy function therefore
-- returned no row, `exists(...)` was false, and the insert failed with
--   new row violates row-level security policy for table "customers"
-- even though the inserting user was the tenant owner, the creator and the
-- assignee. The insert alone succeeded; only the RETURNING clause failed, and
-- every application write goes through PostgREST's `.insert().select()`, which
-- always adds RETURNING.
--
-- The fix removes the self-reference: the policies now evaluate the candidate
-- row's own columns, which are available to the check without a lookup. The
-- authorization rules are unchanged, and the `_row` helpers are the single
-- definition that both the policies and the id-based functions use, so the two
-- forms cannot drift apart.

create or replace function public.can_access_customer_row(
  p_customer_id uuid,
  p_tenant_id uuid,
  p_assigned_user_id uuid,
  p_created_by uuid,
  p_assigned_team_id uuid
) returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists(
    select 1
    from public.tenant_memberships m
    where m.tenant_id=p_tenant_id
      and m.user_id=auth.uid()
      and m.status='active'
      and p_tenant_id=public.current_tenant_id()
      and (
        m.role in ('owner','admin','backoffice','quality','contract_manager','finance','viewer')
        or p_assigned_user_id=auth.uid()
        or p_created_by=auth.uid()
        or (p_assigned_team_id is not null and public.can_operate_in_team(p_assigned_team_id,auth.uid()))
        or exists(
          select 1 from public.customer_list_members lm
          where lm.tenant_id=p_tenant_id
            and lm.customer_id=p_customer_id
            and public.can_work_customer_list(lm.list_id)
        )
      )
  )
$$;
revoke all on function public.can_access_customer_row(uuid,uuid,uuid,uuid,uuid) from public,anon;
grant execute on function public.can_access_customer_row(uuid,uuid,uuid,uuid,uuid) to authenticated,service_role;

-- Keep the id-based form for the many policies that reference a customer from
-- another table, where the row already exists. It now delegates so there is one
-- authorization definition.
create or replace function public.can_access_customer(p_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists(
    select 1 from public.customers c
    where c.id=p_customer_id
      and public.can_access_customer_row(c.id,c.tenant_id,c.assigned_user_id,c.created_by,c.assigned_team_id)
  )
$$;

drop policy if exists customers_scoped_select on public.customers;
create policy customers_scoped_select on public.customers
  for select to authenticated
  using (public.can_access_customer_row(id,tenant_id,assigned_user_id,created_by,assigned_team_id));

-- The UPDATE check had the same self-reference in its WITH CHECK clause, which
-- broke moving a customer between sellers via `.update().select()`.
drop policy if exists customers_scoped_update on public.customers;
create policy customers_scoped_update on public.customers
  for update to authenticated
  using (public.can_access_customer_row(id,tenant_id,assigned_user_id,created_by,assigned_team_id))
  with check (
    tenant_id=public.current_tenant_id()
    and public.can_access_customer_row(id,tenant_id,assigned_user_id,created_by,assigned_team_id)
  );

create or replace function public.can_access_contract_row(
  p_tenant_id uuid,
  p_owner_user_id uuid,
  p_customer_id uuid
) returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_tenant_id=public.current_tenant_id()
    and public.has_current_role(array['owner','admin','team_lead','sales','contract_manager','quality','backoffice','finance','viewer'])
    and (
      public.has_current_role(array['owner','admin','contract_manager','quality','finance'])
      or p_owner_user_id=auth.uid()
      or public.can_access_customer(p_customer_id)
    )
$$;
revoke all on function public.can_access_contract_row(uuid,uuid,uuid) from public,anon;
grant execute on function public.can_access_contract_row(uuid,uuid,uuid) to authenticated,service_role;

create or replace function public.can_access_contract(p_contract_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists(
    select 1 from public.contracts c
    where c.id=p_contract_id
      and public.can_access_contract_row(c.tenant_id,c.owner_user_id,c.customer_id)
  )
$$;

drop policy if exists contracts_scoped_select on public.contracts;
create policy contracts_scoped_select on public.contracts
  for select to authenticated
  using (public.can_access_contract_row(tenant_id,owner_user_id,customer_id));
