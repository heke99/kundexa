begin;
-- Activation starts from the authenticated identity, not the active tenant
-- (which invited users do not yet have). The existing tenant-first index does
-- not cover that lookup. Revocation also uses identity + tenant + pending.
create index if not exists tenant_invitations_pending_identity_idx
 on public.tenant_invitations(invited_user_id,created_at desc,tenant_id)
 where status='pending' and revoked_at is null;
create index if not exists tenant_invitations_pending_legacy_email_idx
 on public.tenant_invitations(lower(email::text),created_at desc)
 where status='pending' and revoked_at is null and invited_user_id is null;
commit;
