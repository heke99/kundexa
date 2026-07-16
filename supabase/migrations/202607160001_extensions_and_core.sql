begin;

create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists pg_trgm;

create type public.membership_role as enum ('owner','admin','team_lead','sales','contract_manager','quality','backoffice','finance','viewer');
create type public.membership_status as enum ('invited','active','suspended','removed');
create type public.customer_type as enum ('person','company');
create type public.customer_lifecycle as enum ('prospect','lead','customer','former_customer','lost','blocked');
create type public.activity_type as enum ('task','call','callback','meeting','email','sms','note','contract_followup','renewal','onboarding');
create type public.activity_status as enum ('open','in_progress','completed','cancelled');
create type public.deal_status as enum ('open','won','lost','archived');
create type public.communication_direction as enum ('inbound','outbound');
create type public.delivery_status as enum ('draft','queued','submitting','created','sent','delivered','opened','failed','cancelled');
create type public.contract_status as enum ('draft','ready','sent','delivered','opened','signing','accepted','signed','declined','expired','cancelled','superseded','active','terminated');
create type public.acceptance_method as enum ('sms','web','email_otp','sms_otp','bankid','electronic_signature','manual');
create type public.acceptance_status as enum ('pending','accepted_via_sms','accepted_via_web','signed_with_bankid','signed_electronically','declined','expired','cancelled','superseded','manual_review_required');
create type public.job_status as enum ('pending','processing','completed','failed','dead_letter','cancelled');
create type public.automation_status as enum ('draft','active','paused','archived');
create type public.import_status as enum ('uploaded','validating','preview_ready','processing','completed','failed','rolled_back');

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text not null,
  legal_name text not null,
  organization_number text,
  country_code text not null default 'SE',
  timezone text not null default 'Europe/Stockholm',
  locale text not null default 'sv-SE',
  status text not null default 'active' check (status in ('trial','active','suspended','cancelled')),
  branding jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone_e164 text,
  avatar_url text,
  active_tenant_id uuid references public.tenants(id) on delete set null,
  locale text not null default 'sv-SE',
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tenant_memberships (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.membership_role not null default 'sales',
  status public.membership_status not null default 'invited',
  invited_by uuid references auth.users(id),
  invited_at timestamptz,
  joined_at timestamptz,
  permissions_override jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  description text,
  office text,
  department text,
  is_default boolean not null default false,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name),
  unique (tenant_id, id)
);

create table public.team_members (
  tenant_id uuid not null,
  team_id uuid not null,
  user_id uuid not null,
  role text not null default 'member' check (role in ('manager','member')),
  capacity integer not null default 100 check (capacity between 0 and 10000),
  created_at timestamptz not null default now(),
  primary key (team_id, user_id),
  foreign key (tenant_id, team_id) references public.teams(tenant_id,id) on delete cascade,
  foreign key (tenant_id, user_id) references public.tenant_memberships(tenant_id,user_id) on delete cascade
);

create table public.tenant_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  compliance jsonb not null default '{"recording_default":false,"require_call_ended_before_b2c_acceptance":true}'::jsonb,
  retention jsonb not null default '{"audit_days":2555,"recording_days":90,"prospect_days":365}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tenant_features (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  feature_key text not null,
  enabled boolean not null default false,
  configuration jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, feature_key)
);

create table public.team_features (
  tenant_id uuid not null,
  team_id uuid not null,
  feature_key text not null,
  enabled boolean not null default false,
  configuration jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (team_id, feature_key),
  foreign key (tenant_id, team_id) references public.teams(tenant_id,id) on delete cascade
);

create table public.usage_limits (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  metric text not null,
  period text not null default 'month' check (period in ('day','month','total')),
  hard_limit numeric,
  soft_limit numeric,
  current_value numeric not null default 0,
  period_started_at timestamptz not null default date_trunc('month', now()),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, metric, period)
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  tenant_id uuid references public.tenants(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  ip_address inet,
  user_agent text,
  request_id text,
  created_at timestamptz not null default now()
);
create index audit_logs_tenant_created_idx on public.audit_logs(tenant_id, created_at desc);

