-- Nine table pairs carry two identical foreign keys on the same columns. Postgres
-- accepts that, but PostgREST cannot: asked to embed one table in the other it
-- finds two candidate relationships, refuses with PGRST201 "Could not embed
-- because more than one relationship was found", and returns an error instead of
-- rows.
--
-- Every page that embeds across one of these pairs was therefore broken. Because
-- PostgREST reports it as an error rather than throwing, and the pages read only
-- `data`, the failure rendered as an empty table — "Inga poster" on a tab that
-- should have shown the rows. Measured by signing in as a real seeded user and
-- requesting every tab: /app/calls, /app/sms, /app/email, /app/contracts,
-- /app/documents and the customer and contract detail cards all failed on this.
--
-- In each pair the `*_tenant_fk` constraint is identical to, or stricter than,
-- the auto-named `*_tenant_id_*_id_fkey` one:
--
--   activities → contracts          both ON DELETE CASCADE
--   activities → deals              both ON DELETE CASCADE
--   contract_documents → contracts  both ON DELETE CASCADE
--   contract_versions → contracts   both ON DELETE CASCADE
--   calls → customers               RESTRICT  vs  NO ACTION
--   email_messages → contracts      RESTRICT  vs  NO ACTION
--   email_messages → customers      RESTRICT  vs  NO ACTION
--   sms_messages → contracts        RESTRICT  vs  NO ACTION
--   sms_messages → customers        RESTRICT  vs  NO ACTION
--
-- So dropping the auto-named one never permits a delete that was refused before:
-- where the two differ, the surviving constraint is the stricter one.

alter table public.activities drop constraint if exists activities_tenant_id_contract_id_fkey;
alter table public.activities drop constraint if exists activities_tenant_id_deal_id_fkey;
alter table public.calls drop constraint if exists calls_tenant_id_customer_id_fkey;
alter table public.contract_documents drop constraint if exists contract_documents_tenant_id_contract_id_fkey;
alter table public.contract_versions drop constraint if exists contract_versions_tenant_id_contract_id_fkey;
alter table public.email_messages drop constraint if exists email_messages_tenant_id_contract_id_fkey;
alter table public.email_messages drop constraint if exists email_messages_tenant_id_customer_id_fkey;
alter table public.sms_messages drop constraint if exists sms_messages_tenant_id_contract_id_fkey;
alter table public.sms_messages drop constraint if exists sms_messages_tenant_id_customer_id_fkey;

-- Fail loudly if any pair is still ambiguous rather than leaving a tab that
-- renders emptiness for the next person to rediscover.
do $$
declare v_remaining text;
begin
  select string_agg(format('%s -> %s', from_table, to_table), ', ')
  into v_remaining
  from (
    select c.conrelid::regclass::text as from_table,
           c.confrelid::regclass::text as to_table,
           regexp_replace(pg_get_constraintdef(c.oid), ' ON DELETE.*$', '') as cols
    from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace
    where c.contype = 'f' and n.nspname = 'public'
  ) fks
  group by from_table, to_table, cols
  having count(*) > 1;

  if v_remaining is not null then
    raise exception 'duplicate foreign keys still present, PostgREST embeds will fail: %', v_remaining;
  end if;
end $$;
