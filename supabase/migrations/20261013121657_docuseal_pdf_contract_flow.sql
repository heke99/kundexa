begin;

-- A read scope is not a write permission.
drop policy if exists customers_scoped_update on public.customers;
create policy customers_scoped_update on public.customers for update to authenticated
using (public.has_current_role(array['owner','admin','team_lead','sales','backoffice'])
  and public.can_access_customer_row(id,tenant_id,assigned_user_id,created_by,assigned_team_id))
with check (tenant_id=public.current_tenant_id()
  and public.has_current_role(array['owner','admin','team_lead','sales','backoffice'])
  and public.can_access_customer_row(id,tenant_id,assigned_user_id,created_by,assigned_team_id));
drop policy if exists customers_tenant_insert on public.customers;
drop policy if exists customers_scoped_insert on public.customers;
create policy customers_scoped_insert on public.customers for insert to authenticated
with check (tenant_id=public.current_tenant_id()
  and public.has_current_role(array['owner','admin','team_lead','sales','backoffice']));

-- Invoker trigger: direct REST writes retain current_user=authenticated; the
-- narrowly authorized SECURITY DEFINER transitions run as their owner.
create function public.guard_contract_system_fields() returns trigger
language plpgsql set search_path=public as $$
begin
  if current_user in ('anon','authenticated') then
    if tg_table_name='contracts' then
      if new.status is distinct from old.status or new.acceptance_generation is distinct from old.acceptance_generation
       or new.signed_at is distinct from old.signed_at or new.activated_at is distinct from old.activated_at then
        raise exception 'controlled_contract_transition_required';
      end if;
    elsif tg_table_name='contract_recipients' then
      if new.status is distinct from old.status or new.required is distinct from old.required
       or new.generation is distinct from old.generation or new.signed_at is distinct from old.signed_at then
        raise exception 'controlled_recipient_transition_required';
      end if;
    end if;
  end if;
  return new;
end $$;
create trigger contracts_system_fields_guard before update on public.contracts
for each row execute function public.guard_contract_system_fields();
create trigger recipients_system_fields_guard before update on public.contract_recipients
for each row execute function public.guard_contract_system_fields();

create function public.bind_contract_version_policy() returns trigger
language plpgsql set search_path=public as $$
declare v_policy jsonb;
begin
 if current_user in ('anon','authenticated') and
   (tg_op='INSERT' or new.signature_policy_snapshot is distinct from old.signature_policy_snapshot) then
   raise exception 'controlled_contract_version_required';
 end if;
 if new.template_version_id is not null and new.signature_policy_snapshot is null then
   select signature_policy into v_policy from public.contract_template_versions
     where tenant_id=new.tenant_id and id=new.template_version_id and status='approved';
   if not found then raise exception 'approved_template_required'; end if;
   new.signature_policy_snapshot:=v_policy;
 end if;
 return new;
end $$;
create trigger contract_version_policy_binding before insert or update on public.contract_versions
for each row execute function public.bind_contract_version_policy();