create table public.security_events (
  id bigint generated always as identity primary key,
  tenant_id uuid references public.tenants(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  severity text not null default 'info' check (severity in ('info','warning','high','critical')),
  metadata jsonb not null default '{}'::jsonb,
  ip_address inet,
  created_at timestamptz not null default now()
);

create or replace function public.current_tenant_id() returns uuid
language sql stable security definer set search_path = public
as $$ select active_tenant_id from public.profiles where id = auth.uid() $$;

create or replace function public.current_membership_role() returns public.membership_role
language sql stable security definer set search_path = public
as $$ select role from public.tenant_memberships where tenant_id = public.current_tenant_id() and user_id = auth.uid() and status = 'active' $$;

create or replace function public.is_tenant_member(p_tenant_id uuid) returns boolean
language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.tenant_memberships where tenant_id=p_tenant_id and user_id=auth.uid() and status='active') $$;

create or replace function public.is_tenant_admin(p_tenant_id uuid default public.current_tenant_id()) returns boolean
language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.tenant_memberships where tenant_id=p_tenant_id and user_id=auth.uid() and status='active' and role in ('owner','admin')) $$;

create or replace function public.validate_active_tenant() returns trigger
language plpgsql security definer set search_path=public
as $$ begin
  if new.active_tenant_id is not null and not exists (
    select 1 from public.tenant_memberships m where m.tenant_id=new.active_tenant_id and m.user_id=new.id and m.status='active'
  ) then raise exception 'active_tenant_membership_required'; end if;
  return new;
end $$;
create trigger profiles_validate_active_tenant before insert or update of active_tenant_id on public.profiles for each row execute function public.validate_active_tenant();

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;

create trigger tenants_touch before update on public.tenants for each row execute function public.touch_updated_at();
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger memberships_touch before update on public.tenant_memberships for each row execute function public.touch_updated_at();
create trigger teams_touch before update on public.teams for each row execute function public.touch_updated_at();
create trigger tenant_settings_touch before update on public.tenant_settings for each row execute function public.touch_updated_at();

create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path=public
as $$ begin insert into public.profiles(id,full_name) values(new.id, coalesce(new.raw_user_meta_data->>'full_name','')) on conflict(id) do nothing; return new; end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_auth_user();

create or replace function public.create_tenant_with_owner(p_name text, p_legal_name text, p_organization_number text default null)
returns uuid language plpgsql security definer set search_path=public
as $$
declare v_user uuid:=auth.uid(); v_tenant uuid; v_team uuid; v_slug text;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  v_slug := trim(both '-' from regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g')) || '-' || substr(replace(gen_random_uuid()::text,'-',''),1,6);
  insert into public.tenants(slug,name,legal_name,organization_number) values(v_slug,p_name,p_legal_name,p_organization_number) returning id into v_tenant;
  insert into public.tenant_memberships(tenant_id,user_id,role,status,joined_at) values(v_tenant,v_user,'owner','active',now());
  insert into public.teams(tenant_id,name,is_default) values(v_tenant,'Huvudteam',true) returning id into v_team;
  insert into public.team_members(tenant_id,team_id,user_id,role) values(v_tenant,v_team,v_user,'manager');
  insert into public.tenant_settings(tenant_id) values(v_tenant);
  insert into public.tenant_features(tenant_id,feature_key,enabled) values
    (v_tenant,'crm',true),(v_tenant,'contracts',true),(v_tenant,'automations',true),(v_tenant,'outbound_calls',false),
    (v_tenant,'inbound_calls',false),(v_tenant,'outbound_sms',false),(v_tenant,'inbound_sms',false),(v_tenant,'outbound_email',false),
    (v_tenant,'call_recording',false),(v_tenant,'web_acceptance',true),(v_tenant,'sms_acceptance',false);
  update public.profiles set active_tenant_id=v_tenant where id=v_user;
  return v_tenant;
end $$;

grant execute on function public.create_tenant_with_owner(text,text,text) to authenticated;

commit;
