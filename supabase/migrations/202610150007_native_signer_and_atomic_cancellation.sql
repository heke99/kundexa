begin;
-- The legal counterparty/recipient remains locked to the source PDF. A drawn
-- signature records the actual human's supplied name separately, with low
-- assurance; it does not turn an organisation name into an authenticated person.
do $$ declare definition text; begin
  select pg_get_functiondef('public.claim_native_signature(jsonb)'::regprocedure) into definition;
  if position($marker$or trim(p_input->>'signer_name') is distinct from e.provider_evidence->>'recipient_name'$marker$ in definition)=0 then
    raise exception 'native_signer_policy_patch_failed';
  end if;
  definition:=replace(definition,
    $old$or trim(p_input->>'signer_name') is distinct from e.provider_evidence->>'recipient_name'$old$,
    $new$or jsonb_typeof(p_input->'signer_name') is distinct from 'string'
    or length(coalesce(trim(p_input->>'signer_name'),'')) not between 2 and 200
    or (p_input->>'signer_name') ~ '[[:cntrl:]]'$new$);
  -- Old in-flight receipts keep their exact original hash on replay. Newly
  -- claimed receipts bind both the locked recipient and the actual signer.
  definition:=replace(definition,
    $old$  payload_hash:=encode(digest(payload::text,'sha256'),'hex');
  receipt:=e.provider_evidence->'native_signature';$old$,
    $new$  receipt:=e.provider_evidence->'native_signature';
  if receipt is null or receipt ? 'recipient_name' then
    payload:=payload||jsonb_build_object('recipient_name',e.provider_evidence->>'recipient_name',
      'recipient_email',e.provider_evidence->>'email');
  end if;
  payload_hash:=encode(digest(payload::text,'sha256'),'hex');$new$);
  definition:=replace(definition,
    $old$verified_identity=jsonb_build_object('recipient_name',receipt->>'signer_name','identity_assurance_level','low','receipt_id',receipt->>'receipt_id')$old$,
    $new$verified_identity=jsonb_build_object('signer_name',receipt->>'signer_name','recipient_name',receipt->>'recipient_name',
      'recipient_email',receipt->>'recipient_email','identity_assurance_level','low','receipt_id',receipt->>'receipt_id')$new$);
  if position($marker$'recipient_email',e.provider_evidence->>'email'$marker$ in definition)=0 then raise exception 'native_signer_receipt_patch_failed'; end if;
  execute definition;
end $$;

create or replace function public.cancel_native_signing(p_input jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare
  tenant uuid:=(p_input->>'tenant_id')::uuid;
  actor uuid:=(p_input->>'actor_id')::uuid;
  e public.signing_envelopes%rowtype; c public.contracts%rowtype;
  restored integer:=0; replay boolean;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_required'; end if;
  if not exists(select 1 from public.tenant_memberships m join public.tenants t on t.id=m.tenant_id
    where m.tenant_id=tenant and m.user_id=actor and m.status='active' and t.status in ('trial','active'))
    then raise exception 'active_membership_required'; end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('app.kundexa_tenant_id',tenant::text,true);
  if public.current_tenant_id() is distinct from tenant then raise exception 'tenant_context_rejected'; end if;
  -- The same envelope -> contract lock order as claiming/finalizing/expiring.
  -- A concurrent signature either wins intact or sees a revoked capability.
  select * into e from public.signing_envelopes where tenant_id=tenant and id=(p_input->>'envelope_id')::uuid and provider='kundexa_native' for update;
  if not found then raise exception 'native_signing_not_found'; end if;
  select * into c from public.contracts where tenant_id=tenant and id=e.contract_id for update;
  if not found or not public.can_write_contract(c.id,c.customer_id) then raise exception 'contract_write_permission_required'; end if;
  if e.provider_evidence->'native_signature' is not null then raise exception 'native_signature_already_claimed'; end if;
  replay:=e.status='cancelled';
  if not replay then
    if e.status not in ('creating','sent','partially_signed') then raise exception 'native_signing_not_cancellable'; end if;
    if c.active_version_id is distinct from e.contract_version_id or c.acceptance_generation<>e.generation then raise exception 'signing_generation_superseded'; end if;
    if c.status not in ('draft','ready','signing') then raise exception 'native_contract_not_cancellable'; end if;
    update public.signing_envelopes set status='cancelled',cancelled_at=now() where id=e.id;
    update public.signing_recipients set status='cancelled' where tenant_id=tenant and envelope_id=e.id and status<>'signed';
    update public.signing_attempts set status='cancelled',completed_at=now() where tenant_id=tenant and envelope_id=e.id and status in ('created','started');
    update public.contract_recipients set status='cancelled' where tenant_id=tenant and contract_id=c.id and generation=e.generation and status<>'signed';
  end if;
  -- The second half repairs partial cancellations produced by the older action,
  -- but can never reset a newer version/generation or a concluded agreement.
  update public.contracts set status='ready' where tenant_id=tenant and id=c.id
    and status='signing' and active_version_id=e.contract_version_id and acceptance_generation=e.generation;
  get diagnostics restored=row_count;
  if not replay or restored>0 then
    insert into public.contract_events(tenant_id,contract_id,event_type,actor_user_id,payload)
      values(tenant,c.id,'signing.native_cancelled',actor,jsonb_build_object('envelope_id',e.id,'generation',e.generation,'recovered_partial_cancellation',replay));
    insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
      values(tenant,actor,'signing.native_cancelled','signing_envelope',e.id::text,jsonb_build_object('contract_id',c.id,'generation',e.generation,'recovered_partial_cancellation',replay));
  end if;
  return jsonb_build_object('envelope_id',e.id,'contract_id',c.id,'status','cancelled','idempotent_replay',replay);
end $$;
revoke all on function public.cancel_native_signing(jsonb) from public,anon,authenticated;
grant execute on function public.cancel_native_signing(jsonb) to service_role;
commit;