-- Checking inside v3 also protects direct RPC calls, not merely hidden inputs.
do $$
declare v_definition text; v_signature text; v_anchor text := '  v_contract := public.create_contract_draft_v2(';
begin
 v_signature:='public.create_contract_draft_v3(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text,text,jsonb,jsonb,uuid,uuid,date,date,integer,integer,numeric,text,timestamptz)';
 v_definition:=pg_get_functiondef(v_signature::regprocedure);
 if position(v_anchor in v_definition)=0 then raise exception 'commercial_guard_anchor_missing'; end if;
 v_definition:=replace(v_definition,v_anchor,$guard$
  if not public.has_current_role(array['owner','admin','contract_manager']) then
    if not exists(select 1 from public.product_price_versions pv where pv.tenant_id=v_tenant and pv.id=p_price_version_id and pv.product_id=p_product_id and pv.active
      and p_binding_months is not distinct from pv.binding_months
      and p_notice_months is not distinct from pv.notice_months
      and p_currency=pv.currency and coalesce(p_contract_value,pv.recurring_fee)=pv.recurring_fee
      and (p_commercial_terms->>'recurring_fee')::numeric=pv.recurring_fee
      and (p_commercial_terms->>'setup_fee')::numeric=pv.setup_fee
      and (p_commercial_terms->>'payment_terms_days')::integer is not distinct from pv.payment_terms_days
      and coalesce(p_commercial_terms->'additional_terms','{}'::jsonb)=coalesce(pv.terms,'{}'::jsonb))
      then raise exception 'commercial_override_permission_required'; end if;
  end if;
  v_contract := public.create_contract_draft_v2($guard$);
 execute v_definition;
end $$;

create table public.contract_signing_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  envelope_id uuid not null,
  recipient_id uuid not null,
  token_hash text not null unique check(length(token_hash)=64),
  token_ciphertext text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique(tenant_id,id), unique(envelope_id,recipient_id),
  foreign key(tenant_id,envelope_id) references public.signing_envelopes(tenant_id,id),
  foreign key(tenant_id,recipient_id) references public.contract_recipients(tenant_id,id)
);
alter table public.contract_signing_links enable row level security;
-- Tokens and their encrypted values are service-only. Seller access goes through
-- the existing contract/document RLS, never through token enumeration.
revoke all on public.contract_signing_links from public,anon,authenticated;
grant all on public.contract_signing_links to service_role;
create index contract_signing_links_envelope_idx on public.contract_signing_links(tenant_id,envelope_id);
create unique index docuseal_envelope_generation_uidx on public.signing_envelopes(tenant_id,contract_id,contract_version_id,generation)
where provider='docuseal';

create function public.save_pdf_template_configuration(p_version_id uuid,p_configuration jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_template uuid;
begin
  if auth.uid() is null or v_tenant is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin','contract_manager','team_lead']) then
    raise exception 'contract_template_permission_required'; end if;
  select template_id into v_template from public.contract_template_versions
    where tenant_id=v_tenant and id=p_version_id and status='draft' for update;
  if not found then raise exception 'draft_template_required'; end if;
  if p_configuration->>'mode'<>'pdf' or p_configuration->>'provider'<>'docuseal'
    or coalesce(p_configuration->>'template_id','')!~'^[1-9][0-9]*$'
    or coalesce(p_configuration->>'schema_hash','')!~'^[a-f0-9]{64}$'
    or jsonb_typeof(p_configuration->'bindings')<>'array' then raise exception 'invalid_pdf_template_configuration'; end if;
  update public.contract_template_versions set
    signing_configuration=jsonb_set(signing_configuration,'{pdf}',p_configuration),
    signature_policy='{"method":"external_esign","identityAssuranceLevel":"low","orderedSigning":false,"requireFinalProviderDocument":true}'::jsonb
    where tenant_id=v_tenant and id=p_version_id;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_tenant,auth.uid(),'contract_template.pdf_configured','contract_template_version',p_version_id::text,
      jsonb_build_object('schema_hash',p_configuration->>'schema_hash','template_id',v_template));
end $$;
revoke all on function public.save_pdf_template_configuration(uuid,jsonb) from public,anon;
grant execute on function public.save_pdf_template_configuration(uuid,jsonb) to authenticated;

