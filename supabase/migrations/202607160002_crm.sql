begin;

create table public.customer_statuses (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  key text not null, label text not null, color text not null default '#64748b', sort_order integer not null default 0,
  is_terminal boolean not null default false, is_system boolean not null default false, created_at timestamptz not null default now(),
  unique(tenant_id,key), unique(tenant_id,id)
);

create table public.customers (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_type public.customer_type not null, lifecycle public.customer_lifecycle not null default 'prospect', status_id uuid,
  display_name text not null, first_name text, last_name text, company_name text, personal_identity_number text, organization_number text,
  email citext, phone_e164 text, alternate_phone_e164 text, website text, legal_form text, industry text, sni_code text,
  revenue numeric, result numeric, employee_count integer, vat_registered boolean, f_tax boolean, employer_registered boolean,
  address_line1 text, address_line2 text, postal_code text, city text, municipality text, county text, country_code text not null default 'SE',
  latitude numeric, longitude numeric, current_supplier text, source_name text, source_external_id text, source_retrieved_at timestamptz,
  source_verified_at timestamptz, marketing_allowed boolean, legal_basis text, do_not_call boolean not null default false,
  do_not_sms boolean not null default false, do_not_email boolean not null default false, blocked_reason text,
  assigned_user_id uuid references auth.users(id) on delete set null, assigned_team_id uuid, campaign_id uuid,
  last_contact_at timestamptz, next_activity_at timestamptz, call_attempts integer not null default 0,
  manually_verified_fields text[] not null default '{}', custom_fields jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
  foreign key (tenant_id,status_id) references public.customer_statuses(tenant_id,id),
  foreign key (tenant_id,assigned_team_id) references public.teams(tenant_id,id),
  unique(tenant_id,id)
);
create index customers_tenant_name_idx on public.customers using gin (display_name gin_trgm_ops);
create index customers_tenant_phone_idx on public.customers(tenant_id,phone_e164) where phone_e164 is not null;
create index customers_tenant_org_idx on public.customers(tenant_id,organization_number) where organization_number is not null;
create index customers_tenant_assigned_idx on public.customers(tenant_id,assigned_user_id,assigned_team_id);

create table public.contact_people (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null, full_name text not null, title text, email citext, phone_e164 text, is_primary boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id) on delete cascade,
  unique(tenant_id,id)
);

create table public.tags (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null, color text not null default '#64748b', created_at timestamptz not null default now(), unique(tenant_id,name), unique(tenant_id,id)
);
create table public.customer_tags (
  tenant_id uuid not null, customer_id uuid not null, tag_id uuid not null, created_at timestamptz not null default now(),
  primary key(customer_id,tag_id), foreign key(tenant_id,customer_id) references public.customers(tenant_id,id) on delete cascade,
  foreign key(tenant_id,tag_id) references public.tags(tenant_id,id) on delete cascade
);

create table public.notes (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null, body text not null, is_pinned boolean not null default false, visibility text not null default 'team',
  created_by uuid references auth.users(id) on delete set null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id) on delete cascade, unique(tenant_id,id)
);

create table public.activities (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid, deal_id uuid, contract_id uuid, type public.activity_type not null, status public.activity_status not null default 'open',
  title text not null, description text, assigned_user_id uuid references auth.users(id) on delete set null, assigned_team_id uuid,
  priority text not null default 'normal' check(priority in ('low','normal','high','urgent')), due_at timestamptz, completed_at timestamptz,
  recurrence_rule text, metadata jsonb not null default '{}'::jsonb, created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(tenant_id,id),
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id) on delete cascade,
  foreign key(tenant_id,assigned_team_id) references public.teams(tenant_id,id)
);
create index activities_due_idx on public.activities(tenant_id,status,due_at);

create table public.customer_lists (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null, description text, list_type text not null default 'static' check(list_type in ('static','dynamic','campaign','personal','callback','renewal','block')),
  filter_definition jsonb not null default '{}'::jsonb, owner_user_id uuid references auth.users(id), team_id uuid, is_locked boolean not null default false,
  archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(tenant_id,id),
  foreign key(tenant_id,team_id) references public.teams(tenant_id,id)
);
create table public.customer_list_members (
  tenant_id uuid not null, list_id uuid not null, customer_id uuid not null, added_by uuid references auth.users(id), created_at timestamptz not null default now(),
  primary key(list_id,customer_id), foreign key(tenant_id,list_id) references public.customer_lists(tenant_id,id) on delete cascade,
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id) on delete cascade
);

create table public.import_runs (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null, source_type text not null, source_file_path text, status public.import_status not null default 'uploaded',
  uploaded_by uuid references auth.users(id), total_rows integer not null default 0, new_count integer not null default 0,
  updated_count integer not null default 0, duplicate_count integer not null default 0, error_count integer not null default 0,
  blocked_count integer not null default 0, field_mapping jsonb not null default '{}'::jsonb, validation_report jsonb not null default '{}'::jsonb,
  simulation boolean not null default true, rollback_data jsonb, started_at timestamptz, completed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(tenant_id,id)
);
create table public.import_rows (
  id bigint generated always as identity primary key, tenant_id uuid not null, import_run_id uuid not null, row_number integer not null,
  raw_data jsonb not null, normalized_data jsonb, decision text, matched_customer_id uuid, errors jsonb not null default '[]'::jsonb, created_at timestamptz not null default now(),
  foreign key(tenant_id,import_run_id) references public.import_runs(tenant_id,id) on delete cascade,
  foreign key(tenant_id,matched_customer_id) references public.customers(tenant_id,id)
);

