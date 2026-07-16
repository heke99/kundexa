begin;

create table public.contract_templates (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null, contract_type text not null, audience text not null check(audience in ('B2B','B2C','BOTH')), active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(tenant_id,name), unique(tenant_id,id)
);
create table public.contract_template_versions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, template_id uuid not null, version integer not null,
  title_template text not null, body_template text not null, terms_template text, variables jsonb not null default '[]'::jsonb,
  signing_configuration jsonb not null default '{}'::jsonb, created_by uuid references auth.users(id), created_at timestamptz not null default now(),
  unique(template_id,version), unique(tenant_id,id), foreign key(tenant_id,template_id) references public.contract_templates(tenant_id,id) on delete cascade
);

create table public.contracts (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  contract_number text not null, customer_id uuid not null, deal_id uuid, template_id uuid, product_id uuid,
  owner_user_id uuid references auth.users(id), team_id uuid, campaign_id uuid, audience text not null check(audience in ('B2B','B2C')),
  status public.contract_status not null default 'draft', title text not null, value numeric not null default 0, currency text not null default 'SEK',
  starts_on date, ends_on date, renewal_on date, binding_months integer, notice_months integer, active_version_id uuid,
  signed_at timestamptz, terminated_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(tenant_id,contract_number), unique(tenant_id,id), foreign key(tenant_id,customer_id) references public.customers(tenant_id,id),
  foreign key(tenant_id,deal_id) references public.deals(tenant_id,id), foreign key(tenant_id,template_id) references public.contract_templates(tenant_id,id),
  foreign key(tenant_id,product_id) references public.products(tenant_id,id), foreign key(tenant_id,team_id) references public.teams(tenant_id,id),
  foreign key(tenant_id,campaign_id) references public.campaigns(tenant_id,id)
);

create table public.contract_versions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, contract_id uuid not null, version integer not null,
  template_version_id uuid, price_version_id uuid, title text not null, rendered_body text not null, rendered_terms text,
  commercial_terms jsonb not null default '{}'::jsonb, document_hash text not null, locked_at timestamptz,
  superseded_at timestamptz, created_by uuid references auth.users(id), created_at timestamptz not null default now(),
  unique(contract_id,version), unique(tenant_id,id), foreign key(tenant_id,contract_id) references public.contracts(tenant_id,id) on delete cascade,
  foreign key(tenant_id,template_version_id) references public.contract_template_versions(tenant_id,id),
  foreign key(tenant_id,price_version_id) references public.product_price_versions(tenant_id,id)
);
alter table public.contracts add foreign key(tenant_id,active_version_id) references public.contract_versions(tenant_id,id);

create table public.contract_documents (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, contract_id uuid not null, contract_version_id uuid,
  document_type text not null check(document_type in ('source_pdf','generated_pdf','signed_pdf','terms','attachment','evidence_pdf','manifest')),
  file_name text not null, storage_path text not null, mime_type text not null, size_bytes bigint, sha256 text not null,
  metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), unique(tenant_id,id),
  foreign key(tenant_id,contract_id) references public.contracts(tenant_id,id) on delete cascade,
  foreign key(tenant_id,contract_version_id) references public.contract_versions(tenant_id,id)
);
create table public.contract_recipients (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, contract_id uuid not null, full_name text not null,
  email citext, phone_e164 text, role text not null default 'signer', signing_order integer not null default 1,
  identity_number text, company_name text, organization_number text, created_at timestamptz not null default now(), unique(tenant_id,id),
  foreign key(tenant_id,contract_id) references public.contracts(tenant_id,id) on delete cascade
);
create table public.contract_deliveries (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, contract_id uuid not null, contract_version_id uuid not null,
  recipient_id uuid not null, channel text not null check(channel in ('sms','email','both')), status public.delivery_status not null default 'queued',
  sms_message_id uuid, email_message_id uuid, sent_at timestamptz, delivered_at timestamptz, opened_at timestamptz,
  created_at timestamptz not null default now(), unique(tenant_id,id), foreign key(tenant_id,contract_id) references public.contracts(tenant_id,id),
  foreign key(tenant_id,contract_version_id) references public.contract_versions(tenant_id,id),
  foreign key(tenant_id,recipient_id) references public.contract_recipients(tenant_id,id),
  foreign key(tenant_id,sms_message_id) references public.sms_messages(tenant_id,id),
  foreign key(tenant_id,email_message_id) references public.email_messages(tenant_id,id)
);

