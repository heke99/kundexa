begin;

-- FAILURE-0050 — tenant-owned rows could reference another tenant's row.
--
-- Thirteen foreign keys between two tenant-owned tables were single-column: the child
-- carried `tenant_id`, but the key checked only `id` against the parent. Nothing in the
-- database stopped `rinkel_call_attempts_v2.number_allocation_id` from naming another
-- tenant's number allocation, or `legal_holds.customer_id` another tenant's customer. The
-- RPCs that write these rows do resolve every parent tenant-scoped, so this is a missing
-- backstop rather than a known leak — but the canonical rule is that a tenant boundary is
-- enforced by the schema, not only by the callers that happen to be correct today.
--
-- Every one becomes a composite key on `(tenant_id, id)`. `ON DELETE SET NULL` is written
-- column-specific so deleting a parent nulls the reference and never the mandatory
-- `tenant_id` — that exact mistake is FAILURE-0001.
--
-- `platform_rinkel_webhook_events.correlated_call_id` and `.correlated_attempt_id` are
-- deliberately excluded: that table holds platform-level events whose `tenant_id` is null
-- until correlation succeeds, so a composite key would reject the pending-correlation state
-- the reducer depends on.

-- Composite keys need `unique(tenant_id,id)` on the parent. Every table below already has
-- `id` as its primary key, so this only adds the tenant-qualified lookup.
--
-- Postgres has no `add constraint if not exists`, and a migration that cannot be re-run is a
-- trap for any environment where part of it already landed, so each add is guarded.
do $migration$
declare v_table text;
begin
  foreach v_table in array array[
    'rinkel_number_allocations','rinkel_user_allocations','rinkel_user_mappings_v2',
    'rinkel_call_attempts_v2','import_rows','provider_webhook_events'
  ] loop
    -- A unique *index* over the same columns already satisfies a composite foreign key, and
    -- some of these tables carry one from an earlier migration. Adding a constraint on top
    -- would leave two identical unique indexes on a hot table, paid for on every write.
    if not exists(
      select 1 from pg_index x join pg_class r on r.oid=x.indrelid
      join pg_namespace n on n.oid=r.relnamespace and n.nspname='public'
      where r.relname=v_table and x.indisunique and x.indimmediate
        and (select array_agg(a.attname::text order by a.attname)
             from pg_attribute a where a.attrelid=r.oid and a.attnum=any(x.indkey::int2[]))='{id,tenant_id}'
    ) then
      execute format('alter table public.%I add constraint %I unique(tenant_id,id)', v_table, v_table||'_tenant_id_key');
    end if;
  end loop;
end
$migration$;

do $migration$
declare
  v record;
  v_constraint text;
  v_violations bigint;
  v_action text;
