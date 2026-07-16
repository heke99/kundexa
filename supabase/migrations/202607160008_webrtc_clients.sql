begin;
create table public.voice_clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  assigned_user_id uuid not null references auth.users(id) on delete cascade,
  integration_id uuid,
  client_number_e164 text not null,
  sip_username text not null,
  sip_password_ciphertext text not null,
  websocket_url text not null default 'wss://voip.46elks.com/w1/websocket',
  sip_domain text not null default 'voip.46elks.com',
  status text not null default 'active' check(status in ('active','disabled','error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,assigned_user_id), unique(tenant_id,client_number_e164), unique(tenant_id,id),
  foreign key(tenant_id,integration_id) references public.tenant_integrations(tenant_id,id)
);
alter table public.voice_clients enable row level security;
create policy voice_clients_admin_select on public.voice_clients for select using(tenant_id=public.current_tenant_id() and (assigned_user_id=auth.uid() or public.is_tenant_admin(tenant_id)));
create policy voice_clients_admin_write on public.voice_clients for all using(public.is_tenant_admin(tenant_id)) with check(tenant_id=public.current_tenant_id() and public.is_tenant_admin(tenant_id));
create trigger voice_clients_touch before update on public.voice_clients for each row execute function public.touch_updated_at();
create trigger voice_clients_tenant_immutable before update of tenant_id on public.voice_clients for each row execute function public.prevent_tenant_move();
commit;
