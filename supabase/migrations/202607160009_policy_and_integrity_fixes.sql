begin;

-- Authenticated application transactions may enqueue work, but may never mutate
-- or complete jobs. Service-role workers own the remaining lifecycle.
create policy outbox_member_insert on public.outbox_jobs
for insert to authenticated
with check (
  tenant_id = public.current_tenant_id()
  and public.is_tenant_member(tenant_id)
  and status = 'pending'
  and attempts = 0
);

-- Business actions can append audit evidence for the current user. Audit rows
-- are immutable to browser clients and remain readable only to tenant admins.
create policy audit_member_insert on public.audit_logs
for insert to authenticated
with check (
  tenant_id = public.current_tenant_id()
  and public.is_tenant_member(tenant_id)
  and actor_user_id = auth.uid()
);

-- A normal seller sees assigned customers only. Team leads see their teams.
-- Operational and audit roles retain tenant-wide read access according to role.
create or replace function public.can_access_customer(p_customer_id uuid)
returns boolean
language sql stable security definer set search_path=public
as $$
  select exists (
    select 1
    from public.customers c
    join public.tenant_memberships m
      on m.tenant_id = c.tenant_id
     and m.user_id = auth.uid()
     and m.status = 'active'
    where c.id = p_customer_id
      and c.tenant_id = public.current_tenant_id()
      and (
        m.role in ('owner','admin','backoffice','quality','contract_manager','finance','viewer')
        or c.assigned_user_id = auth.uid()
        or c.created_by = auth.uid()
        or (
          c.assigned_team_id is not null
          and exists (
            select 1 from public.team_members tm
            where tm.tenant_id = c.tenant_id
              and tm.team_id = c.assigned_team_id
              and tm.user_id = auth.uid()
          )
        )
      )
  )
$$;

-- Replace the broad customer policies created in migration 005.
drop policy if exists customers_tenant_select on public.customers;
drop policy if exists customers_tenant_update on public.customers;
drop policy if exists customers_tenant_delete on public.customers;

create policy customers_scoped_select on public.customers
for select to authenticated
using (public.can_access_customer(id));

create policy customers_scoped_update on public.customers
for update to authenticated
using (public.can_access_customer(id))
with check (
  tenant_id = public.current_tenant_id()
  and public.can_access_customer(id)
);

create policy customers_admin_delete on public.customers
for delete to authenticated
using (tenant_id = public.current_tenant_id() and public.is_tenant_admin(tenant_id));

-- Provider identifiers may be null while queued. Regular UNIQUE semantics allow
-- multiple null values and still reject duplicate non-null provider ids.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid='public.sms_messages'::regclass
      and conname='sms_messages_tenant_id_provider_message_id_key'
  ) then
    null;
  end if;
end $$;

-- Prevent tenant-crossing links on the highest-risk communication and contract chains.
create unique index if not exists customers_tenant_id_id_uidx on public.customers(tenant_id,id);
create unique index if not exists contracts_tenant_id_id_uidx on public.contracts(tenant_id,id);
create unique index if not exists contract_versions_tenant_id_id_uidx on public.contract_versions(tenant_id,id);
create unique index if not exists phone_numbers_tenant_id_id_uidx on public.phone_numbers(tenant_id,id);

alter table public.calls drop constraint if exists calls_customer_tenant_fk;
alter table public.calls add constraint calls_customer_tenant_fk
  foreign key (tenant_id,customer_id) references public.customers(tenant_id,id) on delete restrict;

alter table public.sms_messages drop constraint if exists sms_messages_customer_tenant_fk;
alter table public.sms_messages add constraint sms_messages_customer_tenant_fk
  foreign key (tenant_id,customer_id) references public.customers(tenant_id,id) on delete restrict;

alter table public.contract_versions drop constraint if exists contract_versions_contract_tenant_fk;
alter table public.contract_versions add constraint contract_versions_contract_tenant_fk
  foreign key (tenant_id,contract_id) references public.contracts(tenant_id,id) on delete cascade;

alter table public.contract_documents drop constraint if exists contract_documents_contract_tenant_fk;
alter table public.contract_documents add constraint contract_documents_contract_tenant_fk
  foreign key (tenant_id,contract_id) references public.contracts(tenant_id,id) on delete cascade;

commit;
