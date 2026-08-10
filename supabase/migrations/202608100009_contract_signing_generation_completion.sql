begin;

-- Generation-aware terminal guards. Historical/superseded recipients must never
-- block the current contract generation.
create or replace function public.protect_contract_signing_projection()
returns trigger
language plpgsql
set search_path=public
as $$
begin
  if new.status='accepted' and exists(
    select 1 from public.contract_recipients r
    where r.tenant_id=new.tenant_id
      and r.contract_id=new.id
      and r.generation=new.acceptance_generation
      and r.required
      and r.status<>'signed'
  ) then
    new.status:='signing';
  end if;

  if new.status='signed' and old.status<>'signed' then
    if exists(
      select 1 from public.contract_recipients r
      where r.tenant_id=new.tenant_id
        and r.contract_id=new.id
        and r.generation=new.acceptance_generation
        and r.required
        and r.status<>'signed'
    ) then raise exception 'required_contract_recipients_incomplete'; end if;

    if not exists(
      select 1 from public.signing_envelopes e
      where e.tenant_id=new.tenant_id
        and e.contract_id=new.id
        and e.contract_version_id=new.active_version_id
        and e.generation=new.acceptance_generation
        and e.status='completed'
        and e.final_document_id is not null
    ) then raise exception 'completed_current_signing_envelope_required'; end if;
  end if;
  return new;
end $$;

