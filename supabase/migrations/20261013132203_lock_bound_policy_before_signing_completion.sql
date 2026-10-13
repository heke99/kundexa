begin;

-- A policy is now bound when the draft is created, before a version is locked.
-- Completion must freeze the version even when that policy is already present.
do $$
declare v text; a text;
begin
 v:=pg_get_functiondef('public.finalize_signing_envelope(uuid,uuid,jsonb)'::regprocedure);
 a:=$anchor$    v_version.signature_policy_snapshot:=v_envelope.signature_policy;
  end if;$anchor$;
 if position(a in v)=0 then raise exception 'finalize_policy_lock_anchor_missing'; end if;
 v:=replace(v,a,a||$patch$
  if v_version.locked_at is null then
    update public.contract_versions set locked_at=coalesce(locked_at,v_now)
      where tenant_id=v_contract.tenant_id and id=v_version.id;
  end if;
$patch$);
 execute v;
end $$;

commit;