create table public.products (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null, sku text, description text, product_type text not null default 'service', active boolean not null default true,
  configuration jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(tenant_id,id), unique(tenant_id,sku)
);
create table public.product_price_versions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, product_id uuid not null, version integer not null,
  currency text not null default 'SEK', setup_fee numeric not null default 0, recurring_fee numeric not null default 0,
  recurring_interval text, variable_fees jsonb not null default '[]'::jsonb, discounts jsonb not null default '[]'::jsonb,
  binding_months integer, notice_months integer, valid_from date not null default current_date, valid_to date, active boolean not null default true,
  created_at timestamptz not null default now(), unique(product_id,version), unique(tenant_id,id),
  foreign key(tenant_id,product_id) references public.products(tenant_id,id) on delete cascade
);

create table public.pipelines (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null, pipeline_type text not null default 'new_sales', active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(tenant_id,name), unique(tenant_id,id)
);
create table public.pipeline_stages (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, pipeline_id uuid not null, name text not null,
  sort_order integer not null, probability integer not null default 0 check(probability between 0 and 100), color text not null default '#64748b',
  is_won boolean not null default false, is_lost boolean not null default false, unique(pipeline_id,sort_order), unique(tenant_id,id),
  foreign key(tenant_id,pipeline_id) references public.pipelines(tenant_id,id) on delete cascade
);
create table public.deals (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null, pipeline_id uuid not null, stage_id uuid not null, product_id uuid, owner_user_id uuid references auth.users(id), team_id uuid,
  name text not null, value numeric not null default 0, currency text not null default 'SEK', probability integer not null default 0,
  expected_close_date date, next_activity_at timestamptz, status public.deal_status not null default 'open', loss_reason text, competitor text,
  current_supplier text, renewal_date date, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(tenant_id,id),
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id), foreign key(tenant_id,pipeline_id) references public.pipelines(tenant_id,id),
  foreign key(tenant_id,stage_id) references public.pipeline_stages(tenant_id,id), foreign key(tenant_id,product_id) references public.products(tenant_id,id),
  foreign key(tenant_id,team_id) references public.teams(tenant_id,id)
);
create table public.deal_stage_history (
  id bigint generated always as identity primary key, tenant_id uuid not null, deal_id uuid not null, from_stage_id uuid, to_stage_id uuid not null,
  changed_by uuid references auth.users(id), changed_at timestamptz not null default now(),
  foreign key(tenant_id,deal_id) references public.deals(tenant_id,id) on delete cascade
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null, description text, status text not null default 'draft' check(status in ('draft','scheduled','active','paused','completed','archived')),
  starts_at timestamptz, ends_at timestamptz, allowed_days integer[] not null default '{1,2,3,4,5}', allowed_start_time time not null default '09:00',
  allowed_end_time time not null default '18:00', max_attempts integer not null default 7, retry_rules jsonb not null default '{}'::jsonb,
  script text, questionnaire jsonb not null default '[]'::jsonb, goals jsonb not null default '{}'::jsonb, budget numeric,
  cost_limit numeric, created_by uuid references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(tenant_id,id)
);
create table public.campaign_teams (
  tenant_id uuid not null, campaign_id uuid not null, team_id uuid not null, primary key(campaign_id,team_id),
  foreign key(tenant_id,campaign_id) references public.campaigns(tenant_id,id) on delete cascade,
  foreign key(tenant_id,team_id) references public.teams(tenant_id,id) on delete cascade
);
create table public.campaign_members (
  tenant_id uuid not null, campaign_id uuid not null, customer_id uuid not null, assigned_user_id uuid references auth.users(id),
  state text not null default 'pending', attempts integer not null default 0, next_attempt_at timestamptz, outcome text, created_at timestamptz not null default now(),
  primary key(campaign_id,customer_id), foreign key(tenant_id,campaign_id) references public.campaigns(tenant_id,id) on delete cascade,
  foreign key(tenant_id,customer_id) references public.customers(tenant_id,id) on delete cascade
);

alter table public.customers add foreign key (tenant_id,campaign_id) references public.campaigns(tenant_id,id);
alter table public.activities add foreign key (tenant_id,deal_id) references public.deals(tenant_id,id) on delete cascade;

create trigger customers_touch before update on public.customers for each row execute function public.touch_updated_at();
create trigger contacts_touch before update on public.contact_people for each row execute function public.touch_updated_at();
create trigger notes_touch before update on public.notes for each row execute function public.touch_updated_at();
create trigger activities_touch before update on public.activities for each row execute function public.touch_updated_at();
create trigger lists_touch before update on public.customer_lists for each row execute function public.touch_updated_at();
create trigger imports_touch before update on public.import_runs for each row execute function public.touch_updated_at();
create trigger products_touch before update on public.products for each row execute function public.touch_updated_at();
create trigger pipelines_touch before update on public.pipelines for each row execute function public.touch_updated_at();
create trigger deals_touch before update on public.deals for each row execute function public.touch_updated_at();
create trigger campaigns_touch before update on public.campaigns for each row execute function public.touch_updated_at();

commit;