-- External/provider signing completion is generation-bound and creates a
-- completed evidence manifest before the contract can be activated.
create or replace function public.finalize_signing_envelope(
  p_envelope_id uuid,
  p_final_document_id uuid,
  p_provider_evidence jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_envelope public.signing_envelopes%rowtype;
  v_document public.contract_documents%rowtype;
  v_contract public.contracts%rowtype;
  v_version public.contract_versions%rowtype;
  v_manifest jsonb;
  v_manifest_hash text;
  v_now timestamptz:=now();
begin
  if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;

  select * into v_envelope
  from public.signing_envelopes
  where id=p_envelope_id
  for update;
  if not found then raise exception 'signing_envelope_not_found'; end if;

  select * into v_contract
  from public.contracts
  where tenant_id=v_envelope.tenant_id and id=v_envelope.contract_id
  for update;
  if not found then raise exception 'contract_not_found'; end if;
  if v_contract.active_version_id is distinct from v_envelope.contract_version_id then
    raise exception 'active_contract_version_changed';
  end if;
  if v_envelope.generation<>v_contract.acceptance_generation then
    raise exception 'signing_envelope_generation_superseded';
  end if;

  -- Provider callbacks are retried. A completed envelope must therefore replay
  -- idempotently instead of creating duplicate evidence/events/outbox work.
  if v_envelope.status='completed' then
    if v_envelope.final_document_id is distinct from p_final_document_id then
      raise exception 'completed_envelope_document_mismatch';
    end if;
    select * into v_document
    from public.contract_documents
    where tenant_id=v_envelope.tenant_id
      and id=p_final_document_id
      and contract_id=v_envelope.contract_id
      and contract_version_id=v_envelope.contract_version_id
      and document_type='signed_pdf'
      and mime_type='application/pdf';
    if not found or nullif(v_document.sha256,'') is null or coalesce(v_document.size_bytes,0)<=0 then
      raise exception 'final_signed_document_invalid';
    end if;
    select ep.manifest_hash into v_manifest_hash
    from public.evidence_packages ep
    where ep.tenant_id=v_contract.tenant_id
      and ep.contract_id=v_contract.id
      and ep.contract_version_id=v_contract.active_version_id
      and ep.status='completed'
      and coalesce((ep.manifest->>'generation')::integer,0)=v_envelope.generation
      and ep.manifest->'signing_envelope'->>'id'=v_envelope.id::text
    order by ep.generated_at desc nulls last,ep.created_at desc
    limit 1;
    return jsonb_build_object(
      'contract_id',v_contract.id,
      'status',v_contract.status,
      'generation',v_envelope.generation,
      'document_sha256',v_document.sha256,
      'evidence_manifest_hash',v_manifest_hash,
      'idempotent_replay',true
    );
  end if;
  if v_envelope.status in ('declined','expired','cancelled','failed') then
    raise exception 'signing_envelope_terminal';
  end if;

  select * into v_version
  from public.contract_versions
  where tenant_id=v_contract.tenant_id
    and contract_id=v_contract.id
    and id=v_contract.active_version_id
  for update;
  if not found then raise exception 'active_contract_version_not_found'; end if;

  if v_version.signature_policy_snapshot is not null
     and v_envelope.signature_policy is distinct from v_version.signature_policy_snapshot then
    raise exception 'signature_policy_snapshot_mismatch';
  end if;
  if v_version.signature_policy_snapshot is null then
    update public.contract_versions
    set signature_policy_snapshot=v_envelope.signature_policy,
        locked_at=coalesce(locked_at,v_now)
    where tenant_id=v_contract.tenant_id and id=v_version.id;
    v_version.signature_policy_snapshot:=v_envelope.signature_policy;
  end if;

  if exists(
    select 1 from public.signing_recipients sr
    where sr.tenant_id=v_envelope.tenant_id
      and sr.envelope_id=v_envelope.id
      and sr.required
      and sr.status<>'signed'
  ) then raise exception 'required_signers_incomplete'; end if;

  if exists(
    select 1 from public.signing_events se
    where se.tenant_id=v_envelope.tenant_id
      and se.envelope_id=v_envelope.id
      and se.processing_status<>'ignored'
      and (not se.verified or se.processing_status<>'processed')
  ) then raise exception 'unverified_or_unprocessed_signing_events_present'; end if;

  if coalesce(v_envelope.signature_policy->>'method','simple_click')<>'simple_click'
     and not exists(
       select 1 from public.signing_events se
       where se.tenant_id=v_envelope.tenant_id
         and se.envelope_id=v_envelope.id
         and se.verified
         and se.processing_status='processed'
     ) then raise exception 'verified_provider_event_required'; end if;

  select * into v_document
  from public.contract_documents
  where tenant_id=v_envelope.tenant_id
    and id=p_final_document_id
    and contract_id=v_envelope.contract_id
    and contract_version_id=v_envelope.contract_version_id
    and document_type='signed_pdf'
    and mime_type='application/pdf';
  if not found or nullif(v_document.sha256,'') is null or coalesce(v_document.size_bytes,0)<=0 then
    raise exception 'final_signed_document_invalid';
  end if;

  update public.signing_envelopes
  set status='completed',
      final_document_id=p_final_document_id,
      provider_evidence=coalesce(p_provider_evidence,'{}'::jsonb),
      completed_at=coalesce(completed_at,v_now),
      updated_at=v_now
  where id=v_envelope.id;

  insert into public.signing_documents(
    tenant_id,envelope_id,contract_document_id,document_role,sha256
  ) values(
    v_envelope.tenant_id,v_envelope.id,p_final_document_id,'final_signed',v_document.sha256
  ) on conflict(envelope_id,document_role) do update
    set contract_document_id=excluded.contract_document_id,sha256=excluded.sha256;

  -- Provider recipients project onto the canonical recipients only for this envelope.
  update public.contract_recipients cr
  set status='signed',
      signed_at=coalesce(cr.signed_at,sr.signed_at,v_now),
      identity_assurance_level=case
        when cr.identity_assurance_level='high' or sr.identity_assurance_level='high' then 'high'
        when cr.identity_assurance_level='substantial' or sr.identity_assurance_level='substantial' then 'substantial'
        else 'low'
      end
  from public.signing_recipients sr
  where sr.tenant_id=v_envelope.tenant_id
    and sr.envelope_id=v_envelope.id
    and sr.contract_recipient_id=cr.id
    and sr.status='signed'
    and cr.tenant_id=v_envelope.tenant_id
    and cr.contract_id=v_envelope.contract_id
    and cr.generation=v_envelope.generation;

  if exists(
    select 1 from public.contract_recipients cr
    where cr.tenant_id=v_envelope.tenant_id
      and cr.contract_id=v_envelope.contract_id
      and cr.generation=v_envelope.generation
      and cr.required
      and cr.status<>'signed'
  ) then raise exception 'required_contract_recipients_incomplete'; end if;

  v_manifest:=jsonb_build_object(
    'schema','kundexa.provider-evidence.v3',
    'generated_at',v_now,
    'tenant_id',v_contract.tenant_id,
    'contract_id',v_contract.id,
    'contract_version_id',v_contract.active_version_id,
    'generation',v_contract.acceptance_generation,
    'source_call_id',v_contract.source_call_id,
    'source_call_eligibility_snapshot',v_contract.source_call_eligibility_snapshot,
    'source_call_eligibility_locked_at',v_contract.source_call_eligibility_locked_at,
    'signature_policy',v_version.signature_policy_snapshot,
    'signing_envelope',jsonb_build_object(
      'id',v_envelope.id,
      'provider',v_envelope.provider,
      'provider_envelope_id',v_envelope.provider_envelope_id,
      'provider_evidence',coalesce(p_provider_evidence,'{}'::jsonb)
    ),
    'final_document',jsonb_build_object(
      'id',v_document.id,
      'sha256',v_document.sha256,
      'size_bytes',v_document.size_bytes,
      'mime_type',v_document.mime_type
    ),
    'signing_events',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',se.id,'provider_event_id',se.provider_event_id,'event_type',se.event_type,
        'event_at',se.event_at,'verified',se.verified,'processing_status',se.processing_status
      ) order by se.event_at,se.id)
      from public.signing_events se
      where se.tenant_id=v_envelope.tenant_id and se.envelope_id=v_envelope.id
    ),'[]'::jsonb)
  );
  v_manifest_hash:=encode(digest(v_manifest::text,'sha256'),'hex');

  insert into public.evidence_packages(
    tenant_id,contract_id,contract_version_id,acceptance_id,status,manifest,manifest_hash,
    storage_path,generated_at,canonical_document_id,canonical_document_sha256
  ) values(
    v_contract.tenant_id,v_contract.id,v_contract.active_version_id,null,'completed',
    v_manifest,v_manifest_hash,v_document.storage_path,v_now,v_document.id,v_document.sha256
  );

  update public.contracts
  set status='signed',signed_at=coalesce(signed_at,v_now),updated_at=v_now
  where tenant_id=v_contract.tenant_id and id=v_contract.id;

  insert into public.contract_events(tenant_id,contract_id,event_type,payload)
  values(v_contract.tenant_id,v_contract.id,'contract.signed',jsonb_build_object(
    'envelope_id',v_envelope.id,'generation',v_envelope.generation,
    'final_document_id',v_document.id,'sha256',v_document.sha256,'evidence_manifest_hash',v_manifest_hash
  ));
  insert into public.audit_logs(tenant_id,action,entity_type,entity_id,after_data)
  values(v_contract.tenant_id,'contract.signed','contract',v_contract.id::text,jsonb_build_object(
    'envelope_id',v_envelope.id,'generation',v_envelope.generation,'final_document_id',v_document.id,
    'document_sha256',v_document.sha256,'evidence_manifest_hash',v_manifest_hash
  ));
  insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key,priority)
  values(v_contract.tenant_id,'contract.signed.confirmation','contract',v_contract.id,
    jsonb_build_object('contract_id',v_contract.id,'envelope_id',v_envelope.id,'generation',v_envelope.generation,'final_document_id',v_document.id),
    'contract.signed.confirmation:'||v_contract.id::text||':'||v_envelope.generation::text,30)
  on conflict(tenant_id,idempotency_key) do nothing;

  return jsonb_build_object(
    'contract_id',v_contract.id,'status','signed','generation',v_envelope.generation,
    'document_sha256',v_document.sha256,'evidence_manifest_hash',v_manifest_hash
  );
