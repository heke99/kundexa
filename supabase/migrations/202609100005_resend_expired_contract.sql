begin;

-- FAILURE-0053 — an expired acceptance link killed the contract for good.
--
-- `enqueue_due_contract_reminders` expires a pending acceptance request once its deadline
-- passes and projects that onto the contract as `status='expired'`. Nothing moves a
-- contract out of that status, and `assert_contract_sendable_v2` only accepts
-- ('ready','sent','delivered','opened') — so the most ordinary case in the field, a
-- customer who did not answer in time and a seller who wants to send the same agreement
-- again, was a dead end. `extend_contract_acceptance_expiry` could not rescue it either:
-- it needs a *pending* request, and by then there is none.
--
-- The seller's only way forward was to draft the whole contract again under a new number,
-- discarding a version, a canonical PDF and a source call that were all still valid.
--
-- An expiring link is a property of the request, not a decision about the agreement.
-- Sending again is therefore allowed: `prepare_contract_delivery_v2` already supersedes
-- every earlier request, raises `acceptance_generation` and binds a fresh token, deadline
-- and document hash, so the new attempt is a clean generation and the expired one stays in
-- the audit trail. `declined` and `cancelled` remain terminal — those are decisions, and
-- reopening them has to be deliberate rather than a resend.
do $migration$
declare
  v_definition text;
  v_anchor text:=$needle$  if v_contract.status not in ('ready','sent','delivered','opened') then raise exception 'contract_not_sendable:%',v_contract.status; end if;$needle$;
begin
  select pg_get_functiondef('public.assert_contract_sendable_v2(uuid,uuid,text)'::regprocedure) into v_definition;
  if position(v_anchor in v_definition)=0 then
    -- Already patched by an earlier run: 'expired' is accepted.
    if position($already$'ready','sent','delivered','opened','expired'$already$ in v_definition)>0 then return; end if;
    raise exception 'assert_contract_sendable_status_anchor_missing';
  end if;
  v_definition:=replace(
    v_definition,
    v_anchor,
    $replacement$  if v_contract.status not in ('ready','sent','delivered','opened','expired') then raise exception 'contract_not_sendable:%',v_contract.status; end if;$replacement$
  );
  execute v_definition;
end
$migration$;

revoke all on function public.assert_contract_sendable_v2(uuid,uuid,text) from public,anon;
grant execute on function public.assert_contract_sendable_v2(uuid,uuid,text) to authenticated,service_role;

-- The expiry projection reads across every contract with an expired request. Now that a
-- contract can carry both an expired request and a live one, it must not drag a contract
-- that has just been sent again back to `expired`: only a contract whose current generation
-- has no pending request left has actually expired.
create or replace function public.expire_contracts_without_pending_acceptance()
returns integer
language plpgsql
security definer
set search_path=public
as $$
declare v_count integer;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required'; end if;
  update public.contracts c
  set status='expired'
  where c.status in ('sent','delivered','opened')
    and exists(
      select 1 from public.contract_acceptance_requests a
      where a.tenant_id=c.tenant_id and a.contract_id=c.id and a.status='expired'
        and a.generation=c.acceptance_generation
    )
    and not exists(
      select 1 from public.contract_acceptance_requests a
      where a.tenant_id=c.tenant_id and a.contract_id=c.id and a.status='pending' and a.expires_at>now()
    );
  get diagnostics v_count=row_count;
  return v_count;
end $$;
revoke all on function public.expire_contracts_without_pending_acceptance() from public,anon,authenticated;
grant execute on function public.expire_contracts_without_pending_acceptance() to service_role;

do $migration$
declare
  v_definition text;
  v_anchor text:=$needle$  update public.contracts c set status='expired' where status in ('sent','delivered','opened') and exists(select 1 from public.contract_acceptance_requests a where a.tenant_id=c.tenant_id and a.contract_id=c.id and a.status='expired');$needle$;
begin
  select pg_get_functiondef('public.enqueue_due_contract_reminders(integer)'::regprocedure) into v_definition;
  if position(v_anchor in v_definition)=0 then
    -- Already patched by an earlier run: the sweep delegates to the guarded function.
    if position('expire_contracts_without_pending_acceptance' in v_definition)>0 then return; end if;
    raise exception 'enqueue_due_contract_reminders_expiry_anchor_missing';
  end if;
  v_definition:=replace(
    v_definition,
    v_anchor,
    $replacement$  perform public.expire_contracts_without_pending_acceptance();$replacement$
  );
  execute v_definition;
end
$migration$;

revoke all on function public.enqueue_due_contract_reminders(integer) from public,anon,authenticated;
grant execute on function public.enqueue_due_contract_reminders(integer) to service_role;

commit;