create table public.contract_acceptance_requests (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, contract_id uuid not null, contract_version_id uuid not null,
  recipient_id uuid not null, public_token_hash text not null, acceptance_code text, allowed_phrases text[] not null default '{JA,OK,GODKÄNNER,ACCEPTERAR}',
  decline_phrases text[] not null default '{NEJ,AVSTÅR}', require_code boolean not null default true, method public.acceptance_method not null,
  status public.acceptance_status not null default 'pending', expires_at timestamptz not null, call_id uuid, call_ended_at timestamptz,
  opened_at timestamptz, accepted_at timestamptz, created_at timestamptz not null default now(), unique(public_token_hash), unique(tenant_id,id),
  foreign key(tenant_id,contract_id) references public.contracts(tenant_id,id),
  foreign key(tenant_id,contract_version_id) references public.contract_versions(tenant_id,id),
  foreign key(tenant_id,recipient_id) references public.contract_recipients(tenant_id,id),
  foreign key(tenant_id,call_id) references public.calls(tenant_id,id)
);
create table public.contract_acceptances (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, request_id uuid not null, contract_id uuid not null,
  contract_version_id uuid not null, recipient_id uuid not null, method public.acceptance_method not null, status public.acceptance_status not null,
  raw_response text, normalized_response text, acceptance_phrase text, acceptance_code text, ip_address inet, user_agent text,
  provider_message_id text, evidence jsonb not null default '{}'::jsonb, accepted_at timestamptz, created_at timestamptz not null default now(),
  unique(tenant_id,request_id), unique(tenant_id,id), foreign key(tenant_id,request_id) references public.contract_acceptance_requests(tenant_id,id),
  foreign key(tenant_id,contract_id) references public.contracts(tenant_id,id),
  foreign key(tenant_id,contract_version_id) references public.contract_versions(tenant_id,id),
  foreign key(tenant_id,recipient_id) references public.contract_recipients(tenant_id,id)
);
create table public.contract_events (
  id bigint generated always as identity primary key, tenant_id uuid not null, contract_id uuid not null, event_type text not null,
  actor_user_id uuid references auth.users(id), occurred_at timestamptz not null default now(), payload jsonb not null default '{}'::jsonb,
  foreign key(tenant_id,contract_id) references public.contracts(tenant_id,id) on delete cascade
);
create table public.evidence_packages (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, contract_id uuid not null, contract_version_id uuid not null,
  acceptance_id uuid, status text not null default 'pending', manifest jsonb, manifest_hash text, storage_path text, generated_at timestamptz,
  created_at timestamptz not null default now(), unique(tenant_id,id), foreign key(tenant_id,contract_id) references public.contracts(tenant_id,id),
  foreign key(tenant_id,contract_version_id) references public.contract_versions(tenant_id,id),
  foreign key(tenant_id,acceptance_id) references public.contract_acceptances(tenant_id,id)
);

alter table public.sms_messages add foreign key(tenant_id,contract_id) references public.contracts(tenant_id,id);
alter table public.email_messages add foreign key(tenant_id,contract_id) references public.contracts(tenant_id,id);
alter table public.activities add foreign key(tenant_id,contract_id) references public.contracts(tenant_id,id) on delete cascade;

create table public.automation_rules (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null, description text, scope_type text not null default 'tenant', scope_id uuid, status public.automation_status not null default 'draft',
  trigger_key text not null, priority integer not null default 100, stop_on_match boolean not null default false, current_version integer not null default 1,
  created_by uuid references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(tenant_id,id)
);
create table public.automation_versions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, automation_id uuid not null, version integer not null,
  conditions jsonb not null default '[]'::jsonb, delay_config jsonb not null default '{}'::jsonb, actions jsonb not null default '[]'::jsonb,
  exceptions jsonb not null default '[]'::jsonb, limits jsonb not null default '{}'::jsonb, test_mode boolean not null default true,
  approved_by uuid references auth.users(id), created_by uuid references auth.users(id), created_at timestamptz not null default now(),
  unique(automation_id,version), unique(tenant_id,id), foreign key(tenant_id,automation_id) references public.automation_rules(tenant_id,id) on delete cascade
);
create table public.automation_runs (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, automation_id uuid not null, version_id uuid not null,
  trigger_event_id text not null, entity_type text, entity_id uuid, status public.job_status not null default 'pending',
  input jsonb not null default '{}'::jsonb, output jsonb, attempts integer not null default 0, started_at timestamptz,
  completed_at timestamptz, error text, created_at timestamptz not null default now(), unique(tenant_id,automation_id,trigger_event_id),
  foreign key(tenant_id,automation_id) references public.automation_rules(tenant_id,id),
  foreign key(tenant_id,version_id) references public.automation_versions(tenant_id,id)
);

