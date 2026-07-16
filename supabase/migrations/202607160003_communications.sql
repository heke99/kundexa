begin;

create table public.tenant_integrations (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider_type text not null, provider text not null, name text not null, credentials_ciphertext text,
  configuration jsonb not null default '{}'::jsonb, status text not null default 'inactive' check(status in ('inactive','active','error','revoked')),
  last_verified_at timestamptz, created_by uuid references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(tenant_id,provider_type,provider,name), unique(tenant_id,id)
);

create table public.phone_numbers (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  integration_id uuid, provider_number_id text, number_e164 text not null, country_code text not null default 'SE', status text not null default 'active',
  supports_voice boolean not null default false, supports_sms boolean not null default false, supports_mms boolean not null default false,
  webhook_token_hash text not null, assigned_user_id uuid references auth.users(id), assigned_team_id uuid, purpose text,
  last_synced_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(tenant_id,number_e164), unique(tenant_id,id),
  foreign key(tenant_id,integration_id) references public.tenant_integrations(tenant_id,id),
  foreign key(tenant_id,assigned_team_id) references public.teams(tenant_id,id)
);

create table public.call_queues (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null, strategy text not null default 'round_robin', max_wait_seconds integer not null default 120,
  overflow_queue_id uuid, voicemail_enabled boolean not null default true, configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(tenant_id,name), unique(tenant_id,id)
);
create table public.queue_members (
  tenant_id uuid not null, queue_id uuid not null, user_id uuid not null, priority integer not null default 100, paused boolean not null default false,
  primary key(queue_id,user_id), foreign key(tenant_id,queue_id) references public.call_queues(tenant_id,id) on delete cascade,
  foreign key(tenant_id,user_id) references public.tenant_memberships(tenant_id,user_id) on delete cascade
);

create table public.calls (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider_call_id text, customer_id uuid, campaign_id uuid, queue_id uuid, phone_number_id uuid, user_id uuid references auth.users(id),
  direction public.communication_direction not null, from_number text not null, to_number text not null,
  status text not null default 'queued' check(status in ('queued','initiating','ringing','answered','completed','busy','no_answer','failed','cancelled')),
  disposition text, notes text, started_at timestamptz, answered_at timestamptz, ended_at timestamptz,
  duration_seconds integer, wait_seconds integer, recording_enabled boolean not null default false, cost numeric, currency text default 'SEK',
  callback_token_hash text not null, metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(tenant_id,provider_call_id), unique(tenant_id,id),
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id),
  foreign key(tenant_id,campaign_id) references public.campaigns(tenant_id,id),
  foreign key(tenant_id,queue_id) references public.call_queues(tenant_id,id),
  foreign key(tenant_id,phone_number_id) references public.phone_numbers(tenant_id,id)
);
create index calls_tenant_created_idx on public.calls(tenant_id,created_at desc);

create table public.call_events (
  id bigint generated always as identity primary key, tenant_id uuid not null, call_id uuid not null,
  event_type text not null, provider_event_id text, occurred_at timestamptz not null default now(), payload jsonb not null default '{}'::jsonb,
  foreign key(tenant_id,call_id) references public.calls(tenant_id,id) on delete cascade,
  unique(tenant_id,provider_event_id)
);
create table public.call_recordings (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, call_id uuid not null, provider_recording_id text,
  storage_path text, sha256 text, mime_type text default 'audio/wav', duration_seconds integer, size_bytes bigint,
  retention_until timestamptz, status text not null default 'pending', created_at timestamptz not null default now(),
  unique(tenant_id,provider_recording_id), unique(tenant_id,id), foreign key(tenant_id,call_id) references public.calls(tenant_id,id) on delete cascade
);
create table public.recording_access_logs (
  id bigint generated always as identity primary key, tenant_id uuid not null, recording_id uuid not null, user_id uuid references auth.users(id),
  reason text not null, ip_address inet, created_at timestamptz not null default now(),
  foreign key(tenant_id,recording_id) references public.call_recordings(tenant_id,id) on delete cascade
);

