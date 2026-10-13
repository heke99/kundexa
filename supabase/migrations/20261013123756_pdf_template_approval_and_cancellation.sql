begin;

create function public.guard_template_approval() returns trigger
language plpgsql set search_path=public as $$
begin
 if new.status='approved' and old.status is distinct from 'approved' then
   if new.signing_configuration->>'document_mode'='pdf' and not (new.signing_configuration ? 'pdf') then
     raise exception 'configured_pdf_template_required';
   end if;
   if coalesce(new.terms_template,'') like '%Här ska%juridiskt granskade%villkor%anges%' then
     raise exception 'unfinished_template_terms';
   end if;
 end if;
 return new;
end $$;
create trigger template_approval_guard before update on public.contract_template_versions
for each row execute function public.guard_template_approval();

create function public.queue_docuseal_cancellation() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if new.status in ('cancelled','expired','superseded') and old.status is distinct from new.status then
   update public.contract_signing_links l set revoked_at=now() from public.signing_envelopes e
     where e.tenant_id=new.tenant_id and e.contract_id=new.id and l.tenant_id=e.tenant_id and l.envelope_id=e.id and l.revoked_at is null;
   insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key,priority)
     select e.tenant_id,'docuseal.cancel','contract',e.contract_id,jsonb_build_object('envelope_id',e.id),
       'docuseal.cancel:'||e.id::text,5 from public.signing_envelopes e
     where e.tenant_id=new.tenant_id and e.contract_id=new.id and e.provider='docuseal'
       and e.status not in ('completed','declined','expired','cancelled','failed')
     on conflict(tenant_id,idempotency_key) do nothing;
 end if;
 return new;
end $$;
create trigger contract_docuseal_cancellation after update of status on public.contracts
for each row execute function public.queue_docuseal_cancellation();
revoke all on function public.queue_docuseal_cancellation() from public,anon,authenticated;

-- A provider event can arrive before its message-id write. Recover only a
-- cryptographically verified, already stored Resend event, matched by exact id.
create function public.reconcile_resend_delivery_events(p_limit integer default 100)
returns integer language plpgsql security definer set search_path=public as $$
declare r record; v_status text; v_count integer:=0; v_occurred timestamptz; v_result jsonb;
begin
 for r in select e.id,e.provider_event_id,e.event_type,e.payload,m.id as message_id,m.tenant_id
   from public.provider_webhook_events e join public.email_messages m
     on m.provider_message_id=coalesce(e.payload->'data'->>'email_id',e.payload->'data'->>'id')
   where e.provider='resend' and e.status in ('unmatched','failed','received')
     and e.headers->>'svix-signature-present'='true'
   order by e.received_at limit greatest(1,least(p_limit,500)) for update of e skip locked
 loop
   v_status:=case r.event_type when 'email.sent' then 'sent' when 'email.delivered' then 'delivered'
     when 'email.opened' then 'opened' when 'email.clicked' then 'clicked' when 'email.delivery_delayed' then 'delayed'
     when 'email.bounced' then 'bounced' when 'email.complained' then 'complained' when 'email.failed' then 'failed'
     when 'email.suppressed' then 'suppressed' else null end;
   if v_status is null then update public.provider_webhook_events set status='ignored' where id=r.id; continue; end if;
   begin v_occurred:=(r.payload->>'created_at')::timestamptz; exception when others then v_occurred:=now(); end;
   v_result:=public.apply_resend_delivery_event(r.tenant_id,r.message_id,r.provider_event_id,r.event_type,v_status,
     coalesce(v_occurred,now()),r.payload,left(coalesce(r.payload->'data'->'bounce'->>'message',r.payload->'data'->>'reason',r.event_type),500));
   update public.provider_webhook_events set tenant_id=r.tenant_id,status='processed',processed_at=now(),last_error=null where id=r.id;
   v_count:=v_count+1;
 end loop;
 return v_count;
end $$;
revoke all on function public.reconcile_resend_delivery_events(integer) from public,anon,authenticated;
grant execute on function public.reconcile_resend_delivery_events(integer) to service_role;

commit;
