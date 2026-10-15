begin;
-- Keep approved source, positions, bindings and method immutable through direct API writes too.
create or replace function public.validate_pdf_template_policy() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare cfg jsonb; pdf jsonb; f jsonb; a jsonb; size jsonb; def jsonb; method text; custom_ids text[]:='{}'; custom_types jsonb:='{}'; seen_ids text[]:='{}'; seen_names text[]:='{}';
begin
  if tg_op='UPDATE' and old.status='approved' and
    row(new.signature_policy,new.signing_configuration) is distinct from row(old.signature_policy,old.signing_configuration)
  then raise exception 'approved_template_version_is_immutable'; end if;
  cfg:=new.signing_configuration;
  if cfg ? 'signature_policy' then
    method:=cfg->'signature_policy'->>'method';
    if coalesce(method,'') not in ('simple_click','external_esign') then raise exception 'signing_method_not_configured'; end if;
    if cfg->'signature_policy'->>'identityAssuranceLevel' is distinct from 'low' then raise exception 'unverified_identity_assurance'; end if;
    if method='external_esign' and (cfg->'signature_policy'->>'requireFinalProviderDocument' is distinct from 'true' or cfg->>'provider_key' is distinct from 'docuseal') then raise exception 'external_signing_policy_invalid'; end if;
    new.signature_policy:=cfg->'signature_policy';
  end if;
  pdf:=cfg->'pdf_template';
  if pdf is null then
    if method='external_esign' then raise exception 'pdf_signature_field_required'; end if;
    return new;
  end if;
  if jsonb_typeof(pdf) is distinct from 'object'
    or pdf - array['schemaVersion','storagePath','sha256','pageSizes','fields','customFields'] <> '{}'::jsonb
    or jsonb_typeof(pdf->'schemaVersion') is distinct from 'number'
    or (pdf->>'schemaVersion')::numeric is distinct from 1
    or jsonb_typeof(pdf->'storagePath') is distinct from 'string'
    or length(pdf->>'storagePath') not between 1 and 400
    or jsonb_typeof(pdf->'sha256') is distinct from 'string'
    or coalesce(pdf->>'storagePath','') !~ ('^'||new.tenant_id::text||'/templates/[A-Za-z0-9_-]+/[a-f0-9]{64}[.]pdf$')
    or position('..' in pdf->>'storagePath')>0
    or coalesce(pdf->>'sha256','') !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(pdf->'fields') is distinct from 'array'
    or jsonb_typeof(pdf->'pageSizes') is distinct from 'array'
    or jsonb_array_length(pdf->'fields') not between 1 and 200
    or jsonb_array_length(pdf->'pageSizes') not between 1 and 100
  then raise exception 'pdf_template_invalid'; end if;
  if pdf ? 'customFields' then
    if jsonb_typeof(pdf->'customFields') is distinct from 'array' or jsonb_array_length(pdf->'customFields')>50
      then raise exception 'pdf_template_custom_definitions_invalid'; end if;
    for def in select value from jsonb_array_elements(pdf->'customFields') loop
      if jsonb_typeof(def) is distinct from 'object'
        or def - array['id','label','type','required'] <> '{}'::jsonb
        or jsonb_typeof(def->'id') is distinct from 'string'
        or coalesce(def->>'id','') !~ '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$'
        or jsonb_typeof(def->'label') is distinct from 'string'
        or length(def->>'label') not between 1 and 120
        or coalesce(def->>'type','') not in ('text','date','number')
        or jsonb_typeof(def->'required') is distinct from 'boolean'
        then raise exception 'pdf_template_custom_definition_invalid'; end if;
      if def->>'id'=any(custom_ids) then raise exception 'pdf_template_custom_duplicate_definition'; end if;
      custom_ids:=array_append(custom_ids,def->>'id');
      custom_types:=custom_types||jsonb_build_object(def->>'id',def->>'type');
    end loop;
  end if;
  for size in select value from jsonb_array_elements(pdf->'pageSizes') loop
    if jsonb_typeof(size) is distinct from 'object'
      or size - array['width','height'] <> '{}'::jsonb
      or jsonb_typeof(size->'width') is distinct from 'number'
      or jsonb_typeof(size->'height') is distinct from 'number'
      or (size->>'width')::numeric<=0 or (size->>'height')::numeric<=0
      or (size->>'width')::numeric>1.7976931348623157e308
      or (size->>'height')::numeric>1.7976931348623157e308
    then raise exception 'pdf_template_page_size_invalid'; end if;
  end loop;
  for f in select value from jsonb_array_elements(pdf->'fields') loop
    if jsonb_typeof(f) is distinct from 'object'
      or f - array['id','label','providerName','type','source','required','fontSize','placements'] <> '{}'::jsonb
      or jsonb_typeof(f->'id') is distinct from 'string'
      or coalesce(f->>'id','') !~ '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$'
      or jsonb_typeof(f->'label') is distinct from 'string'
      or length(f->>'label') not between 1 and 120
      or jsonb_typeof(f->'providerName') is distinct from 'string'
      or length(f->>'providerName') not between 1 and 120
      or jsonb_typeof(f->'source') is distinct from 'string'
      or length(f->>'source')>120
      or jsonb_typeof(f->'required') is distinct from 'boolean'
      or jsonb_typeof(f->'fontSize') is distinct from 'number'
    then raise exception 'pdf_template_field_invalid'; end if;
    if f->>'id' is null or f->>'id'=any(seen_ids) or f->>'providerName' is null or f->>'providerName'=any(seen_names) then raise exception 'pdf_template_duplicate_field'; end if;
    seen_ids:=array_append(seen_ids,f->>'id'); seen_names:=array_append(seen_names,f->>'providerName');
    if f->>'type'='signature' then
      if coalesce(f->>'source','')<>'' or method is distinct from 'external_esign' then raise exception 'signature_field_cannot_be_prefilled'; end if;
    elsif left(f->>'source',7)='custom.' then
      if coalesce(f->>'type','') not in ('text','date')
        or not (substring(f->>'source' from 8)=any(custom_ids)) then raise exception 'pdf_template_unknown_custom_source'; end if;
      if f->>'type'='date' and custom_types->>substring(f->>'source' from 8) is distinct from 'date'
        then raise exception 'pdf_template_custom_date_type_mismatch'; end if;
    elsif coalesce(f->>'type','') not in ('text','date') or not (coalesce(f->>'source','')=any(array['contract.audience','contract.ends_on','contract.language','contract.sales_channel','contract.special_terms','contract.starts_on','contract.title','customer.address_line1','customer.city','customer.company_name','customer.country_code','customer.customer_type','customer.display_name','customer.email','customer.first_name','customer.id','customer.last_name','customer.organization_number','customer.personal_identity_number','customer.phone_e164','customer.postal_code','price.binding_months','price.currency','price.notice_months','price.payment_terms_days','price.recurring_fee','price.setup_fee','price.variable_fee','product.description','product.id','product.name','product.sku','seller.address_line1','seller.city','seller.country_code','seller.email','seller.id','seller.legal_name','seller.organization_number','seller.phone_e164','seller.postal_code','seller.website','today'])) then raise exception 'pdf_template_unknown_source'; end if;
    if f->>'fontSize' is null or (f->>'fontSize')::numeric not between 6 and 30 or jsonb_typeof(f->'placements') is distinct from 'array' or jsonb_array_length(f->'placements') not between 1 and 100 then raise exception 'pdf_template_field_invalid'; end if;
    if f->>'type'='date' and left(f->>'source',7)<>'custom.' and f->>'source' not in ('today','contract.starts_on','contract.ends_on') then raise exception 'pdf_template_date_source_required'; end if;
    for a in select value from jsonb_array_elements(f->'placements') loop
      if jsonb_typeof(a) is distinct from 'object'
        or a - array['page','x','y','width','height'] <> '{}'::jsonb
        or jsonb_typeof(a->'page') is distinct from 'number'
        or jsonb_typeof(a->'x') is distinct from 'number'
        or jsonb_typeof(a->'y') is distinct from 'number'
        or jsonb_typeof(a->'width') is distinct from 'number'
        or jsonb_typeof(a->'height') is distinct from 'number'
        or (a->>'page')::numeric<>trunc((a->>'page')::numeric)
        or (a->>'page')::numeric not between 0 and jsonb_array_length(pdf->'pageSizes')-1
        or (a->>'x')::numeric<0 or (a->>'y')::numeric<0
        or (a->>'width')::numeric<=0 or (a->>'height')::numeric<=0
        or (a->>'x')::numeric+(a->>'width')::numeric>1.000001
        or (a->>'y')::numeric+(a->>'height')::numeric>1.000001
      then raise exception 'pdf_template_field_outside_page'; end if;
    end loop;
  end loop;
  if method='external_esign' and not exists(select 1 from jsonb_array_elements(pdf->'fields') x where x->>'type'='signature') then raise exception 'pdf_signature_field_required'; end if;
  return new;
end $$;
revoke all on function public.validate_pdf_template_policy() from public,anon,authenticated;
create trigger contract_template_pdf_policy before insert or update on public.contract_template_versions
for each row execute function public.validate_pdf_template_policy();
commit;
