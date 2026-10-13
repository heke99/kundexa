begin;

-- Provider creation happens over HTTP. Recheck the generation while holding the
-- contract lock before atomically enqueuing its invitation and reconciliation.
create function public.queue_docuseal_invitation(
 p_tenant_id uuid,p_envelope_id uuid,p_from_address text,p_subject text,p_body text
) returns boolean language plpgsql security definer set search_path=public as $$
declare e public.signing_envelopes%rowtype; c public.contracts%rowtype;
 r public.contract_recipients%rowtype; v_email uuid; v_key text;
begin
 if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
 select * into e from public.signing_envelopes where tenant_id=p_tenant_id and id=p_envelope_id and provider='docuseal';
 if not found then raise exception 'signing_envelope_not_found'; end if;
 select * into c from public.contracts where tenant_id=p_tenant_id and id=e.contract_id for update;
 select * into e from public.signing_envelopes where tenant_id=p_tenant_id and id=p_envelope_id for update;
 if c.id is null or c.acceptance_generation<>e.generation or c.active_version_id is distinct from e.contract_version_id
   or c.status in ('cancelled','expired','superseded','declined','signed','active','terminated')
   or e.status in ('cancelled','expired','declined','failed','completed')
   or not exists(select 1 from public.contract_signing_links l where l.tenant_id=p_tenant_id and l.envelope_id=e.id
       and l.revoked_at is null and l.expires_at>now()) then
   update public.signing_envelopes set status='cancelled' where tenant_id=p_tenant_id and id=e.id and status<>'completed';
   return false;
 end if;
 if e.provider_envelope_id is null then raise exception 'provider_order_required'; end if;
 select cr.* into r from public.contract_recipients cr join public.signing_recipients sr
   on sr.tenant_id=cr.tenant_id and sr.contract_recipient_id=cr.id
   where sr.tenant_id=p_tenant_id and sr.envelope_id=e.id;
 if r.email is null or r.generation<>e.generation then raise exception 'bound_recipient_required'; end if;
 if not exists(select 1 from public.contract_documents d where d.tenant_id=p_tenant_id and d.contract_id=c.id
   and d.contract_version_id=e.contract_version_id and d.id=(e.provider_evidence->>'source_document_id')::uuid
   and d.sha256=e.provider_evidence->>'source_sha256') then raise exception 'bound_source_document_required'; end if;
 v_key:='docuseal-invite:'||e.id::text;
 insert into public.email_messages(tenant_id,customer_id,contract_id,direction,from_address,to_addresses,subject,body_text,status,purpose,idempotency_key,attachments)
 values(p_tenant_id,c.customer_id,c.id,'outbound',p_from_address,array[r.email],p_subject,p_body,'queued','contract_delivery',v_key,
   jsonb_build_array(jsonb_build_object('document_id',e.provider_evidence->>'source_document_id','filename',c.contract_number||'.pdf','mime_type','application/pdf')))
 on conflict(tenant_id,idempotency_key) do nothing;
 select id into v_email from public.email_messages where tenant_id=p_tenant_id and idempotency_key=v_key;
 insert into public.contract_deliveries(tenant_id,contract_id,contract_version_id,recipient_id,channel,status,email_message_id,canonical_document_id,canonical_document_sha256,delivery_kind,idempotency_key)
 values(p_tenant_id,c.id,e.contract_version_id,r.id,'email','queued',v_email,(e.provider_evidence->>'source_document_id')::uuid,
   e.provider_evidence->>'source_sha256','initial',v_key) on conflict(tenant_id,idempotency_key) do nothing;
 insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key,priority)
 values(p_tenant_id,'email.send','email_message',v_email,jsonb_build_object('message_id',v_email,'signing_envelope_id',e.id),
   'email.send:'||v_key,30) on conflict(tenant_id,idempotency_key) do nothing;
 insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key,available_at,max_attempts,priority)
 values(p_tenant_id,'docuseal.reconcile','contract',c.id,jsonb_build_object('envelope_id',e.id),'docuseal.reconcile:'||e.id::text,
   now()+interval '60 seconds',200000,90) on conflict(tenant_id,idempotency_key) do nothing;
 return true;