create table public.sms_conversations (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid, phone_number_id uuid not null, external_number text not null, assigned_user_id uuid references auth.users(id), assigned_team_id uuid,
  status text not null default 'open', last_message_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(tenant_id,phone_number_id,external_number), unique(tenant_id,id),
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id), foreign key(tenant_id,phone_number_id) references public.phone_numbers(tenant_id,id),
  foreign key(tenant_id,assigned_team_id) references public.teams(tenant_id,id)
);
create table public.sms_messages (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid, customer_id uuid, contract_id uuid, provider_message_id text, direction public.communication_direction not null,
  from_number text not null, to_number text not null, body text not null, parts integer, status public.delivery_status not null default 'queued',
  cost numeric, currency text default 'SEK', error_code text, error_message text, sent_at timestamptz, delivered_at timestamptz,
  created_by uuid references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(tenant_id,provider_message_id), unique(tenant_id,id),
  foreign key(tenant_id,conversation_id) references public.sms_conversations(tenant_id,id) on delete cascade,
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id)
);
create index sms_messages_tenant_created_idx on public.sms_messages(tenant_id,created_at desc);
create table public.sms_delivery_events (
  id bigint generated always as identity primary key, tenant_id uuid not null, sms_message_id uuid not null, provider_event_id text,
  status text not null, occurred_at timestamptz not null default now(), payload jsonb not null default '{}'::jsonb,
  foreign key(tenant_id,sms_message_id) references public.sms_messages(tenant_id,id) on delete cascade,
  unique(tenant_id,provider_event_id)
);

create table public.email_messages (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid, contract_id uuid, provider_message_id text, direction public.communication_direction not null default 'outbound',
  from_address citext not null, to_addresses citext[] not null, cc_addresses citext[] not null default '{}', subject text not null,
  body_text text, body_html text, status public.delivery_status not null default 'queued', template_id uuid, attachments jsonb not null default '[]'::jsonb,
  error_message text, sent_at timestamptz, delivered_at timestamptz, opened_at timestamptz, created_by uuid references auth.users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(tenant_id,provider_message_id), unique(tenant_id,id),
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id)
);
create table public.message_templates (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  channel text not null check(channel in ('sms','email')), name text not null, subject text, body text not null, version integer not null default 1,
  team_id uuid, active boolean not null default true, created_at timestamptz not null default now(), unique(tenant_id,channel,name,version), unique(tenant_id,id),
  foreign key(tenant_id,team_id) references public.teams(tenant_id,id)
);

create table public.provider_webhook_events (
  id uuid primary key default gen_random_uuid(), tenant_id uuid references public.tenants(id) on delete cascade,
  provider text not null, event_type text not null, provider_event_id text, route_key text, headers jsonb not null default '{}'::jsonb,
  payload jsonb not null, received_at timestamptz not null default now(), processed_at timestamptz, status text not null default 'received',
  attempts integer not null default 0, last_error text, unique(provider,provider_event_id)
);

create table public.outbox_jobs (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  job_type text not null, aggregate_type text not null, aggregate_id uuid, payload jsonb not null, status public.job_status not null default 'pending',
  idempotency_key text not null, priority integer not null default 100, available_at timestamptz not null default now(), attempts integer not null default 0,
  max_attempts integer not null default 8, locked_at timestamptz, locked_by text, last_error text, completed_at timestamptz, created_at timestamptz not null default now(),
  unique(tenant_id,idempotency_key)
);
create index outbox_jobs_ready_idx on public.outbox_jobs(status,available_at,priority) where status in ('pending','failed');

create trigger integrations_touch before update on public.tenant_integrations for each row execute function public.touch_updated_at();
create trigger phone_numbers_touch before update on public.phone_numbers for each row execute function public.touch_updated_at();
create trigger queues_touch before update on public.call_queues for each row execute function public.touch_updated_at();
create trigger calls_touch before update on public.calls for each row execute function public.touch_updated_at();
create trigger conversations_touch before update on public.sms_conversations for each row execute function public.touch_updated_at();
create trigger sms_touch before update on public.sms_messages for each row execute function public.touch_updated_at();
create trigger email_touch before update on public.email_messages for each row execute function public.touch_updated_at();

commit;