create table public.compliance_blocks (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid, phone_e164 text, email citext, channels text[] not null default '{call,sms,email}', reason text not null,
  source text not null default 'internal', active boolean not null default true, expires_at timestamptz, created_by uuid references auth.users(id),
  created_at timestamptz not null default now(), unique(tenant_id,id), foreign key(tenant_id,customer_id) references public.customers(tenant_id,id)
);
create table public.consents (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, customer_id uuid not null, purpose text not null, legal_basis text not null,
  status text not null check(status in ('granted','withdrawn','objected','expired')), source text, evidence jsonb not null default '{}'::jsonb,
  granted_at timestamptz, withdrawn_at timestamptz, expires_at timestamptz, created_at timestamptz not null default now(), unique(tenant_id,id),
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id) on delete cascade
);
create table public.api_keys (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null, key_prefix text not null, key_hash text not null unique, scopes text[] not null default '{}', rate_limit_per_minute integer not null default 60,
  last_used_at timestamptz, expires_at timestamptz, revoked_at timestamptz, created_by uuid references auth.users(id), created_at timestamptz not null default now(), unique(tenant_id,id)
);
create table public.webhook_endpoints (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null, url text not null, secret_ciphertext text not null, subscribed_events text[] not null, active boolean not null default true,
  created_by uuid references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(tenant_id,id)
);
create table public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, endpoint_id uuid not null, event_type text not null,
  event_id text not null, payload jsonb not null, status public.job_status not null default 'pending', response_status integer,
  response_body text, attempts integer not null default 0, next_attempt_at timestamptz, created_at timestamptz not null default now(),
  unique(tenant_id,endpoint_id,event_id), foreign key(tenant_id,endpoint_id) references public.webhook_endpoints(tenant_id,id) on delete cascade
);
create table public.data_providers (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider text not null, name text not null, connection_id uuid, field_mapping jsonb not null default '{}'::jsonb,
  license_terms jsonb not null default '{}'::jsonb, status text not null default 'inactive', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(tenant_id,provider,name), unique(tenant_id,id), foreign key(tenant_id,connection_id) references public.tenant_integrations(tenant_id,id)
);
create table public.provider_usage_logs (
  id bigint generated always as identity primary key, tenant_id uuid not null, data_provider_id uuid not null, user_id uuid references auth.users(id),
  action text not null, purpose text, units numeric not null default 1, cost numeric, external_reference text, metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), foreign key(tenant_id,data_provider_id) references public.data_providers(tenant_id,id)
);

create or replace function public.prevent_locked_contract_version_update() returns trigger language plpgsql as $$
begin if old.locked_at is not null and row(new.title,new.rendered_body,new.rendered_terms,new.commercial_terms,new.document_hash) is distinct from row(old.title,old.rendered_body,old.rendered_terms,old.commercial_terms,old.document_hash) then raise exception 'locked_contract_version_is_immutable'; end if; return new; end $$;
create trigger contract_versions_lock before update on public.contract_versions for each row execute function public.prevent_locked_contract_version_update();

create or replace function public.prevent_tenant_move() returns trigger language plpgsql as $$ begin if new.tenant_id <> old.tenant_id then raise exception 'tenant_id_is_immutable'; end if; return new; end $$;

create trigger contracts_touch before update on public.contracts for each row execute function public.touch_updated_at();
create trigger templates_touch before update on public.contract_templates for each row execute function public.touch_updated_at();
create trigger automations_touch before update on public.automation_rules for each row execute function public.touch_updated_at();
create trigger webhook_endpoints_touch before update on public.webhook_endpoints for each row execute function public.touch_updated_at();
create trigger data_providers_touch before update on public.data_providers for each row execute function public.touch_updated_at();

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
('contract-documents','contract-documents',false,52428800,array['application/pdf']),
('call-recordings','call-recordings',false,524288000,array['audio/wav','audio/mpeg','audio/ogg']),
('imports','imports',false,52428800,array['text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict(id) do nothing;

commit;
