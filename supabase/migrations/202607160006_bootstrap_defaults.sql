begin;

create or replace function public.bootstrap_tenant_defaults() returns trigger language plpgsql security definer set search_path=public as $$
declare p uuid; s1 uuid; s2 uuid; s3 uuid; s4 uuid; s5 uuid; s6 uuid; s7 uuid; s8 uuid;
begin
  insert into public.customer_statuses(tenant_id,key,label,color,sort_order,is_system) values
  (new.id,'new','Nytt prospekt','#64748b',10,true),(new.id,'assigned','Tilldelad','#6366f1',20,true),
  (new.id,'contacting','Kontaktförsök','#f59e0b',30,true),(new.id,'qualified','Kvalificerad','#06b6d4',40,true),
  (new.id,'interested','Intresserad','#8b5cf6',50,true),(new.id,'contract_sent','Avtal skickat','#3b82f6',60,true),
  (new.id,'signed','Signerat','#10b981',70,true),(new.id,'lost','Förlorad','#ef4444',80,true),
  (new.id,'blocked','Spärrad','#111827',90,true);
  insert into public.pipelines(tenant_id,name,pipeline_type) values(new.id,'Nyförsäljning','new_sales') returning id into p;
  insert into public.pipeline_stages(tenant_id,pipeline_id,name,sort_order,probability,color) values
  (new.id,p,'Nytt lead',10,5,'#64748b') returning id into s1;
  insert into public.pipeline_stages(tenant_id,pipeline_id,name,sort_order,probability,color) values
  (new.id,p,'Kontaktförsök',20,15,'#f59e0b'),(new.id,p,'Kontaktad',30,25,'#06b6d4'),(new.id,p,'Kvalificerad',40,45,'#8b5cf6'),
  (new.id,p,'Offert',50,65,'#3b82f6'),(new.id,p,'Avtal skickat',60,80,'#2563eb'),
  (new.id,p,'Signerat',70,100,'#10b981'),(new.id,p,'Förlorad',80,0,'#ef4444');
  return new;
end $$;
create trigger tenant_defaults after insert on public.tenants for each row execute function public.bootstrap_tenant_defaults();

-- Trigger was installed after the core onboarding function. Existing tenants can run this repair RPC once.
create or replace function public.ensure_tenant_defaults(p_tenant_id uuid) returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_tenant_admin(p_tenant_id) then raise exception 'admin_required'; end if;
  if not exists(select 1 from public.customer_statuses where tenant_id=p_tenant_id) then
    insert into public.customer_statuses(tenant_id,key,label,color,sort_order,is_system) values
    (p_tenant_id,'new','Nytt prospekt','#64748b',10,true),(p_tenant_id,'assigned','Tilldelad','#6366f1',20,true),
    (p_tenant_id,'contacting','Kontaktförsök','#f59e0b',30,true),(p_tenant_id,'qualified','Kvalificerad','#06b6d4',40,true),
    (p_tenant_id,'interested','Intresserad','#8b5cf6',50,true),(p_tenant_id,'contract_sent','Avtal skickat','#3b82f6',60,true),
    (p_tenant_id,'signed','Signerat','#10b981',70,true),(p_tenant_id,'lost','Förlorad','#ef4444',80,true),(p_tenant_id,'blocked','Spärrad','#111827',90,true);
  end if;
end $$;
grant execute on function public.ensure_tenant_defaults(uuid) to authenticated;

commit;