create function public.prepare_docuseal_signing(
 p_contract_id uuid,p_document_id uuid,p_recipient_name text,p_email text,p_expires_at timestamptz,
 p_token_hash text,p_token_ciphertext text,p_idempotency_key text,p_request_hash text,
 p_actor_user_id uuid default null,p_tenant_id uuid default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
 v_tenant uuid; v_actor uuid; v_contract public.contracts%rowtype;
 v_version public.contract_versions%rowtype; v_document public.contract_documents%rowtype;
 v_envelope uuid; v_recipient uuid; v_generation integer; v_prior public.outbox_jobs%rowtype;
 v_policy jsonb; v_eligibility jsonb;
begin
 if auth.role()='service_role' then
   v_tenant:=p_tenant_id; v_actor:=p_actor_user_id;
   if not exists(select 1 from public.tenant_memberships m join public.tenants t on t.id=m.tenant_id
     where m.tenant_id=v_tenant and m.user_id=v_actor and m.status='active'
       and m.role in ('owner','admin') and t.status in ('active','trial') and t.onboarding_status='active')
     then raise exception 'active_api_actor_required'; end if;
   perform set_config('request.jwt.claim.sub',v_actor::text,true);
   perform set_config('app.kundexa_tenant_id',v_tenant::text,true);
 else
   v_tenant:=public.current_tenant_id(); v_actor:=auth.uid();
   if p_tenant_id is not null or p_actor_user_id is not null then raise exception 'service_context_only'; end if;
 end if;
 if v_actor is null or v_tenant is null or not public.has_current_role(array['owner','admin','team_lead','sales','contract_manager'])
   then raise exception 'contract_send_permission_required'; end if;
 select * into v_contract from public.contracts where tenant_id=v_tenant and id=p_contract_id for update;
 if not found or not public.can_access_contract(p_contract_id) then raise exception 'contract_access_denied'; end if;
 select * into v_prior from public.outbox_jobs where tenant_id=v_tenant
   and idempotency_key='docuseal.send:'||p_idempotency_key;
 if found then
   if v_prior.aggregate_id<>p_contract_id or v_prior.payload->>'request_hash' is distinct from p_request_hash then
     raise exception 'idempotency_payload_conflict'; end if;
   return v_prior.payload || jsonb_build_object('idempotent_replay',true);
 end if;
 if v_contract.status not in ('draft','ready','sent','viewed','signing','expired') then raise exception 'contract_not_sendable'; end if;
 if p_expires_at<=now() or p_expires_at>now()+interval '90 days' then raise exception 'invalid_signing_expiry'; end if;
 if length(p_recipient_name)<2 or p_email!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
   or p_token_hash!~'^[a-f0-9]{64}$' or length(p_idempotency_key) not between 8 and 200 then raise exception 'invalid_signing_input'; end if;
 select * into v_version from public.contract_versions where tenant_id=v_tenant and id=v_contract.active_version_id;
 v_policy:=v_version.signature_policy_snapshot;
 if v_policy->>'method' is distinct from 'external_esign' then raise exception 'external_signature_policy_required'; end if;
 if v_contract.source_call_id is null then raise exception 'source_call_required'; end if;
 v_eligibility:=public.get_contract_call_eligibility(v_contract.customer_id,v_contract.source_call_id);
 if coalesce((v_eligibility->>'eligible')::boolean,false)=false then raise exception 'source_call_not_eligible'; end if;
 select * into v_document from public.contract_documents where tenant_id=v_tenant and id=p_document_id
   and contract_id=p_contract_id and contract_version_id=v_version.id and metadata->>'canonical'='true';
 if not found or v_document.metadata->>'provider'<>'docuseal' then raise exception 'docuseal_canonical_document_required'; end if;
 if not exists(select 1 from public.tenant_features where tenant_id=v_tenant and feature_key='contract_delivery_email' and enabled)
   or not exists(select 1 from public.tenant_features where tenant_id=v_tenant and feature_key='outbound_email' and enabled)
   then raise exception 'email_delivery_disabled'; end if;
 v_generation:=v_contract.acceptance_generation+1;
 update public.signing_envelopes set status='cancelled',cancelled_at=now()
   where tenant_id=v_tenant and contract_id=p_contract_id and status not in ('completed','declined','expired','cancelled','failed');
 update public.contract_signing_links l set revoked_at=now() from public.signing_envelopes e
   where e.tenant_id=v_tenant and e.contract_id=p_contract_id and l.envelope_id=e.id and l.revoked_at is null;
 insert into public.contract_recipients(tenant_id,contract_id,full_name,email,generation,status,required)
   values(v_tenant,p_contract_id,p_recipient_name,p_email,v_generation,'pending',true) returning id into v_recipient;
 insert into public.signing_envelopes(tenant_id,contract_id,contract_version_id,provider,signature_policy,generation,status,created_by,provider_evidence)
   values(v_tenant,p_contract_id,v_version.id,'docuseal',v_policy,v_generation,'creating',v_actor,
     jsonb_build_object('source_document_id',v_document.id,'source_sha256',v_document.sha256,'expires_at',p_expires_at,
       'template',v_document.metadata->'pdf_template','values',v_document.metadata->'field_values')) returning id into v_envelope;
 insert into public.signing_recipients(tenant_id,envelope_id,contract_recipient_id,role,required)
   values(v_tenant,v_envelope,v_recipient,'signer',true);
 insert into public.contract_signing_links(tenant_id,envelope_id,recipient_id,token_hash,token_ciphertext,expires_at)
   values(v_tenant,v_envelope,v_recipient,p_token_hash,p_token_ciphertext,p_expires_at);
 update public.contract_versions set locked_at=coalesce(locked_at,now()) where tenant_id=v_tenant and id=v_version.id;
 update public.contracts set status='signing',acceptance_generation=v_generation,expires_at=p_expires_at,
   source_call_eligibility_snapshot=v_eligibility,source_call_eligibility_locked_at=coalesce(source_call_eligibility_locked_at,now())
   where tenant_id=v_tenant and id=p_contract_id;
 insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key,priority)
   values(v_tenant,'docuseal.send','contract',p_contract_id,
     jsonb_build_object('envelope_id',v_envelope,'contract_id',p_contract_id,'generation',v_generation,'request_hash',p_request_hash),
     'docuseal.send:'||p_idempotency_key,20);
 insert into public.contract_events(tenant_id,contract_id,event_type,actor_user_id,payload)
   values(v_tenant,p_contract_id,'signing.queued',v_actor,jsonb_build_object('envelope_id',v_envelope,'generation',v_generation));
 return jsonb_build_object('envelope_id',v_envelope,'contract_id',p_contract_id,'generation',v_generation,'idempotent_replay',false);
