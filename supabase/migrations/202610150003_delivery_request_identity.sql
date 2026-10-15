begin;
-- Serialize API intent commitments, including concurrent requests with the
-- same caller key but different resources. A conflict rolls back the entire
-- wrapper transaction (contract changes and outbox entries included).
create or replace function public.guard_contract_api_request_identity()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_prefix text;
begin
  if new.action not in ('contract.api_created','contract.api_sent','contract.api_reminder_scheduled','contract.api_expiry_extended')
     or new.request_id !~ '^v3:[0-9a-f]{64}:[0-9a-f]{64}$' then return new; end if;
  v_prefix := left(new.request_id,68);
  perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text || ':' || new.action || ':' || v_prefix,0));
  if exists(select 1 from public.audit_logs a where a.tenant_id=new.tenant_id and a.action=new.action
    and left(a.request_id,68)=v_prefix and a.request_id<>new.request_id) then
    raise exception 'idempotency_conflict' using errcode='23505';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_contract_api_request_identity() from public,anon,authenticated;
create trigger guard_contract_api_request_identity before insert on public.audit_logs
for each row execute function public.guard_contract_api_request_identity();
commit;
