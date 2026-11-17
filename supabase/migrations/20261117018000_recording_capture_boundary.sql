begin;
-- No recording destination has been configured. Do not advertise an unrecorded
-- call as satisfying a mandatory recording policy. Replace this boundary only
-- when capture, private import, playback and source deletion are verified.
create function private.enforce_recording_capture_boundary() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.provider_request_started_at is not null and old.provider_request_started_at is null
 and exists(select 1 from public.calls c join public.telephony_policies p on p.tenant_id=c.tenant_id
   where c.tenant_id=new.tenant_id and c.id=new.call_id and (c.recording_enabled or p.recording_enabled)) then
  raise exception 'recording_capture_not_ready';
 end if;
 return new;
end $$;
revoke all on function private.enforce_recording_capture_boundary() from public,anon,authenticated,service_role;
create trigger recording_capture_before_sdk before update on public.dial_attempts
 for each row execute function private.enforce_recording_capture_boundary();

alter function public.ingest_sinch_voice_event(text,text,text,jsonb,timestamptz) rename to ingest_sinch_routed_event;
revoke all on function public.ingest_sinch_routed_event(text,text,text,jsonb,timestamptz) from public,anon,authenticated,service_role;
create function public.ingest_sinch_voice_event(p_event text,p_external_call_id text,p_provider_event_id text,p_payload jsonb,p_received_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; c public.calls%rowtype;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'service_role_required'; end if;
 result:=public.ingest_sinch_routed_event(p_event,p_external_call_id,p_provider_event_id,p_payload,p_received_at);
 if p_event='ice' and result->>'connect'='true' then
  select call.* into c from public.calls call where call.provider='sinch' and (call.external_call_id=p_external_call_id or exists(select 1 from public.dial_attempts a where a.tenant_id=call.tenant_id and a.call_id=call.id and a.provider='sinch' and a.external_call_id=p_external_call_id));
  if not found then return result||jsonb_build_object('connect',false); end if;
  if c.recording_enabled or exists(select 1 from public.telephony_policies where tenant_id=c.tenant_id and recording_enabled) then
   insert into public.call_events(tenant_id,call_id,event_type,payload)
   select c.tenant_id,c.id,'recording.capture_blocked','{"reason":"recording_capture_not_ready"}'::jsonb
   where not exists(select 1 from public.call_events where tenant_id=c.tenant_id and call_id=c.id and event_type='recording.capture_blocked');
   return result||jsonb_build_object('connect',false,'reason','recording_capture_not_ready');
  end if;
 end if;
 return result;
end $$;
revoke all on function public.ingest_sinch_voice_event(text,text,text,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.ingest_sinch_voice_event(text,text,text,jsonb,timestamptz) to service_role;
commit;
