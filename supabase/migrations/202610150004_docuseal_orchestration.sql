begin;
create or replace function public.reserve_docuseal_signing(p_input jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid := (p_input->>'tenant_id')::uuid;
  v_actor uuid := (p_input->>'actor_id')::uuid;
  v_contract public.contracts%rowtype; v_version public.contract_versions%rowtype;
  v_document public.contract_documents%rowtype; v_envelope public.signing_envelopes%rowtype;
  v_call public.calls%rowtype; v_policy jsonb; v_counterparty jsonb; v_recipient uuid; v_signer uuid; v_id uuid:=gen_random_uuid(); v_generation integer;
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
  if not exists(select 1 from public.tenant_memberships m join public.tenants t on t.id=m.tenant_id
    where m.tenant_id=v_tenant and m.user_id=v_actor and m.status='active' and t.status in ('trial','active')
      and m.role::text in ('owner','admin','team_lead','sales','contract_manager')) then raise exception 'contract_send_permission_required'; end if;
  perform set_config('request.jwt.claim.sub',v_actor::text,true);
  perform set_config('app.kundexa_tenant_id',v_tenant::text,true);
  if public.current_tenant_id() is distinct from v_tenant then raise exception 'tenant_context_rejected'; end if;
  if nullif(p_input->>'request_key','') is null or nullif(p_input->>'request_hash','') is null then raise exception 'idempotency_key_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_tenant::text || ':docuseal:' || (p_input->>'request_key'),0));
  select * into v_envelope from public.signing_envelopes where tenant_id=v_tenant and provider='docuseal'
    and provider_evidence->>'request_key'=p_input->>'request_key' for update;
  if found then
    if v_envelope.contract_id::text is distinct from p_input->>'contract_id' or v_envelope.provider_evidence->>'request_hash' is distinct from p_input->>'request_hash' then raise exception 'idempotency_conflict'; end if;
    if not public.can_write_contract(v_envelope.contract_id,(select customer_id from public.contracts where tenant_id=v_tenant and id=v_envelope.contract_id)) then raise exception 'contract_send_permission_required'; end if;
    return to_jsonb(v_envelope)||jsonb_build_object('initial',false);
  end if;
  perform public.assert_contract_sendable_v2((p_input->>'contract_id')::uuid,(p_input->>'source_document_id')::uuid,'email');
  select * into v_contract from public.contracts where tenant_id=v_tenant and id=(p_input->>'contract_id')::uuid for update;
  if exists(select 1 from public.signing_envelopes where tenant_id=v_tenant and contract_id=v_contract.id and status in ('draft','creating','sent','partially_signed')) then raise exception 'signing_operation_already_active'; end if;
  if exists(select 1 from public.contract_acceptance_requests where tenant_id=v_tenant and contract_id=v_contract.id and status='pending') then raise exception 'acceptance_operation_already_active'; end if;
  if (p_input->>'expires_at')::timestamptz<=now() or nullif(p_input->>'email','') is null or nullif(p_input->>'recipient_name','') is null then raise exception 'signing_recipient_or_expiry_invalid'; end if;
  select * into v_version from public.contract_versions where tenant_id=v_tenant and id=v_contract.active_version_id for update;
  select coalesce(v_version.signature_policy_snapshot,tv.signature_policy) into v_policy from public.contract_template_versions tv where tv.tenant_id=v_tenant and tv.id=v_version.template_version_id;
  if v_policy->>'method' is distinct from 'external_esign' or v_policy->>'identityAssuranceLevel' is distinct from 'low' or not coalesce((v_policy->>'requireFinalProviderDocument')::boolean,false) then raise exception 'docuseal_signature_policy_unsupported'; end if;
  if v_version.commercial_terms->'pdf_fields'->'template' is null then raise exception 'docuseal_pdf_field_template_required'; end if;
  select * into v_document from public.contract_documents where tenant_id=v_tenant and id=(p_input->>'source_document_id')::uuid;
  if v_document.sha256 is distinct from p_input->>'source_sha256' then raise exception 'source_document_hash_mismatch'; end if;
  v_counterparty:=coalesce(v_document.metadata#>'{locked_parties,counterparty}',v_contract.counterparty_snapshot);
  if lower(trim(coalesce(v_counterparty->>'email',''))) is distinct from lower(trim(p_input->>'email')) or nullif(trim(v_counterparty->>'display_name'),'') is distinct from nullif(trim(p_input->>'recipient_name'),'') then raise exception 'signing_recipient_snapshot_mismatch'; end if;
  select * into v_call from public.calls where tenant_id=v_tenant and id=v_contract.source_call_id;
  v_generation:=v_contract.acceptance_generation+1;
  update public.contracts set acceptance_generation=v_generation,
    source_call_eligibility_snapshot=coalesce(source_call_eligibility_snapshot,jsonb_build_object('eligible',true,'callId',v_call.id,'customerId',v_call.customer_id,'disposition',v_call.disposition,'endedAt',v_call.ended_at,'capturedAt',now(),'policyVersion','external-signing-v1')),
    source_call_eligibility_locked_at=coalesce(source_call_eligibility_locked_at,now()) where tenant_id=v_tenant and id=v_contract.id;
  update public.contract_versions set locked_at=coalesce(locked_at,now()),signature_policy_snapshot=v_policy where tenant_id=v_tenant and id=v_version.id;
  update public.contract_recipients set required=false where tenant_id=v_tenant and contract_id=v_contract.id and generation<v_generation;
  insert into public.contract_recipients(tenant_id,contract_id,full_name,email,role,required,generation)
    values(v_tenant,v_contract.id,p_input->>'recipient_name',p_input->>'email','signer',true,v_generation) returning id into v_recipient;
  insert into public.signing_envelopes(id,tenant_id,contract_id,contract_version_id,provider,signature_policy,status,created_by,generation,provider_evidence)
    values(v_id,v_tenant,v_contract.id,v_version.id,'docuseal',v_policy,'creating',v_actor,v_generation,p_input-'actor_id'-'tenant_id'-'contract_id');
  insert into public.signing_recipients(tenant_id,envelope_id,contract_recipient_id,role,required,identity_assurance_level)
    values(v_tenant,v_id,v_recipient,'signer',true,'low') returning id into v_signer;
  insert into public.signing_attempts(tenant_id,envelope_id,signing_recipient_id,status,verification_method,started_at)
    values(v_tenant,v_id,v_signer,'started','external_esign',now());
  insert into public.signing_documents(tenant_id,envelope_id,contract_document_id,document_role,sha256)
    values(v_tenant,v_id,v_document.id,'source',v_document.sha256);
  insert into public.contract_events(tenant_id,contract_id,event_type,actor_user_id,payload)
    values(v_tenant,v_contract.id,'signing.external_reserved',v_actor,jsonb_build_object('envelope_id',v_id,'generation',v_generation,'source_sha256',v_document.sha256));
  select * into v_envelope from public.signing_envelopes where id=v_id;
  return to_jsonb(v_envelope)||jsonb_build_object('initial',true);
end $$;
revoke all on function public.reserve_docuseal_signing(jsonb) from public,anon,authenticated;
grant execute on function public.reserve_docuseal_signing(jsonb) to service_role;

create or replace function public.claim_docuseal_submission(p_envelope_id uuid,p_template_id text)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_envelope public.signing_envelopes%rowtype;
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
  select * into v_envelope from public.signing_envelopes where id=p_envelope_id and provider='docuseal' for update;
  if not found or v_envelope.status<>'creating' then raise exception 'signing_envelope_not_creating'; end if;
  if v_envelope.provider_evidence->>'provider_template_id' is not null and v_envelope.provider_evidence->>'provider_template_id'<>p_template_id then raise exception 'signing_template_conflict'; end if;
  if coalesce((v_envelope.provider_evidence->>'submission_attempted')::boolean,false) then return false; end if;
  update public.signing_envelopes set provider_evidence=provider_evidence||jsonb_build_object('provider_template_id',p_template_id,'submission_attempted',true,'submission_attempted_at',now()) where id=p_envelope_id;
  return true;
end $$;
revoke all on function public.claim_docuseal_submission(uuid,text) from public,anon,authenticated;
grant execute on function public.claim_docuseal_submission(uuid,text) to service_role;

create or replace function public.commit_docuseal_invitation(p_input jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_envelope public.signing_envelopes%rowtype; v_contract public.contracts%rowtype; v_recipient public.signing_recipients%rowtype; v_email uuid; v_delivery uuid;
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
  select * into v_envelope from public.signing_envelopes where id=(p_input->>'envelope_id')::uuid for update;
  if not found then raise exception 'signing_envelope_not_found'; end if;
  select * into v_contract from public.contracts where tenant_id=v_envelope.tenant_id and id=v_envelope.contract_id for update;
  if v_contract.active_version_id<>v_envelope.contract_version_id or v_contract.acceptance_generation<>v_envelope.generation then raise exception 'signing_generation_superseded'; end if;
  if v_envelope.provider_envelope_id is not null then
    if v_envelope.provider_envelope_id<>p_input->>'provider_envelope_id' then raise exception 'provider_envelope_conflict'; end if;
    return jsonb_build_object('envelope_id',v_envelope.id,'idempotent_replay',true);
  end if;
  if v_envelope.status<>'creating' then raise exception 'signing_envelope_not_creating'; end if;
  if not exists(select 1 from public.tenant_memberships m join public.tenants t on t.id=m.tenant_id where m.tenant_id=v_envelope.tenant_id and m.user_id=v_envelope.created_by and m.status='active' and m.role::text in ('owner','admin','team_lead','sales','contract_manager') and t.status in ('trial','active')) then raise exception 'active_api_actor_membership_required'; end if;
  select * into v_recipient from public.signing_recipients where tenant_id=v_envelope.tenant_id and envelope_id=v_envelope.id;
  update public.signing_recipients set provider_recipient_id=p_input->>'provider_recipient_id',status='sent' where id=v_recipient.id;
  update public.signing_envelopes set provider_envelope_id=p_input->>'provider_envelope_id',status='sent',sent_at=now(),
    provider_evidence=provider_evidence||jsonb_build_object('provider_template_id',p_input->>'provider_template_id') where id=v_envelope.id;
  insert into public.email_messages(tenant_id,customer_id,contract_id,direction,from_address,to_addresses,subject,body_text,body_html,status,attachments,created_by,idempotency_key,purpose)
    values(v_envelope.tenant_id,v_contract.customer_id,v_contract.id,'outbound',p_input->>'email_from',array[v_envelope.provider_evidence->>'email']::citext[],p_input->>'subject',p_input->>'text',p_input->>'html','queued',p_input->'attachments',v_envelope.created_by,'docuseal-invite/'||v_envelope.id,'contract_delivery') returning id into v_email;
  insert into public.contract_deliveries(tenant_id,contract_id,contract_version_id,recipient_id,channel,status,email_message_id,canonical_document_id,canonical_document_sha256,idempotency_key)
    values(v_envelope.tenant_id,v_contract.id,v_envelope.contract_version_id,v_recipient.contract_recipient_id,'email','queued',v_email,(v_envelope.provider_evidence->>'source_document_id')::uuid,v_envelope.provider_evidence->>'source_sha256','docuseal-invite/'||v_envelope.id) returning id into v_delivery;
  insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key)
    values(v_envelope.tenant_id,'email.send','email_message',v_email,jsonb_build_object('email_message_id',v_email,'delivery_id',v_delivery),'email.send/'||v_email);
  update public.contracts set status='signing' where tenant_id=v_envelope.tenant_id and id=v_contract.id;
  insert into public.contract_events(tenant_id,contract_id,event_type,actor_user_id,payload)
    values(v_envelope.tenant_id,v_contract.id,'signing.invitation_queued',v_envelope.created_by,jsonb_build_object('envelope_id',v_envelope.id,'email_message_id',v_email));
  return jsonb_build_object('envelope_id',v_envelope.id,'idempotent_replay',false);
end $$;
revoke all on function public.commit_docuseal_invitation(jsonb) from public,anon,authenticated;
grant execute on function public.commit_docuseal_invitation(jsonb) to service_role;

create or replace function public.complete_docuseal_signing(p_input jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_envelope public.signing_envelopes%rowtype; v_doc uuid; v_audit_doc uuid; v_result jsonb; v_locked_parties jsonb;
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
  select * into v_envelope from public.signing_envelopes where id=(p_input->>'envelope_id')::uuid for update;
  if not found or v_envelope.provider<>'docuseal' or v_envelope.provider_envelope_id is distinct from p_input->>'provider_envelope_id' then raise exception 'provider_envelope_mismatch'; end if;
  if v_envelope.status<>'completed' and not exists(select 1 from public.contracts where tenant_id=v_envelope.tenant_id and id=v_envelope.contract_id and status='signing') then raise exception 'contract_not_awaiting_signature'; end if;
  if v_envelope.status='completed' then return public.finalize_signing_envelope(v_envelope.id,v_envelope.final_document_id,p_input->'evidence'); end if;
  if (v_envelope.provider_evidence->>'expires_at')::timestamptz < (p_input->>'completed_at')::timestamptz then raise exception 'signing_expired'; end if;
  if p_input->>'source_sha256' is distinct from v_envelope.provider_evidence->>'source_sha256' then raise exception 'source_document_hash_mismatch'; end if;
  if p_input->>'storage_path' not like v_envelope.tenant_id::text||'/'||v_envelope.contract_id::text||'/'||v_envelope.contract_version_id::text||'/%' then raise exception 'final_document_storage_mismatch'; end if;
  if nullif(p_input->>'audit_sha256','') is null or coalesce((p_input->>'audit_size_bytes')::bigint,0)<=0
    or p_input->>'audit_storage_path' not like v_envelope.tenant_id::text||'/'||v_envelope.contract_id::text||'/'||v_envelope.contract_version_id::text||'/%' then raise exception 'provider_audit_document_required'; end if;
  if not exists(select 1 from public.signing_recipients where tenant_id=v_envelope.tenant_id and envelope_id=v_envelope.id and provider_recipient_id=p_input->>'provider_recipient_id') then raise exception 'provider_recipient_mismatch'; end if;
  select d.metadata->'locked_parties' into v_locked_parties from public.signing_documents sd
    join public.contract_documents d on d.tenant_id=sd.tenant_id and d.id=sd.contract_document_id
    where sd.tenant_id=v_envelope.tenant_id and sd.envelope_id=v_envelope.id and sd.document_role='source'
      and d.contract_id=v_envelope.contract_id and d.contract_version_id=v_envelope.contract_version_id
      and d.sha256=v_envelope.provider_evidence->>'source_sha256' and sd.sha256=d.sha256;
  if v_locked_parties is null or nullif(trim(v_locked_parties#>>'{seller,legal_name}'),'') is null then raise exception 'signing_source_locked_parties_required'; end if;
  insert into public.signing_events(tenant_id,envelope_id,provider,provider_event_id,event_type,event_at,verified,payload,processing_status)
    values(v_envelope.tenant_id,v_envelope.id,'docuseal',p_input->>'event_id','submission.completed',(p_input->>'completed_at')::timestamptz,true,p_input->'evidence','processed') on conflict(provider,provider_event_id) do nothing;
  insert into public.contract_documents(tenant_id,contract_id,contract_version_id,document_type,file_name,storage_path,mime_type,size_bytes,sha256,metadata)
    values(v_envelope.tenant_id,v_envelope.contract_id,v_envelope.contract_version_id,'signed_pdf','signed.pdf',p_input->>'storage_path','application/pdf',(p_input->>'size_bytes')::bigint,p_input->>'sha256',jsonb_build_object('immutable',true,'locked_parties',v_locked_parties,'envelope_id',v_envelope.id,'generation',v_envelope.generation,'source_sha256',p_input->>'source_sha256'))
    on conflict(tenant_id,storage_path) do update set sha256=excluded.sha256 where contract_documents.sha256=excluded.sha256 returning id into v_doc;
  if v_doc is null then raise exception 'final_document_hash_conflict'; end if;
  insert into public.contract_documents(tenant_id,contract_id,contract_version_id,document_type,file_name,storage_path,mime_type,size_bytes,sha256,metadata)
    values(v_envelope.tenant_id,v_envelope.contract_id,v_envelope.contract_version_id,'evidence_pdf','provider-audit.pdf',p_input->>'audit_storage_path','application/pdf',(p_input->>'audit_size_bytes')::bigint,p_input->>'audit_sha256',jsonb_build_object('immutable',true,'locked_parties',v_locked_parties,'provider_audit',true,'envelope_id',v_envelope.id,'generation',v_envelope.generation,'version_id',v_envelope.contract_version_id))
    on conflict(tenant_id,storage_path) do update set sha256=excluded.sha256 where contract_documents.sha256=excluded.sha256 returning id into v_audit_doc;
  if v_audit_doc is null then raise exception 'provider_audit_document_hash_conflict'; end if;
  insert into public.signing_documents(tenant_id,envelope_id,contract_document_id,document_role,sha256)
    values(v_envelope.tenant_id,v_envelope.id,v_audit_doc,'provider_evidence',p_input->>'audit_sha256') on conflict(envelope_id,document_role) do nothing;
  update public.signing_recipients set status='signed',signed_at=(p_input->>'completed_at')::timestamptz where tenant_id=v_envelope.tenant_id and envelope_id=v_envelope.id and provider_recipient_id=p_input->>'provider_recipient_id';
  update public.signing_attempts set status='completed',completed_at=now() where tenant_id=v_envelope.tenant_id and envelope_id=v_envelope.id;
  v_result:=public.finalize_signing_envelope(v_envelope.id,v_doc,(p_input->'evidence')||jsonb_build_object('provider_audit_document_id',v_audit_doc,'provider_audit_sha256',p_input->>'audit_sha256'));
  return v_result;
end $$;
revoke all on function public.complete_docuseal_signing(jsonb) from public,anon,authenticated;
grant execute on function public.complete_docuseal_signing(jsonb) to service_role;
commit;
