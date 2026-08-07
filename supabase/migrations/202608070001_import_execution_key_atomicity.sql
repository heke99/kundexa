begin;

-- KX-010: `202608010001_production_consistency_hardening` added a BEFORE UPDATE OF status
-- trigger on `import_runs` that raises `execution_idempotency_key_required` whenever a run
-- enters `processing` without an execution idempotency key. `process_import_run` sets
-- `status='processing'` itself but never assigns that key, so every caller that does not
-- pre-claim a key out-of-band aborts. The interactive server action pre-claims one, but the
-- ParseHub automatic-commit path (`process_parsehub_import_run` -> `process_import_run`)
-- does not, and neither does any other service-role caller.
--
-- The key must therefore be assigned by the RPC itself, inside the same transaction that
-- flips the status, so the invariant holds for every caller instead of depending on each
-- one remembering to pre-claim. The value is derived deterministically from the validated
-- content fingerprint (matching the interactive path's `commit:<fingerprint>` convention)
-- and falls back to `run:<id>` when the run has no fingerprint, so a retry of the same run
-- reuses the same key and stays idempotent under the tenant-scoped unique index.
--
-- The body is patched textually from the live definition rather than restated, so the
-- customer-type projection fix applied by 202608010001 and every other delivered change
-- to this function are preserved verbatim.
do $migration$
declare
  v_definition text;
  v_anchor text:=$needle$update public.import_runs set status='processing',simulation=false,commit_approved_by=v_actor,commit_approved_at=now(),started_at=coalesce(started_at,now()),catalog_sync_status='processing' where id=p_import_run_id;$needle$;
begin
  select pg_get_functiondef('public.process_import_run(uuid)'::regprocedure) into v_definition;
  if position(v_anchor in v_definition)=0 then
    raise exception 'process_import_run_status_anchor_missing';
  end if;
  v_definition:=replace(
    v_definition,
    v_anchor,
    $replacement$update public.import_runs set status='processing',simulation=false,commit_approved_by=v_actor,commit_approved_at=now(),started_at=coalesce(started_at,now()),catalog_sync_status='processing',
    execution_idempotency_key=coalesce(
      execution_idempotency_key,
      case when nullif(validation_fingerprint,'') is not null
        then 'commit:'||validation_fingerprint
        else 'run:'||p_import_run_id::text
      end
    )
  where id=p_import_run_id;$replacement$
  );
  execute v_definition;
end
$migration$;

-- The rewrite above goes through `pg_get_functiondef`, which reproduces the original
-- ownership and volatility but not the grants, so restate the least-privilege surface.
revoke all on function public.process_import_run(uuid) from public,anon;
grant execute on function public.process_import_run(uuid) to authenticated,service_role;

commit;
