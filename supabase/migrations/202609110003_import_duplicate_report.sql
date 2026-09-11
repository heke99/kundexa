-- Say which numbers collide, not just how many.
--
-- `process_import_run` already recognises that an incoming row belongs to a
-- customer you already have. What it does then is **update** that customer, and
-- what comes back is a count — `updated: 37` — with no way to see which numbers
-- those were or what they merged into. The row that quietly overwrote a customer
-- looks exactly like the row that created one.
--
-- This reports the same collisions per row, before the import is committed, so
-- they can be reviewed rather than discovered afterwards.
--
-- It mirrors `process_import_run`'s matching exactly, including the parts that
-- are easy to get wrong:
--
--   * The keys are ranked, not OR-ed as equals. When a row carries an
--     organisation number that is the only key consulted; phone, e-mail and the
--     source's own id are used only when the organisation number is absent. A
--     report that matched on phone regardless would claim collisions the import
--     will not make.
--   * E-mail is compared lower-cased against the text of a citext column.
--   * Rows are processed when their decision is `ready` or `warning`; anything
--     else is skipped and therefore cannot collide.
--   * More than one matching customer is not a duplicate at all — the import
--     refuses it as `multiple_customer_matches` and writes a merge conflict.
--
-- A report that predicted something different from what the import then does
-- would be worse than no report, so the disagreement is what its test asserts.
--
-- `security invoker`, so the caller's own row-level security decides what is
-- visible. `import_rows` and `customers` are already scoped to the tenant and to
-- the ops roles; nothing here widens that.
create or replace function public.import_run_duplicate_report(p_import_run_id uuid)
returns table (
  import_row_number integer,
  display_name text,
  match_key text,
  match_value text,
  duplicate_of_row_number integer,
  matched_customer_id uuid,
  matched_customer_name text,
  matched_customer_count integer
)
language sql
stable
security invoker
set search_path = public
as $$
  with run as (
    select i.tenant_id, coalesce(i.source_provider, i.source_type::text) as source_provider
    from public.import_runs i
    where i.id = p_import_run_id
  ),
  candidate_rows as (
    select r.tenant_id, r.row_number, coalesce(r.normalized_data, '{}'::jsonb) as data
    from public.import_rows r
    where r.import_run_id = p_import_run_id
      -- The same gate the commit loop opens with.
      and coalesce(r.decision, '') in ('ready', 'warning')
  ),
  keyed as (
    -- One entry per row per key the import would actually consult, so the report
    -- can name the value that collided instead of only flagging the row.
    select candidate_rows.tenant_id, candidate_rows.row_number, candidate_rows.data, k.match_key, k.match_value
    from candidate_rows
    cross join lateral (
      select v.match_key, v.match_value
      from (values
        ('organization_number', nullif(candidate_rows.data->>'organization_number', '')),
        ('source_external_id', case when nullif(candidate_rows.data->>'organization_number', '') is null
           then nullif(candidate_rows.data->>'source_external_id', '') end),
        ('phone_e164', case when nullif(candidate_rows.data->>'organization_number', '') is null
           then nullif(candidate_rows.data->>'phone_e164', '') end),
        ('email', case when nullif(candidate_rows.data->>'organization_number', '') is null
           then lower(nullif(candidate_rows.data->>'email', '')) end)
      ) v(match_key, match_value)
      where v.match_value is not null
    ) k
  ),
  within_file as (
    -- The commit loop walks rows in row_number order, so the first occurrence is
    -- the one that creates the customer and every later one updates it.
    select keyed.*, min(row_number) over (partition by match_key, match_value) as first_row_number
    from keyed
  )
  select
    within_file.row_number,
    nullif(within_file.data->>'display_name', ''),
    within_file.match_key,
    within_file.match_value,
    case when within_file.first_row_number < within_file.row_number then within_file.first_row_number end,
    existing.customer_id,
    existing.customer_name,
    coalesce(existing.customer_count, 0)::integer
  from within_file
  left join lateral (
    select
      count(*)::integer as customer_count,
      (array_agg(c.id order by c.updated_at desc))[1] as customer_id,
      (array_agg(c.display_name order by c.updated_at desc))[1] as customer_name
    from public.customers c, run
    where c.tenant_id = within_file.tenant_id
      and c.deleted_at is null
      and (
        (within_file.match_key = 'organization_number' and c.organization_number = within_file.match_value)
        or (within_file.match_key = 'source_external_id'
              and c.source_provider = run.source_provider
              and c.source_external_id = within_file.match_value)
        or (within_file.match_key = 'phone_e164' and c.phone_e164 = within_file.match_value)
        or (within_file.match_key = 'email' and c.email::text = within_file.match_value)
      )
  ) existing on true
  where within_file.first_row_number < within_file.row_number
     or existing.customer_id is not null
  order by within_file.row_number, within_file.match_key;
$$;

revoke all on function public.import_run_duplicate_report(uuid) from public, anon;
grant execute on function public.import_run_duplicate_report(uuid) to authenticated, service_role;