end $$;
revoke all on function public.queue_docuseal_invitation(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.queue_docuseal_invitation(uuid,uuid,text,text,text) to service_role;

create function public.project_docuseal_terminal(p_tenant_id uuid,p_envelope_id uuid,p_provider_id text,p_status text)
returns boolean language plpgsql security definer set search_path=public as $$
declare e public.signing_envelopes%rowtype; c public.contracts%rowtype;
begin
 if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
 if p_status not in ('declined','expired') then raise exception 'invalid_signing_terminal_status'; end if;
 select * into e from public.signing_envelopes where tenant_id=p_tenant_id and id=p_envelope_id and provider='docuseal';
 if not found or e.provider_envelope_id is distinct from p_provider_id then raise exception 'provider_order_mismatch'; end if;
 select * into c from public.contracts where tenant_id=p_tenant_id and id=e.contract_id for update;
 select * into e from public.signing_envelopes where tenant_id=p_tenant_id and id=p_envelope_id for update;
 if e.status='completed' then return false; end if;
 update public.signing_envelopes set status=p_status where tenant_id=p_tenant_id and id=e.id;
 update public.signing_recipients set status=p_status where tenant_id=p_tenant_id and envelope_id=e.id and status<>'signed';
 update public.contract_signing_links set revoked_at=coalesce(revoked_at,now()) where tenant_id=p_tenant_id and envelope_id=e.id;
 if c.acceptance_generation=e.generation and c.active_version_id=e.contract_version_id and c.status='signing' then
   update public.contract_recipients set status=p_status,
     declined_at=case when p_status='declined' then now() else declined_at end,
     expired_at=case when p_status='expired' then now() else expired_at end
     where tenant_id=p_tenant_id and contract_id=c.id and generation=e.generation and status<>'signed';
   update public.contracts set status=p_status::public.contract_status where tenant_id=p_tenant_id and id=c.id;
   insert into public.contract_events(tenant_id,contract_id,event_type,payload)
     values(p_tenant_id,c.id,'contract.signing_'||p_status,jsonb_build_object('envelope_id',e.id,'generation',e.generation,'provider','docuseal'));
 end if;
 return true;
end $$;
revoke all on function public.project_docuseal_terminal(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.project_docuseal_terminal(uuid,uuid,text,text) to service_role;

-- Use the same contract -> envelope locking order as preparation, cancellation
-- and activation. Late completion cannot resurrect a cancelled contract.
do $$
declare v text; a text;
begin
 v:=pg_get_functiondef('public.finalize_signing_envelope(uuid,uuid,jsonb)'::regprocedure);
 a:=$anchor$  where id=p_envelope_id
  for update;$anchor$;
 if position(a in v)=0 then raise exception 'finalize_lock_anchor_missing'; end if;
 v:=replace(v,a,'  where id=p_envelope_id;');
 a:=$anchor$  if not found then raise exception 'contract_not_found'; end if;
  if v_contract.active_version_id$anchor$;
 if position(a in v)=0 then raise exception 'finalize_transition_anchor_missing'; end if;
 v:=replace(v,a,$patch$  if not found then raise exception 'contract_not_found'; end if;
  select * into v_envelope from public.signing_envelopes where id=p_envelope_id and tenant_id=v_contract.tenant_id for update;
  if v_contract.status in ('cancelled','expired','declined','superseded','terminated') then
    raise exception 'contract_terminal';
  end if;
  if v_contract.active_version_id$patch$);
 execute v;
end $$;

create function public.guard_contract_frozen_inputs() returns trigger
language plpgsql set search_path=public as $$
begin
 if current_user in ('anon','authenticated') then
   if tg_table_name='contract_versions' then raise exception 'controlled_contract_version_required'; end if;
   if tg_op='INSERT' then raise exception 'controlled_contract_create_required'; end if;
   if new.tenant_id is distinct from old.tenant_id or new.customer_id is distinct from old.customer_id
     or new.active_version_id is distinct from old.active_version_id or new.product_id is distinct from old.product_id
     or new.template_id is distinct from old.template_id or new.seller_snapshot is distinct from old.seller_snapshot
     or new.counterparty_snapshot is distinct from old.counterparty_snapshot then raise exception 'controlled_contract_inputs_required'; end if;
   if new.source_call_id is distinct from old.source_call_id then
     if old.status not in ('draft','ready') or (new.source_call_id is not null and not coalesce(
       (public.get_contract_call_eligibility(new.customer_id,new.source_call_id)->>'eligible')::boolean,false)) then
       raise exception 'eligible_draft_call_required';
     end if;
   end if;
   if (old.status not in ('draft','ready') or not public.has_current_role(array['owner','admin','contract_manager']))
     and (new.value is distinct from old.value or new.currency is distinct from old.currency
       or new.binding_months is distinct from old.binding_months or new.notice_months is distinct from old.notice_months
       or new.starts_on is distinct from old.starts_on or new.ends_on is distinct from old.ends_on) then
     raise exception 'controlled_commercial_change_required';
   end if;
 end if;
 return new;
end $$;
create trigger contracts_frozen_inputs_guard before insert or update on public.contracts for each row execute function public.guard_contract_frozen_inputs();
create trigger contract_versions_direct_write_guard before insert or update on public.contract_versions for each row execute function public.guard_contract_frozen_inputs();

create function public.guard_direct_recipient_write() returns trigger language plpgsql set search_path=public as $$
begin
 if current_user in ('anon','authenticated') then raise exception 'controlled_recipient_write_required'; end if;
 return new;
end $$;
create trigger recipients_direct_write_guard before insert or update on public.contract_recipients for each row execute function public.guard_direct_recipient_write();

create function public.guard_approved_template_policy() returns trigger language plpgsql set search_path=public as $$
begin
 if old.status='approved' and new.signature_policy is distinct from old.signature_policy then
   raise exception 'approved_template_signature_policy_immutable';
 end if;
 return new;
end $$;
create trigger approved_template_policy_guard before update on public.contract_template_versions for each row execute function public.guard_approved_template_policy();

commit;