begin
  for v in
    select * from (values
      ('call_correlation_conflicts','event_id','provider_webhook_events','set null'),
      ('customer_lists','source_platform_allocation_id','platform_list_allocations','set null'),
      ('import_change_sets','import_row_id','import_rows','set null'),
      ('import_merge_conflicts','import_row_id','import_rows','cascade'),
      ('legal_holds','customer_id','customers','cascade'),
      ('platform_list_allocation_entries','allocation_id','platform_list_allocations','cascade'),
      ('rinkel_call_attempts_v2','caller_id_allocation_id','rinkel_number_allocations','restrict'),
      ('rinkel_call_attempts_v2','mapping_id','rinkel_user_mappings_v2','restrict'),
      ('rinkel_call_attempts_v2','number_allocation_id','rinkel_number_allocations','restrict'),
      ('rinkel_call_attempts_v2','user_allocation_id','rinkel_user_allocations','restrict'),
      ('rinkel_number_grants','number_allocation_id','rinkel_number_allocations','cascade'),
      ('rinkel_user_mappings_v2','default_number_allocation_id','rinkel_number_allocations','restrict'),
      ('rinkel_user_mappings_v2','rinkel_user_allocation_id','rinkel_user_allocations','restrict')
    ) as t(child,col,parent,on_delete)
  loop
    -- A row already pointing across the tenant boundary must be reported by name rather
    -- than as a raw constraint violation, so the operator knows what to repair.
    execute format(
      'select count(*) from public.%I child join public.%I parent on parent.id=child.%I where child.%I is not null and parent.tenant_id is distinct from child.tenant_id',
      v.child, v.parent, v.col, v.col
    ) into v_violations;
    if v_violations > 0 then
      raise exception 'cross_tenant_reference_found:%.%:% rows point at another tenant''s %',
        v.child, v.col, v_violations, v.parent;
    end if;

    select con.conname into v_constraint
    from pg_constraint con
    join pg_class rel on rel.oid=con.conrelid
    join pg_namespace n on n.oid=rel.relnamespace and n.nspname='public'
    join pg_attribute att on att.attrelid=rel.oid and att.attnum=con.conkey[1]
    where con.contype='f' and rel.relname=v.child and att.attname=v.col
      and array_length(con.conkey,1)=1;
    if v_constraint is not null then
      execute format('alter table public.%I drop constraint %I', v.child, v_constraint);
    end if;

    -- Column-specific SET NULL: the reference is cleared, the mandatory tenant_id is not.
    v_action := case when v.on_delete='set null'
      then format('set null (%I)', v.col)
      else v.on_delete
    end;
    if not exists(
      select 1 from pg_constraint c join pg_class r on r.oid=c.conrelid
      join pg_namespace n on n.oid=r.relnamespace and n.nspname='public'
      where r.relname=v.child and c.conname=v.child||'_'||v.col||'_tenant_fk'
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (tenant_id,%I) references public.%I(tenant_id,id) on delete %s',
        v.child, v.child||'_'||v.col||'_tenant_fk', v.col, v.parent, v_action
      );
    end if;
  end loop;
end
$migration$;

-- A composite foreign key is checked on the child, so the referencing pair needs its own
-- index or every parent delete degrades into a sequential scan of the child.
create index if not exists call_correlation_conflicts_event_tenant_idx on public.call_correlation_conflicts(tenant_id,event_id);
create index if not exists customer_lists_source_allocation_tenant_idx on public.customer_lists(tenant_id,source_platform_allocation_id);
create index if not exists import_change_sets_row_tenant_idx on public.import_change_sets(tenant_id,import_row_id);
create index if not exists import_merge_conflicts_row_tenant_idx on public.import_merge_conflicts(tenant_id,import_row_id);
create index if not exists legal_holds_customer_tenant_idx on public.legal_holds(tenant_id,customer_id);
create index if not exists platform_list_allocation_entries_allocation_tenant_idx on public.platform_list_allocation_entries(tenant_id,allocation_id);
create index if not exists rinkel_call_attempts_v2_caller_id_allocation_tenant_idx on public.rinkel_call_attempts_v2(tenant_id,caller_id_allocation_id);
create index if not exists rinkel_call_attempts_v2_mapping_tenant_idx on public.rinkel_call_attempts_v2(tenant_id,mapping_id);
create index if not exists rinkel_call_attempts_v2_number_allocation_tenant_idx on public.rinkel_call_attempts_v2(tenant_id,number_allocation_id);
create index if not exists rinkel_call_attempts_v2_user_allocation_tenant_idx on public.rinkel_call_attempts_v2(tenant_id,user_allocation_id);
create index if not exists rinkel_number_grants_allocation_tenant_idx on public.rinkel_number_grants(tenant_id,number_allocation_id);
create index if not exists rinkel_user_mappings_v2_default_number_tenant_idx on public.rinkel_user_mappings_v2(tenant_id,default_number_allocation_id);
create index if not exists rinkel_user_mappings_v2_user_allocation_tenant_idx on public.rinkel_user_mappings_v2(tenant_id,rinkel_user_allocation_id);

commit;