end $$;
revoke all on function public.prepare_docuseal_signing(uuid,uuid,text,text,timestamptz,text,text,text,text,uuid,uuid) from public,anon;
grant execute on function public.prepare_docuseal_signing(uuid,uuid,text,text,timestamptz,text,text,text,text,uuid,uuid) to authenticated,service_role;

-- Reclaim stale leases. Completion/failure must prove the claiming worker.
create or replace function public.claim_outbox_jobs(p_worker text,p_limit integer default 25)
returns setof public.outbox_jobs language plpgsql security definer set search_path=public as $$
begin
 update public.outbox_jobs set status=case when attempts>=max_attempts then 'dead_letter'::public.job_status else 'failed'::public.job_status end,
   locked_at=null,locked_by=null,last_error='worker_lease_expired',available_at=now()
   where status='processing' and locked_at<now()-interval '10 minutes';
 return query with picked as (
   select id from public.outbox_jobs where status in ('pending','failed') and available_at<=now() and attempts<max_attempts
   order by priority,created_at for update skip locked limit greatest(1,least(p_limit,100))
 ) update public.outbox_jobs j set status='processing',locked_at=now(),locked_by=p_worker,attempts=j.attempts+1
 from picked where j.id=picked.id returning j.*;
end $$;
create function public.settle_outbox_job(p_job_id uuid,p_worker text,p_error text default null,p_permanent boolean default false,p_delay_seconds integer default 60)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 update public.outbox_jobs set
   status=case when p_error is null then 'completed'::public.job_status when p_permanent or attempts>=max_attempts then 'dead_letter'::public.job_status else 'failed'::public.job_status end,
   completed_at=case when p_error is null then now() else completed_at end,last_error=left(p_error,4000),
   available_at=now()+make_interval(secs=>greatest(1,p_delay_seconds)),locked_at=null,locked_by=null
 where id=p_job_id and status='processing' and locked_by=p_worker;
 return found;
end $$;
revoke all on function public.settle_outbox_job(uuid,text,text,boolean,integer) from public,anon,authenticated;
grant execute on function public.settle_outbox_job(uuid,text,text,boolean,integer) to service_role;
do $$ begin
 if to_regclass('public.spatial_ref_sys') is not null then
   revoke insert,update,delete,truncate,references,trigger on public.spatial_ref_sys from anon,authenticated;
 end if;
end $$;

commit;
