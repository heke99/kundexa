begin;
create function private.contract_custom_definitions(p_config jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog,public,private as $$
declare combined jsonb; result jsonb;
begin
 if jsonb_typeof(coalesce(p_config->'custom_fields','[]'))<>'array' or jsonb_typeof(coalesce(p_config#>'{pdf_template,customFields}','[]'))<>'array' then raise exception 'contract_custom_definitions_invalid'; end if;
 if exists(select 1 from jsonb_array_elements(coalesce(p_config->'custom_fields','[]')) d group by d->>'id' having count(*)>1) or exists(select 1 from jsonb_array_elements(coalesce(p_config#>'{pdf_template,customFields}','[]')) d group by d->>'id' having count(*)>1) then raise exception 'contract_custom_definitions_invalid'; end if;
 combined:=coalesce(p_config->'custom_fields','[]')||coalesce(p_config#>'{pdf_template,customFields}','[]');
 if exists(select 1 from jsonb_array_elements(combined) d group by d->>'id' having count(distinct d)>1) then raise exception 'contract_custom_definition_conflict'; end if;
 select coalesce(jsonb_agg(item order by ordinal),'[]') into result from
   (select distinct on(item->>'id') item,ordinal from jsonb_array_elements(combined) with ordinality a(item,ordinal) order by item->>'id',ordinal) x;
 return result;
end $$;
revoke all on function private.contract_custom_definitions(jsonb) from public,anon,authenticated,service_role;

create function private.validate_contract_customer_fields(p_definitions jsonb,p_values jsonb default null) returns void
language plpgsql immutable set search_path=pg_catalog,public,private as $$
declare d jsonb; v jsonb; key text; text_value text;
begin
 if jsonb_typeof(p_definitions)<>'array' or jsonb_array_length(p_definitions)>50 then raise exception 'contract_custom_definitions_invalid'; end if;
 for d in select value from jsonb_array_elements(p_definitions) loop
  if jsonb_typeof(d)<>'object' then raise exception 'contract_custom_definitions_invalid'; end if;
  if exists(select 1 from jsonb_object_keys(d) as props(name) where props.name not in ('id','label','type','required','customerKey')) then raise exception 'contract_custom_definitions_invalid'; end if;
  if jsonb_typeof(d)<>'object' or coalesce(d->>'id','') !~ '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$'
    or jsonb_typeof(d->'label') is distinct from 'string' or (btrim(d->>'label')='' or length(d->>'label')>120)
    or coalesce(d->>'type','') not in ('text','number','date') or jsonb_typeof(d->'required') is distinct from 'boolean'
    or (d ? 'customerKey' and coalesce(d->>'customerKey','') !~ '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$') then raise exception 'contract_custom_definitions_invalid'; end if;
  if p_values is not null then
   if jsonb_typeof(p_values)<>'object' then raise exception 'contract_custom_values_invalid'; end if;
   v:=p_values->(d->>'id'); text_value:=p_values->>(d->>'id');
   if v is null or v='null'::jsonb or text_value='' or (jsonb_typeof(v)='string' and btrim(text_value)='') then
    if (d->>'required')::boolean then raise exception 'contract_custom_value_required:%',d->>'id'; end if;
   elsif d->>'type'='number' then
    if jsonb_typeof(v)<>'number' or abs(text_value::numeric)>1e12 then raise exception 'contract_custom_number_invalid'; end if;
   else
    if jsonb_typeof(v)<>'string' or length(text_value)>1000 then raise exception 'contract_custom_text_invalid'; end if;
    if d->>'type'='date' then
     if text_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'contract_custom_date_invalid'; end if;
     begin
      if (text_value::date)::text<>text_value then raise exception 'contract_custom_date_invalid'; end if;
     exception when others then raise exception 'contract_custom_date_invalid'; end;
    end if;
   end if;
  end if;
 end loop;
 if p_values is not null then
  for key in select jsonb_object_keys(p_values) loop
   if not exists(select 1 from jsonb_array_elements(p_definitions) as item(definition) where item.definition->>'id'=key) then raise exception 'contract_custom_value_unknown'; end if;
  end loop;
 end if;
end $$;
revoke all on function private.validate_contract_customer_fields(jsonb,jsonb) from public,anon,authenticated,service_role;

create function public.enforce_template_customer_fields() returns trigger
language plpgsql security definer set search_path=public,private,pg_temp as $$
begin
 perform private.validate_contract_customer_fields(private.contract_custom_definitions(new.signing_configuration),null);
 return new;
end $$;
revoke all on function public.enforce_template_customer_fields() from public,anon,authenticated,service_role;
create trigger template_customer_field_schema before insert or update of signing_configuration on public.contract_template_versions
 for each row execute function public.enforce_template_customer_fields();

create function public.enforce_contract_customer_fields() returns trigger
language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v public.contract_versions%rowtype; config jsonb; definitions jsonb; frozen jsonb;
begin
 select * into v from public.contract_versions where tenant_id=new.tenant_id and id=new.id;
 if not found or v.template_version_id is null then return null; end if;
 select signing_configuration into config from public.contract_template_versions where tenant_id=v.tenant_id and id=v.template_version_id;
 definitions:=private.contract_custom_definitions(config); frozen:=v.commercial_terms->'custom_fields';
 if jsonb_array_length(definitions)=0 and (frozen is null or frozen='null') then return null; end if;
 if frozen->'definitions' is distinct from definitions or jsonb_typeof(frozen->'values') is distinct from 'object' then raise exception 'contract_custom_snapshot_required'; end if;
 perform private.validate_contract_customer_fields(definitions,frozen->'values');
 return null;
end $$;
revoke all on function public.enforce_contract_customer_fields() from public,anon,authenticated,service_role;
create constraint trigger contract_customer_field_values after insert or update of commercial_terms,template_version_id on public.contract_versions
 deferrable initially deferred for each row execute function public.enforce_contract_customer_fields();

create function public.set_customer_custom_field(p_customer_id uuid,p_key text,p_value jsonb) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare tenant uuid:=public.current_tenant_id(); actor uuid:=auth.uid(); previous jsonb;
begin
 if tenant is null or actor is null then raise exception 'authentication_required'; end if;
 if not public.can_write_customer(p_customer_id) then raise exception 'customer_write_permission_required'; end if;
 if p_key is null or p_key !~ '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$' then raise exception 'customer_field_key_invalid'; end if;
 if p_value is not null then
  if jsonb_typeof(p_value) not in ('string','number','null') then raise exception 'customer_field_value_invalid'; end if;
  if jsonb_typeof(p_value)='string' and length(p_value#>>'{}')>1000 then raise exception 'customer_field_value_invalid'; end if;
  if jsonb_typeof(p_value)='number' and abs((p_value#>>'{}')::numeric)>1e12 then raise exception 'customer_field_value_invalid'; end if;
 end if;
 select custom_fields into previous from public.customers where tenant_id=tenant and id=p_customer_id and deleted_at is null for update;
 if not found then raise exception 'customer_not_found'; end if;
 if jsonb_typeof(previous)<>'object' then raise exception 'customer_fields_object_required'; end if;
 update public.customers set custom_fields=case when p_value is null or p_value='null'::jsonb then coalesce(custom_fields,'{}')-p_key else jsonb_set(coalesce(custom_fields,'{}'),array[p_key],p_value,true) end,updated_at=now()
 where tenant_id=tenant and id=p_customer_id;
 insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,before_data,after_data)
 values(tenant,actor,'customer.custom_field_updated','customer',p_customer_id::text,jsonb_build_object('key',p_key,'value',previous->p_key),jsonb_build_object('key',p_key,'value',p_value));
end $$;
revoke all on function public.set_customer_custom_field(uuid,text,jsonb) from public,anon,service_role;
grant execute on function public.set_customer_custom_field(uuid,text,jsonb) to authenticated;
commit;