end $$;
revoke all on function public.finalize_signing_envelope(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.finalize_signing_envelope(uuid,uuid,jsonb) to service_role;

-- Activation is the only place that starts the customer/post-sign lifecycle,
-- regardless of whether completion came from web/SMS/OTP or an external signer.
create or replace function public.activate_completed_contract(p_contract_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_user uuid:=auth.uid();
  v_contract public.contracts%rowtype;
  v_version public.contract_versions%rowtype;
  v_policy jsonb;
  v_method text;
  v_now timestamptz:=now();
  v_final_document uuid;
  v_envelope uuid;
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin','contract_manager']) then raise exception 'contract_activate_permission_required'; end if;

  select * into v_contract from public.contracts
  where tenant_id=v_tenant and id=p_contract_id
  for update;
  if not found then raise exception 'contract_not_found'; end if;
  if not public.can_access_contract(v_contract.id) then raise exception 'contract_access_denied'; end if;
  if v_contract.status='active' then
    return jsonb_build_object('contract_id',v_contract.id,'status','active','already_active',true);
  end if;
  if v_contract.status not in ('accepted','signed') then raise exception 'contract_not_completed:%',v_contract.status; end if;

  select * into v_version from public.contract_versions
  where tenant_id=v_tenant and id=v_contract.active_version_id and contract_id=v_contract.id;
  if not found or v_version.locked_at is null then raise exception 'locked_contract_version_required'; end if;
  v_policy:=coalesce(v_version.signature_policy_snapshot,'{"method":"simple_click","identityAssuranceLevel":"low","orderedSigning":false,"requireFinalProviderDocument":false}'::jsonb);
  v_method:=coalesce(v_policy->>'method','simple_click');

  if exists(
    select 1 from public.contract_recipients r
    where r.tenant_id=v_tenant and r.contract_id=v_contract.id
      and r.generation=v_contract.acceptance_generation and r.required and r.status<>'signed'
  ) then raise exception 'required_contract_recipients_incomplete'; end if;

  if not exists(
    select 1 from public.evidence_packages e
    where e.tenant_id=v_tenant and e.contract_id=v_contract.id
      and e.contract_version_id=v_contract.active_version_id and e.status='completed'
      and (
        e.manifest->>'generation'=v_contract.acceptance_generation::text
        or (v_contract.acceptance_generation=0 and not (coalesce(e.manifest,'{}'::jsonb) ? 'generation'))
      )
  ) then raise exception 'completed_current_evidence_package_required'; end if;

  if coalesce((v_policy->>'requireFinalProviderDocument')::boolean,false) or v_method in ('bankid','external_esign') then
    select e.id,e.final_document_id into v_envelope,v_final_document
    from public.signing_envelopes e
    where e.tenant_id=v_tenant and e.contract_id=v_contract.id
      and e.contract_version_id=v_contract.active_version_id
      and e.generation=v_contract.acceptance_generation
      and e.status='completed' and e.final_document_id is not null
    order by e.completed_at desc nulls last limit 1;
    if v_final_document is null then raise exception 'completed_current_signing_envelope_required'; end if;
    if not exists(
      select 1 from public.contract_documents d
      where d.tenant_id=v_tenant and d.id=v_final_document and d.contract_id=v_contract.id
        and d.contract_version_id=v_contract.active_version_id and d.document_type='signed_pdf'
        and d.mime_type='application/pdf' and nullif(d.sha256,'') is not null and coalesce(d.size_bytes,0)>0
    ) then raise exception 'final_signed_document_hash_required'; end if;
    if exists(
      select 1 from public.signing_events se
      where se.tenant_id=v_tenant and se.envelope_id=v_envelope
        and se.processing_status<>'ignored' and (not se.verified or se.processing_status<>'processed')
    ) then raise exception 'unresolved_signing_events_present'; end if;
  end if;

  update public.contracts
  set status='active',activated_at=coalesce(activated_at,v_now),updated_at=v_now
  where tenant_id=v_tenant and id=v_contract.id;
  update public.customers set lifecycle='customer',updated_at=v_now
  where tenant_id=v_tenant and id=v_contract.customer_id and lifecycle in ('prospect','lead');
  update public.customer_list_members
  set state='completed',claim_expires_at=null,claimed_by=null,updated_at=v_now
  where tenant_id=v_tenant and customer_id=v_contract.customer_id and state not in ('completed','blocked');
  update public.contract_reminders
  set status='cancelled',cancelled_at=v_now,cancel_reason='contract_activated'
  where tenant_id=v_tenant and contract_id=v_contract.id and status in ('scheduled','queued');

  insert into public.activities(
    tenant_id,customer_id,contract_id,type,status,title,description,assigned_user_id,assigned_team_id,metadata
  ) values(
    v_tenant,v_contract.customer_id,v_contract.id,'onboarding','open','Starta kundonboarding',
    'Avtalet är aktiverat och kundonboarding ska genomföras.',v_contract.owner_user_id,v_contract.team_id,
    jsonb_build_object('post_sign_contract_id',v_contract.id,'signing_envelope_id',v_envelope,'generation',v_contract.acceptance_generation)
  ) on conflict do nothing;

  insert into public.contract_events(tenant_id,contract_id,event_type,actor_user_id,payload)
  values(v_tenant,v_contract.id,'contract.activated',v_user,jsonb_build_object(
    'activated_at',v_now,'generation',v_contract.acceptance_generation,
    'signature_policy',v_policy,'final_document_id',v_final_document,'signing_envelope_id',v_envelope
  ));
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_user,'contract.activated','contract',v_contract.id::text,jsonb_build_object(
    'activated_at',v_now,'generation',v_contract.acceptance_generation,
    'signature_method',v_method,'final_document_id',v_final_document,'signing_envelope_id',v_envelope
  ));

  return jsonb_build_object('contract_id',v_contract.id,'status','active','activated_at',v_now);
end $$;
revoke all on function public.activate_completed_contract(uuid) from public,anon;
grant execute on function public.activate_completed_contract(uuid) to authenticated,service_role;

commit;
