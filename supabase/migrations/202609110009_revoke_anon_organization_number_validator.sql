-- `is_valid_organization_number` was reachable by `anon`.
--
-- My own miss, from the seller-organisation-number migration: the function was
-- created without the `revoke ... from public` that every other function in this
-- schema carries, so the default PUBLIC grant stood and Supabase published it at
-- `/rest/v1/rpc/is_valid_organization_number` for unauthenticated callers.
--
-- It reads no tables and returns a boolean, so nothing leaked. It is still
-- `SECURITY DEFINER` — it has to be, to reach `private.normalize_swedish_
-- organization_number` — and a SECURITY DEFINER function on the public API with
-- no authentication is surface that exists for no reason. The validator is only
-- ever called from the admin screen, by a signed-in user.
revoke all on function public.is_valid_organization_number(text, text) from public, anon;
grant execute on function public.is_valid_organization_number(text, text) to authenticated;
