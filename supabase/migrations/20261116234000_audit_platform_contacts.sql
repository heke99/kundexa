begin;
-- Materialise the complete imported contact collection into the canonical CRM.
-- The allocation itself supplies the tenant/customer boundary; metadata cannot select it.
create or replace function private.allocate_platform_entry_contacts()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_contacts jsonb; v_contact jsonb;
begin
  select e.metadata->'contacts' into v_contacts
  from public.platform_list_entries e
  join public.platform_list_allocations a on a.id=new.allocation_id and a.platform_list_id=e.platform_list_id and a.tenant_id=new.tenant_id
  join public.customers c on c.id=new.customer_id and c.tenant_id=new.tenant_id
  where e.id=new.platform_entry_id;
  if not found then raise exception 'platform_contact_allocation_scope_mismatch'; end if;
  if jsonb_typeof(v_contacts)='array' then
    for v_contact in select value from jsonb_array_elements(v_contacts) loop
      if nullif(trim(v_contact->>'full_name'),'') is not null then
        insert into public.contact_people(tenant_id,customer_id,full_name,title,email,phone_e164,alternate_phone_e164,is_primary)
        select new.tenant_id,new.customer_id,trim(v_contact->>'full_name'),coalesce(v_contact->>'role',v_contact->>'title'),
          nullif(v_contact->>'email',''),nullif(v_contact->>'phone_e164',''),nullif(v_contact->>'alternate_phone_e164',''),false
        where not exists(select 1 from public.contact_people cp where cp.tenant_id=new.tenant_id and cp.customer_id=new.customer_id
          and lower(cp.full_name)=lower(trim(v_contact->>'full_name'))
          and coalesce(cp.phone_e164,'')=coalesce(v_contact->>'phone_e164','')
          and lower(coalesce(cp.email::text,''))=lower(coalesce(v_contact->>'email','')));
      end if;
    end loop;
  end if;
  return new;
end $$;
revoke all on function private.allocate_platform_entry_contacts() from public,anon,authenticated;
create trigger platform_allocation_contacts after insert on public.platform_list_allocation_entries for each row execute function private.allocate_platform_entry_contacts();
commit;
