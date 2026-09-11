-- The seller's organisation number is printed on every contract. It was the one
-- identity number in the system that nothing validated.
--
-- Customer organisation numbers go through `normalizeOrganizationNumber`
-- (ten digits, Luhn, canonical `NNNNNN-NNNN`) on every import. The seller's own
-- number — the one that appears as `{{seller.organization_number}}` on a legally
-- binding document — was stored verbatim, so production holds `5594616-7149`
-- (eleven digits) and `559333333` (nine). Both would have been printed as the
-- signing party's organisation number.
--
-- The phone number on the same row was already validated to E.164. This closes
-- the same gap for the number that carries legal weight.

-- The Luhn check Skatteverket uses for organisations- and personnummer, as a
-- single expression over the ten canonical digits.
create or replace function private.swedish_identity_number_luhn_ok(p_digits text)
returns boolean
language sql
immutable
set search_path=''
as $$
  select p_digits ~ '^[0-9]{10}$'
     and (
       select pg_catalog.sum(
         (c::int * (case when o % 2 = 1 then 2 else 1 end)) / 10
         + (c::int * (case when o % 2 = 1 then 2 else 1 end)) % 10
       )
       from pg_catalog.unnest(pg_catalog.string_to_array(p_digits, null)) with ordinality as t(c, o)
     ) % 10 = 0;
$$;

-- Normalise to the canonical `NNNNNN-NNNN`, or null when the input is not a
-- Swedish organisations- or personnummer. Mirrors
-- `src/lib/imports/organization-number.ts` so the seller and the customer are
-- held to one rule.
--
-- Personnummer are accepted: an enskild firma legitimately signs with one, and
-- refusing it would lock a real Swedish business out of its own contracts.
create or replace function private.normalize_swedish_organization_number(p_input text)
returns text
language plpgsql
immutable
set search_path=''
as $$
declare
  v_value text := pg_catalog.upper(pg_catalog.regexp_replace(coalesce(p_input,''), '[[:space:]-]', '', 'g'));
begin
  if v_value = '' then return null; end if;

  -- `SE` + twelve digits + `01` is the VAT form of the same number.
  if v_value ~ '^SE[0-9]{12}$' and pg_catalog.right(v_value, 2) = '01' then
    v_value := pg_catalog.substr(v_value, 3, 10);
  elsif pg_catalog.left(v_value, 2) = 'SE' then
    v_value := pg_catalog.substr(v_value, 3);
  end if;

  if v_value !~ '^[0-9]+$' then return null; end if;
  -- A twelve-digit number carries the century as a `16` prefix for organisations.
  if pg_catalog.length(v_value) = 12 and pg_catalog.left(v_value, 2) = '16' then
    v_value := pg_catalog.substr(v_value, 3);
  end if;
  if pg_catalog.length(v_value) <> 10 then return null; end if;
  if not private.swedish_identity_number_luhn_ok(v_value) then return null; end if;

  return pg_catalog.substr(v_value, 1, 6) || '-' || pg_catalog.substr(v_value, 7, 4);
end
$$;

revoke all on function private.swedish_identity_number_luhn_ok(text) from public;
revoke all on function private.normalize_swedish_organization_number(text) from public;

-- Deliberately no CHECK constraint on the table. Two rows in production already
-- hold an invalid number, and a constraint — even NOT VALID — would fail every
-- later UPDATE of those rows, including the `is_default=false` sweep inside this
-- very function. Validating on the write path refuses new bad data without
-- making the existing rows unwritable, which is what lets the owner correct them.
create or replace function public.upsert_tenant_legal_entity(
  p_id uuid,
  p_legal_name text,
  p_organization_number text,
  p_address_line1 text,
  p_postal_code text,
  p_city text,
  p_country_code text,
  p_email text,
  p_phone_e164 text,
  p_website text,
  p_is_default boolean
)
returns uuid
language plpgsql security definer set search_path=public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_id uuid := p_id;
  v_country text := coalesce(nullif(p_country_code,''),'SE');
  v_organization_number text := nullif(trim(coalesce(p_organization_number,'')),'');
begin
  if v_user is null or v_tenant is null then raise exception 'authentication_required'; end if;
  if not public.is_tenant_admin(v_tenant) then raise exception 'admin_required'; end if;
  if nullif(trim(p_legal_name),'') is null then raise exception 'legal_name_required'; end if;
  if p_phone_e164 is not null and p_phone_e164<>'' and p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'phone_must_be_e164'; end if;

  -- Only Swedish numbers are checked. A foreign entity has a different national
  -- format, and guessing at one would refuse a legitimate company.
  if v_organization_number is not null and upper(v_country) = 'SE' then
    v_organization_number := private.normalize_swedish_organization_number(v_organization_number);
    if v_organization_number is null then raise exception 'organization_number_invalid'; end if;
  end if;

  if p_is_default then update public.tenant_legal_entities set is_default=false where tenant_id=v_tenant and is_default; end if;
  if v_id is null then
    insert into public.tenant_legal_entities(
      tenant_id,legal_name,organization_number,address_line1,postal_code,city,country_code,email,phone_e164,website,is_default,active
    ) values (
      v_tenant,p_legal_name,v_organization_number,nullif(p_address_line1,''),nullif(p_postal_code,''),nullif(p_city,''),
      v_country,nullif(p_email,'')::citext,nullif(p_phone_e164,''),nullif(p_website,''),p_is_default,true
    ) returning id into v_id;
  else
    update public.tenant_legal_entities set
      legal_name=p_legal_name,organization_number=v_organization_number,address_line1=nullif(p_address_line1,''),
      postal_code=nullif(p_postal_code,''),city=nullif(p_city,''),country_code=v_country,
      email=nullif(p_email,'')::citext,phone_e164=nullif(p_phone_e164,''),website=nullif(p_website,''),is_default=p_is_default,active=true
    where tenant_id=v_tenant and id=v_id;
    if not found then raise exception 'legal_entity_not_found'; end if;
  end if;
  if not exists(select 1 from public.tenant_legal_entities where tenant_id=v_tenant and is_default and active) then
    update public.tenant_legal_entities set is_default=true where tenant_id=v_tenant and id=v_id;
  end if;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_tenant,v_user,'legal_entity.saved','tenant_legal_entity',v_id::text,jsonb_build_object('legal_name',p_legal_name,'is_default',p_is_default));
  return v_id;
end
$$;

-- A read-only probe so the admin screen can mark a number that would be refused
-- today. It reports on data the caller can already see, so `authenticated` is
-- the right grant; the function itself touches no table.
create or replace function public.is_valid_organization_number(p_value text, p_country_code text default 'SE')
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select case
    when nullif(pg_catalog.btrim(coalesce(p_value,'')),'') is null then false
    when pg_catalog.upper(coalesce(nullif(p_country_code,''),'SE')) <> 'SE' then true
    else private.normalize_swedish_organization_number(p_value) is not null
  end;
$$;

revoke all on function public.is_valid_organization_number(text,text) from public;
grant execute on function public.is_valid_organization_number(text,text) to authenticated;
