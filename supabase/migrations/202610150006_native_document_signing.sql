begin;
create unique index signing_envelopes_native_token_uidx on public.signing_envelopes((provider_evidence->>'public_token_hash')) where provider='kundexa_native';
create unique index signing_envelopes_native_request_uidx on public.signing_envelopes(tenant_id,(provider_evidence->>'request_key')) where provider='kundexa_native';
create or replace function public.reserve_native_signing(p_input jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
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
  if length(coalesce(p_input->>'request_key','')) not between 1 and 200 or coalesce(p_input->>'request_hash','') !~ '^[a-f0-9]{64}$' then raise exception 'idempotency_key_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_tenant::text || ':kundexa-native:' || (p_input->>'request_key'),0));
  select * into v_envelope from public.signing_envelopes where tenant_id=v_tenant and provider='kundexa_native'
    and provider_evidence->>'request_key'=p_input->>'request_key' for update;
  if found then
    if v_envelope.contract_id::text is distinct from p_input->>'contract_id' or v_envelope.provider_evidence->>'request_hash' is distinct from p_input->>'request_hash' then raise exception 'idempotency_conflict'; end if;
    if not public.can_write_contract(v_envelope.contract_id,(select customer_id from public.contracts where tenant_id=v_tenant and id=v_envelope.contract_id)) then raise exception 'contract_send_permission_required'; end if;
    if (p_input ? 'email' and lower(trim(p_input->>'email')) is distinct from v_envelope.provider_evidence->>'email')
      or (p_input ? 'recipient_name' and trim(p_input->>'recipient_name') is distinct from v_envelope.provider_evidence->>'recipient_name')
      or v_envelope.created_by is distinct from v_actor
      or v_envelope.provider_evidence->>'source_document_id' is distinct from p_input->>'source_document_id'
      or v_envelope.provider_evidence->>'source_sha256' is distinct from p_input->>'source_sha256'
      or (v_envelope.provider_evidence->>'expires_at')::timestamptz is distinct from (p_input->>'expires_at')::timestamptz
      then raise exception 'idempotency_conflict'; end if;
    if not exists(select 1 from public.contracts c where c.tenant_id=v_tenant and c.id=v_envelope.contract_id
      and c.active_version_id=v_envelope.contract_version_id and c.acceptance_generation=v_envelope.generation)
      then raise exception 'signing_generation_superseded'; end if;
    return to_jsonb(v_envelope)||jsonb_build_object('initial',false);
  end if;
  perform public.assert_contract_sendable_v2((p_input->>'contract_id')::uuid,(p_input->>'source_document_id')::uuid,'email');
  select * into v_contract from public.contracts where tenant_id=v_tenant and id=(p_input->>'contract_id')::uuid for update;
  if exists(select 1 from public.signing_envelopes where tenant_id=v_tenant and contract_id=v_contract.id and status in ('draft','creating','sent','partially_signed')) then raise exception 'signing_operation_already_active'; end if;
  if exists(select 1 from public.contract_acceptance_requests where tenant_id=v_tenant and contract_id=v_contract.id and status='pending') then raise exception 'acceptance_operation_already_active'; end if;
  if (p_input->>'expires_at') is null or (p_input->>'expires_at')::timestamptz<=now()
    or coalesce(p_input->>'public_token_hash','') !~ '^[a-f0-9]{64}$'
    or nullif(p_input->>'public_token_ciphertext','') is null then raise exception 'signing_recipient_or_expiry_invalid'; end if;
  select * into v_version from public.contract_versions where tenant_id=v_tenant and id=v_contract.active_version_id for update;
  select coalesce(v_version.signature_policy_snapshot,tv.signature_policy) into v_policy from public.contract_template_versions tv where tv.tenant_id=v_tenant and tv.id=v_version.template_version_id;
  if v_policy->>'method' is distinct from 'external_esign' or v_policy->>'identityAssuranceLevel' is distinct from 'low' or not coalesce((v_policy->>'requireFinalProviderDocument')::boolean,false) then raise exception 'native_signature_policy_unsupported'; end if;
  if not exists(select 1 from public.contract_template_versions tv where tv.tenant_id=v_tenant and tv.id=v_version.template_version_id
    and tv.status='approved' and tv.signing_configuration->>'provider_key'='kundexa_native') then raise exception 'native_template_provider_required'; end if;
  if v_version.commercial_terms->'pdf_fields'->'template' is null then raise exception 'native_pdf_field_template_required'; end if;
  select * into v_document from public.contract_documents where tenant_id=v_tenant and id=(p_input->>'source_document_id')::uuid;
  if v_document.sha256 !~ '^[a-f0-9]{64}$' or v_document.sha256 is distinct from p_input->>'source_sha256' then raise exception 'source_document_hash_mismatch'; end if;
  v_counterparty:=v_document.metadata#>'{locked_parties,counterparty}';
  if nullif(trim(v_document.metadata#>>'{locked_parties,seller,legal_name}'),'') is null
    or nullif(trim(v_counterparty->>'display_name'),'') is null
    or coalesce(v_counterparty->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    then raise exception 'signing_source_locked_parties_required'; end if;
  if (p_input ? 'email' and lower(trim(p_input->>'email')) is distinct from lower(trim(v_counterparty->>'email')))
    or (p_input ? 'recipient_name' and trim(p_input->>'recipient_name') is distinct from trim(v_counterparty->>'display_name'))
    then raise exception 'signing_recipient_snapshot_mismatch'; end if;
  p_input:=p_input||jsonb_build_object('email',lower(trim(v_counterparty->>'email')),'recipient_name',trim(v_counterparty->>'display_name'));
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
    values(v_id,v_tenant,v_contract.id,v_version.id,'kundexa_native',v_policy,'creating',v_actor,v_generation,jsonb_build_object('request_key',p_input->>'request_key','request_hash',p_input->>'request_hash',
      'source_document_id',v_document.id,'source_sha256',v_document.sha256,
      'recipient_name',p_input->>'recipient_name','email',p_input->>'email','expires_at',p_input->>'expires_at',
      'public_token_hash',p_input->>'public_token_hash','public_token_ciphertext',p_input->>'public_token_ciphertext'));
  insert into public.signing_recipients(tenant_id,envelope_id,contract_recipient_id,role,required,identity_assurance_level)
    values(v_tenant,v_id,v_recipient,'signer',true,'low') returning id into v_signer;
  insert into public.signing_attempts(tenant_id,envelope_id,signing_recipient_id,status,verification_method,started_at)
    values(v_tenant,v_id,v_signer,'started','external_esign',now());
  insert into public.signing_documents(tenant_id,envelope_id,contract_document_id,document_role,sha256)
    values(v_tenant,v_id,v_document.id,'source',v_document.sha256);
  insert into public.contract_events(tenant_id,contract_id,event_type,actor_user_id,payload)
    values(v_tenant,v_contract.id,'signing.native_reserved',v_actor,jsonb_build_object('envelope_id',v_id,'generation',v_generation,'source_sha256',v_document.sha256));
  select * into v_envelope from public.signing_envelopes where id=v_id;
  return to_jsonb(v_envelope)||jsonb_build_object('initial',true);
end $$;
revoke all on function public.reserve_native_signing(jsonb) from public,anon,authenticated;
grant execute on function public.reserve_native_signing(jsonb) to service_role;


-- This helper is not a Data API endpoint. All public entry points below remain
-- service-only and independently bind the recipient capability and generation.
create schema if not exists private;
create or replace function private.native_signing_context(p_envelope_id uuid,p_token_hash text default null)
returns public.signing_envelopes language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare e public.signing_envelopes%rowtype; c public.contracts%rowtype; d public.contract_documents%rowtype;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_required'; end if;
  select * into e from public.signing_envelopes where id=p_envelope_id and provider='kundexa_native' for update;
  if not found then raise exception 'native_signing_not_found'; end if;
  if p_token_hash is not null and (p_token_hash !~ '^[a-f0-9]{64}$' or p_token_hash is distinct from e.provider_evidence->>'public_token_hash')
    then raise exception 'native_signing_token_invalid'; end if;
  select * into c from public.contracts where tenant_id=e.tenant_id and id=e.contract_id for update;
  if not found or c.active_version_id is distinct from e.contract_version_id or c.acceptance_generation<>e.generation then raise exception 'signing_generation_superseded'; end if;
  if not exists(select 1 from public.tenants t join public.tenant_memberships m on m.tenant_id=t.id
    where t.id=e.tenant_id and t.status in ('trial','active') and m.user_id=e.created_by and m.status='active'
      and m.role::text in ('owner','admin','team_lead','sales','contract_manager')) then raise exception 'native_signing_actor_inactive'; end if;
  if not exists(select 1 from public.contract_versions v where v.tenant_id=e.tenant_id and v.id=e.contract_version_id
    and v.contract_id=e.contract_id and v.locked_at is not null and v.signature_policy_snapshot=e.signature_policy)
    then raise exception 'native_signing_snapshot_mismatch'; end if;
  select d0.* into d from public.signing_documents sd join public.contract_documents d0
    on d0.tenant_id=sd.tenant_id and d0.id=sd.contract_document_id
    where sd.tenant_id=e.tenant_id and sd.envelope_id=e.id and sd.document_role='source'
      and d0.contract_id=e.contract_id and d0.contract_version_id=e.contract_version_id
      and d0.id::text=e.provider_evidence->>'source_document_id'
      and d0.sha256=e.provider_evidence->>'source_sha256' and sd.sha256=d0.sha256;
  if not found or nullif(trim(d.metadata#>>'{locked_parties,seller,legal_name}'),'') is null
    or trim(d.metadata#>>'{locked_parties,counterparty,display_name}') is distinct from e.provider_evidence->>'recipient_name'
    or lower(trim(d.metadata#>>'{locked_parties,counterparty,email}')) is distinct from e.provider_evidence->>'email'
    then raise exception 'native_signing_source_mismatch'; end if;
  perform set_config('request.jwt.claim.sub',e.created_by::text,true);
  perform set_config('app.kundexa_tenant_id',e.tenant_id::text,true);
  return e;
end $$;
revoke all on function private.native_signing_context(uuid,text) from public,anon,authenticated;

create or replace function public.commit_native_invitation(p_input jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare e public.signing_envelopes%rowtype; c public.contracts%rowtype; r public.signing_recipients%rowtype;
  message_id uuid; delivery_id uuid; invitation_hash text;
begin
  e:=private.native_signing_context((p_input->>'envelope_id')::uuid);
  invitation_hash:=encode(digest((p_input-'envelope_id')::text,'sha256'),'hex');
  if e.provider_evidence ? 'invitation_message_id' then
    if e.provider_evidence->>'invitation_hash' is distinct from invitation_hash then raise exception 'native_invitation_conflict'; end if;
    return jsonb_build_object('envelope_id',e.id,'idempotent_replay',true);
  end if;
  if e.status<>'creating' or (e.provider_evidence->>'expires_at')::timestamptz<=now() then raise exception 'native_signing_not_invitable'; end if;
  if coalesce(p_input->>'email_from','') !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    or nullif(p_input->>'subject','') is null or nullif(p_input->>'text','') is null
    then raise exception 'native_invitation_content_required'; end if;
  select * into c from public.contracts where id=e.contract_id and tenant_id=e.tenant_id;
  if c.status not in ('draft','ready','expired') then raise exception 'native_contract_not_sendable'; end if;
  select * into r from public.signing_recipients where tenant_id=e.tenant_id and envelope_id=e.id and required;
  if not found then raise exception 'native_signing_recipient_missing'; end if;
  update public.signing_recipients set status='sent' where id=r.id;
  insert into public.email_messages(tenant_id,customer_id,contract_id,direction,from_address,to_addresses,subject,body_text,body_html,status,attachments,created_by,idempotency_key,purpose)
    values(e.tenant_id,c.customer_id,c.id,'outbound',p_input->>'email_from',array[e.provider_evidence->>'email']::citext[],
      p_input->>'subject',p_input->>'text',p_input->>'html','queued',coalesce(p_input->'attachments','[]'::jsonb),e.created_by,'native-invite/'||e.id,'contract_delivery') returning id into message_id;
  insert into public.contract_deliveries(tenant_id,contract_id,contract_version_id,recipient_id,channel,status,email_message_id,canonical_document_id,canonical_document_sha256,idempotency_key)
    values(e.tenant_id,c.id,e.contract_version_id,r.contract_recipient_id,'email','queued',message_id,
      (e.provider_evidence->>'source_document_id')::uuid,e.provider_evidence->>'source_sha256','native-invite/'||e.id) returning id into delivery_id;
  insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key)
    values(e.tenant_id,'email.send','email_message',message_id,jsonb_build_object('email_message_id',message_id,'delivery_id',delivery_id),'email.send/'||message_id);
  update public.signing_envelopes set status='sent',sent_at=now(),provider_evidence=provider_evidence||jsonb_build_object('invitation_message_id',message_id,'invitation_hash',invitation_hash) where id=e.id;
  update public.contracts set status='signing' where id=c.id and tenant_id=e.tenant_id;
  insert into public.contract_events(tenant_id,contract_id,event_type,actor_user_id,payload)
    values(e.tenant_id,c.id,'signing.invitation_queued',e.created_by,jsonb_build_object('envelope_id',e.id,'provider_key','kundexa_native','email_message_id',message_id));
  return jsonb_build_object('envelope_id',e.id,'idempotent_replay',false);
end $$;
revoke all on function public.commit_native_invitation(jsonb) from public,anon,authenticated;
grant execute on function public.commit_native_invitation(jsonb) to service_role;

create or replace function public.claim_native_signature(p_input jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare e public.signing_envelopes%rowtype; receipt jsonb; payload jsonb; payload_hash text; accepted_at timestamptz:=now();
  acceptance_text constant text:='Jag har granskat avtalet och vill underteckna det med min ritade underskrift. Detta är en enkel elektronisk signatur utan BankID.';
begin
  if nullif(p_input->>'public_token_hash','') is null then raise exception 'native_signing_token_invalid'; end if;
  e:=private.native_signing_context((p_input->>'envelope_id')::uuid,p_input->>'public_token_hash');
  if length(coalesce(p_input->>'request_key','')) not between 1 and 200 or coalesce(p_input->>'request_hash','') !~ '^[a-f0-9]{64}$'
    or p_input->'consent' is distinct from 'true'::jsonb
    or trim(p_input->>'signer_name') is distinct from e.provider_evidence->>'recipient_name'
    or p_input->>'source_sha256' is distinct from e.provider_evidence->>'source_sha256'
    or coalesce(p_input->>'signature_sha256','') !~ '^[a-f0-9]{64}$'
    or p_input->>'signature_storage_path' is distinct from e.tenant_id::text||'/'||e.contract_id::text||'/'||e.contract_version_id::text||'/signatures/'||(p_input->>'signature_sha256')||'.png'
    then raise exception 'native_signature_payload_invalid'; end if;
  payload:=jsonb_build_object('request_key',p_input->>'request_key','request_hash',p_input->>'request_hash',
    'source_sha256',p_input->>'source_sha256','signature_sha256',p_input->>'signature_sha256',
    'signature_storage_path',p_input->>'signature_storage_path','signer_name',trim(p_input->>'signer_name'),
    'consent',true,'acceptance_text',acceptance_text);
  payload_hash:=encode(digest(payload::text,'sha256'),'hex');
  receipt:=e.provider_evidence->'native_signature';
  if receipt is not null then
    if receipt->>'receipt_hash' is distinct from payload_hash then raise exception 'native_signature_idempotency_conflict'; end if;
    if e.status not in ('sent','partially_signed','completed') then raise exception 'native_signing_terminal'; end if;
    return to_jsonb(e)||jsonb_build_object('native_signature',receipt,'initial',false);
  end if;
  if e.status<>'sent' or not exists(select 1 from public.contracts where id=e.contract_id and tenant_id=e.tenant_id and status='signing')
    then raise exception 'native_signing_not_awaiting_signature'; end if;
  if (e.provider_evidence->>'expires_at')::timestamptz<=accepted_at then raise exception 'native_signing_expired'; end if;
  receipt:=payload||jsonb_build_object('receipt_id',gen_random_uuid(),'receipt_hash',payload_hash,
    'tenant_id',e.tenant_id,'contract_id',e.contract_id,'contract_version_id',e.contract_version_id,
    'envelope_id',e.id,'generation',e.generation,'accepted_at',accepted_at,
    'ip_address',nullif(p_input->>'ip_address','')::inet,'user_agent',left(p_input->>'user_agent',2000));
  update public.signing_envelopes set provider_evidence=provider_evidence||jsonb_build_object('native_signature',receipt) where id=e.id returning * into e;
  update public.signing_attempts set status='verified',session_token_hash=p_input->>'public_token_hash',
    ip_address=nullif(p_input->>'ip_address','')::inet,user_agent=left(p_input->>'user_agent',2000),
    verified_identity=jsonb_build_object('recipient_name',receipt->>'signer_name','identity_assurance_level','low','receipt_id',receipt->>'receipt_id')
    where tenant_id=e.tenant_id and envelope_id=e.id;
  insert into public.contract_events(tenant_id,contract_id,event_type,payload)
    values(e.tenant_id,e.contract_id,'signing.native_signature_claimed',jsonb_build_object('envelope_id',e.id,'receipt_id',receipt->>'receipt_id','generation',e.generation,'signature_sha256',p_input->>'signature_sha256'));
  return to_jsonb(e)||jsonb_build_object('native_signature',receipt,'initial',true);
end $$;
revoke all on function public.claim_native_signature(jsonb) from public,anon,authenticated;
grant execute on function public.claim_native_signature(jsonb) to service_role;

create or replace function public.finalize_native_signature(p_input jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare e public.signing_envelopes%rowtype; receipt jsonb; binding jsonb; parties jsonb; result jsonb;
  signed_doc uuid; audit_doc uuid; path_prefix text; signer uuid;
begin
  if nullif(p_input->>'public_token_hash','') is null then raise exception 'native_signing_token_invalid'; end if;
  e:=private.native_signing_context((p_input->>'envelope_id')::uuid,p_input->>'public_token_hash');
  receipt:=e.provider_evidence->'native_signature';
  if receipt is null or receipt->>'receipt_id' is distinct from p_input->>'receipt_id'
    or receipt->>'request_key' is distinct from p_input->>'request_key'
    or receipt->>'request_hash' is distinct from p_input->>'request_hash'
    or receipt->>'source_sha256' is distinct from p_input->>'source_sha256'
    or receipt->>'signature_sha256' is distinct from p_input->>'signature_sha256'
    then raise exception 'native_signature_receipt_mismatch'; end if;
  path_prefix:=e.tenant_id::text||'/'||e.contract_id::text||'/'||e.contract_version_id::text||'/native/'||(receipt->>'receipt_id');
  if p_input->>'storage_path' is distinct from path_prefix||'/signed.pdf'
    or p_input->>'audit_storage_path' is distinct from path_prefix||'/audit.pdf'
    or coalesce(p_input->>'sha256','') !~ '^[a-f0-9]{64}$' or coalesce(p_input->>'audit_sha256','') !~ '^[a-f0-9]{64}$'
    or coalesce((p_input->>'size_bytes')::bigint,0) not between 1 and 20971520
    or coalesce((p_input->>'audit_size_bytes')::bigint,0) not between 1 and 20971520
    then raise exception 'native_signature_documents_invalid'; end if;
  binding:=jsonb_build_object('receipt_id',receipt->>'receipt_id','storage_path',p_input->>'storage_path',
    'sha256',p_input->>'sha256','size_bytes',(p_input->>'size_bytes')::bigint,
    'audit_storage_path',p_input->>'audit_storage_path','audit_sha256',p_input->>'audit_sha256','audit_size_bytes',(p_input->>'audit_size_bytes')::bigint);
  if e.status='completed' then
    if e.provider_evidence->'native_finalization' is distinct from binding then raise exception 'native_finalization_conflict'; end if;
    return public.finalize_signing_envelope(e.id,e.final_document_id,'{}'::jsonb);
  end if;
  if e.status not in ('sent','partially_signed') or not exists(select 1 from public.contracts
    where tenant_id=e.tenant_id and id=e.contract_id and status='signing') then raise exception 'native_signing_not_awaiting_signature'; end if;
  -- A first receipt obtained before expiry can finish after a worker interruption.
  -- Neither the acceptance timestamp nor its contents are supplied anew on retry.
  if (receipt->>'accepted_at')::timestamptz>(e.provider_evidence->>'expires_at')::timestamptz then raise exception 'native_signing_expired'; end if;
  select d.metadata->'locked_parties' into parties from public.signing_documents sd join public.contract_documents d
    on d.tenant_id=sd.tenant_id and d.id=sd.contract_document_id
    where sd.tenant_id=e.tenant_id and sd.envelope_id=e.id and sd.document_role='source';
  insert into public.contract_documents(tenant_id,contract_id,contract_version_id,document_type,file_name,storage_path,mime_type,size_bytes,sha256,metadata)
    values(e.tenant_id,e.contract_id,e.contract_version_id,'signed_pdf','signed.pdf',p_input->>'storage_path','application/pdf',
      (p_input->>'size_bytes')::bigint,p_input->>'sha256',jsonb_build_object('immutable',true,'locked_parties',parties,'envelope_id',e.id,
      'generation',e.generation,'source_sha256',receipt->>'source_sha256','signature_sha256',receipt->>'signature_sha256','native_signature',receipt))
    on conflict(tenant_id,storage_path) do nothing returning id into signed_doc;
  if signed_doc is null then
    select id into signed_doc from public.contract_documents where tenant_id=e.tenant_id and contract_id=e.contract_id
      and contract_version_id=e.contract_version_id and storage_path=p_input->>'storage_path' and document_type='signed_pdf'
      and sha256=p_input->>'sha256' and size_bytes=(p_input->>'size_bytes')::bigint and metadata->'native_signature'=receipt;
  end if;
  if signed_doc is null then raise exception 'native_signed_document_conflict'; end if;
  insert into public.contract_documents(tenant_id,contract_id,contract_version_id,document_type,file_name,storage_path,mime_type,size_bytes,sha256,metadata)
    values(e.tenant_id,e.contract_id,e.contract_version_id,'evidence_pdf','audit.pdf',p_input->>'audit_storage_path','application/pdf',
      (p_input->>'audit_size_bytes')::bigint,p_input->>'audit_sha256',jsonb_build_object('immutable',true,'locked_parties',parties,'envelope_id',e.id,
      'generation',e.generation,'version_id',e.contract_version_id,'provider_audit',true,'native_signature',receipt))
    on conflict(tenant_id,storage_path) do nothing returning id into audit_doc;
  if audit_doc is null then
    select id into audit_doc from public.contract_documents where tenant_id=e.tenant_id and contract_id=e.contract_id
      and contract_version_id=e.contract_version_id and storage_path=p_input->>'audit_storage_path' and document_type='evidence_pdf'
      and sha256=p_input->>'audit_sha256' and size_bytes=(p_input->>'audit_size_bytes')::bigint and metadata->'native_signature'=receipt;
  end if;
  if audit_doc is null then raise exception 'native_audit_document_conflict'; end if;
  insert into public.signing_documents(tenant_id,envelope_id,contract_document_id,document_role,sha256)
    values(e.tenant_id,e.id,audit_doc,'provider_evidence',p_input->>'audit_sha256') on conflict(envelope_id,document_role) do nothing;
  select id into signer from public.signing_recipients where tenant_id=e.tenant_id and envelope_id=e.id and required;
  if signer is null then raise exception 'native_signing_recipient_missing'; end if;
  update public.signing_recipients set status='signed',signed_at=(receipt->>'accepted_at')::timestamptz where id=signer and tenant_id=e.tenant_id;
  update public.signing_attempts set status='completed',completed_at=now() where tenant_id=e.tenant_id and envelope_id=e.id;
  insert into public.signing_events(tenant_id,envelope_id,signing_recipient_id,provider,provider_event_id,event_type,event_at,verified,payload,processing_status)
    values(e.tenant_id,e.id,signer,'kundexa_native','native-signature/'||(receipt->>'receipt_id'),'signature.completed',
      (receipt->>'accepted_at')::timestamptz,true,receipt,'processed') on conflict(provider,provider_event_id) do nothing;
  result:=public.finalize_signing_envelope(e.id,signed_doc,
    (e.provider_evidence-'public_token_hash'-'public_token_ciphertext')||jsonb_build_object('native_finalization',binding,'provider_audit_document_id',audit_doc,'provider_audit_sha256',p_input->>'audit_sha256'));
  -- Keep the private capability binding in the envelope, not the shareable
  -- evidence manifest produced by the generic finalizer above.
  update public.signing_envelopes set provider_evidence=e.provider_evidence||jsonb_build_object('native_finalization',binding,
    'provider_audit_document_id',audit_doc,'provider_audit_sha256',p_input->>'audit_sha256') where id=e.id;
  return result;
end $$;
revoke all on function public.finalize_native_signature(jsonb) from public,anon,authenticated;
grant execute on function public.finalize_native_signature(jsonb) to service_role;

create or replace function private.protect_claimed_native_signature() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if old.provider='kundexa_native' and old.provider_evidence->'native_signature' is not null then
    if new.provider_evidence->'native_signature' is distinct from old.provider_evidence->'native_signature'
      or new.status in ('cancelled','declined','expired','failed') then raise exception 'native_signature_already_claimed'; end if;
  end if;
  return new;
end $$;
revoke all on function private.protect_claimed_native_signature() from public,anon,authenticated;
create trigger signing_envelopes_native_receipt_immutable before update on public.signing_envelopes
for each row execute function private.protect_claimed_native_signature();

create or replace function private.protect_native_contract_cancellation() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if new.status='cancelled' and old.status<>'cancelled' and exists(select 1 from public.signing_envelopes e
    where e.tenant_id=new.tenant_id and e.contract_id=new.id and e.provider='kundexa_native'
      and e.status in ('draft','creating','sent','partially_signed')) then raise exception 'native_signing_cancellation_required'; end if;
  return new;
end $$;
revoke all on function private.protect_native_contract_cancellation() from public,anon,authenticated;
create trigger contracts_native_cancellation_guard before update on public.contracts
for each row execute function private.protect_native_contract_cancellation();

update storage.buckets set allowed_mime_types=case when allowed_mime_types is null then null
  else array(select distinct unnest(allowed_mime_types||array['image/png'])) end
where id='contract-documents';

-- Forward-only policy transition: new/revised external signing templates select
-- Kundexa's embedded implementation. Approved legacy DocuSeal rows stay intact.
do $$ declare definition text; begin
  select pg_get_functiondef('public.validate_pdf_template_policy()'::regprocedure) into definition;
  definition:=replace(definition,
    $old$cfg->>'provider_key' is distinct from 'docuseal'$old$,
    $new$(cfg->>'provider_key' is distinct from 'kundexa_native' and not
      (tg_op='UPDATE' and old.status='approved' and cfg is not distinct from old.signing_configuration and cfg->>'provider_key'='docuseal'))$new$);
  if position('kundexa_native' in definition)=0 then raise exception 'native_template_policy_patch_failed'; end if;
  execute definition;
end $$;
create or replace function public.expire_native_signing(p_envelope_id uuid)
returns boolean language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare e public.signing_envelopes%rowtype;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_required'; end if;
  select * into e from public.signing_envelopes where id=p_envelope_id and provider='kundexa_native' for update;
  if not found then raise exception 'native_signing_not_found'; end if;
  if e.status not in ('creating','sent','partially_signed') or e.provider_evidence->'native_signature' is not null
    or (e.provider_evidence->>'expires_at')::timestamptz>now() then return false; end if;
  perform 1 from public.contracts where tenant_id=e.tenant_id and id=e.contract_id for update;
  update public.signing_envelopes set status='expired' where id=e.id;
  update public.signing_recipients set status='expired' where tenant_id=e.tenant_id and envelope_id=e.id and status<>'signed';
  update public.signing_attempts set status='expired',completed_at=now() where tenant_id=e.tenant_id and envelope_id=e.id and status in ('created','started');
  update public.contract_recipients set status='expired' where tenant_id=e.tenant_id and contract_id=e.contract_id and generation=e.generation and status<>'signed';
  update public.contracts set status='expired' where tenant_id=e.tenant_id and id=e.contract_id
    and active_version_id=e.contract_version_id and acceptance_generation=e.generation and status='signing';
  insert into public.contract_events(tenant_id,contract_id,event_type,payload)
    values(e.tenant_id,e.contract_id,'signing.native_expired',jsonb_build_object('envelope_id',e.id,'generation',e.generation));
  return true;
end $$;
revoke all on function public.expire_native_signing(uuid) from public,anon,authenticated;
grant execute on function public.expire_native_signing(uuid) to service_role;

commit;
