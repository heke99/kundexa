begin;
-- Preserve the live13October legacy table as inaccessible history. Native
-- signing uses signing_envelopes; this migration activates no remote workflow.
create table if not exists public.contract_signing_links (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 envelope_id uuid not null,
 recipient_id uuid not null,
 token_hash text not null,
 token_ciphertext text not null,
 expires_at timestamptz not null,
 revoked_at timestamptz,
 created_at timestamptz not null default now(),
 constraint contract_signing_links_pkey primary key(id),
 constraint contract_signing_links_token_hash_key unique(token_hash),
 constraint contract_signing_links_tenant_id_id_key unique(tenant_id,id),
 constraint contract_signing_links_envelope_id_recipient_id_key unique(envelope_id,recipient_id),
 constraint contract_signing_links_token_hash_check check(length(token_hash)=64),
 constraint contract_signing_links_tenant_id_fkey foreign key(tenant_id) references public.tenants(id),
 constraint contract_signing_links_tenant_id_envelope_id_fkey foreign key(tenant_id,envelope_id) references public.signing_envelopes(tenant_id,id),
 constraint contract_signing_links_tenant_id_recipient_id_fkey foreign key(tenant_id,recipient_id) references public.contract_recipients(tenant_id,id)
);
create index if not exists contract_signing_links_envelope_idx on public.contract_signing_links(tenant_id,envelope_id);
alter table public.contract_signing_links enable row level security;
revoke all on public.contract_signing_links from public,anon,authenticated,service_role;
-- Even an owner-executed old SECURITY DEFINER function must not issue new links.
create or replace function private.reject_retired_remote_signing_link() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin raise exception 'remote_signing_links_retired'; end $$;
revoke all on function private.reject_retired_remote_signing_link() from public,anon,authenticated,service_role;
create trigger contract_signing_links_retired before insert on public.contract_signing_links
for each row execute function private.reject_retired_remote_signing_link();
commit;
