-- E-postutskick är på från början. Den som inte vill ha det stänger av det.
--
-- Every tenant was seeded with `outbound_email` and `contract_delivery_email`
-- off, so a new company could not e-mail a contract until someone found two
-- switches in Administration — and the send failed with
-- `outbound_email_feature_disabled`, which says nothing about where the switch
-- is. Sending e-mail is what the product is for; having it off is the exception.
--
-- Three places decide the default, and only one of them actually wins:
--
--   1. `bootstrap_operational_defaults`, an AFTER INSERT trigger on `tenants`.
--      It runs first and writes `false`.
--   2. `create_tenant_with_owner`
--   3. `ensure_tenant_defaults`
--
-- Both 2 and 3 insert `on conflict (tenant_id,feature_key) do nothing`, so by
-- the time they run the trigger's row already exists and theirs is a no-op.
-- Changing either of them alone would have looked right and done nothing. All
-- three are changed here so no path contradicts another.
--
-- Patched by textual anchor rather than rewritten, so unrelated logic in these
-- functions cannot be altered by accident. Each patch asserts its anchor first
-- and fails loudly if the function has moved on.
--
-- Nothing here weakens a guard. The feature flag says what this tenant is
-- allowed to do; whether a particular message may go out is decided separately
-- by the contact policy and legal basis, and nothing is sent at all until a
-- Resend integration is active. Turning the flag on removes a dead end, not a
-- protection.

do $$
declare
  v_definition text;
  v_before constant text := $anchor$  select new.id,v.feature_key,false,'{}'::jsonb
  from (values
    ('outbound_calls'),('outbound_sms'),('outbound_email'),
    ('contract_delivery_sms'),('contract_delivery_email'),
    ('call_recording'),('data_enrichment'),('mass_campaigns'),('exports')
  ) as v(feature_key)$anchor$;
  v_after constant text := $patched$  select new.id,v.feature_key,v.enabled,'{}'::jsonb
  from (values
    ('outbound_calls',false),('outbound_sms',false),('outbound_email',true),
    ('contract_delivery_sms',false),('contract_delivery_email',true),
    ('call_recording',false),('data_enrichment',false),('mass_campaigns',false),('exports',false)
  ) as v(feature_key,enabled)$patched$;
begin
  select pg_get_functiondef('public.bootstrap_operational_defaults()'::regprocedure) into v_definition;
  if position(v_before in v_definition) = 0 then
    raise exception 'bootstrap_operational_defaults_anchor_missing';
  end if;
  execute replace(v_definition, v_before, v_after);
end $$;

-- The other two carry the same keys in a per-key list, so one value each moves.
do $$
declare
  v_definition text;
  v_patched text;
begin
  foreach v_definition in array array[
    pg_get_functiondef('public.create_tenant_with_owner(text,text,text)'::regprocedure),
    pg_get_functiondef('public.ensure_tenant_defaults(uuid)'::regprocedure)
  ] loop
    if position($a$('outbound_email',false)$a$ in v_definition) = 0
       or position($a$('contract_delivery_email',false)$a$ in v_definition) = 0 then
      raise exception 'tenant_feature_seed_anchor_missing';
    end if;
    v_patched := replace(v_definition, $a$('outbound_email',false)$a$, $a$('outbound_email',true)$a$);
    v_patched := replace(v_patched, $a$('contract_delivery_email',false)$a$, $a$('contract_delivery_email',true)$a$);
    execute v_patched;
  end loop;
end $$;

-- Bring the tenants that already exist to the same place. A one-time backfill:
-- from here on a tenant that switches e-mail off stays off, because nothing
-- re-runs this.
insert into public.tenant_features(tenant_id, feature_key, enabled, configuration)
select t.id, k.feature_key, true, '{}'::jsonb
from public.tenants t
cross join (values ('outbound_email'), ('contract_delivery_email')) as k(feature_key)
on conflict (tenant_id, feature_key) do update set enabled = true, updated_at = now();
