begin;
create table private.inbound_call_routes (
 external_call_id text primary key,tenant_id uuid,call_id uuid,phone_number_id uuid,user_id uuid,session_id uuid,
 state text not null check(state in ('rejected','offered','accepting','answered','declined','ended','expired')),
 reason text,expires_at timestamptz not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(tenant_id,call_id) references public.calls(tenant_id,id) on delete cascade,
 foreign key(tenant_id,phone_number_id) references public.phone_numbers(tenant_id,id),
 foreign key(tenant_id,session_id) references public.webphone_sessions(tenant_id,id),
 check(state='rejected' or (tenant_id is not null and call_id is not null and user_id is not null and session_id is not null))
);
alter table private.inbound_call_routes enable row level security;
revoke all on private.inbound_call_routes from public,anon,authenticated,service_role;
create unique index inbound_call_routes_live_user_idx on private.inbound_call_routes(tenant_id,user_id) where state in ('offered','accepting','answered');
-- Cover routing history and composite-FK cleanup without scanning all tenants.
create index inbound_call_routes_recipient_history_idx on private.inbound_call_routes(tenant_id,user_id,created_at desc);
create index inbound_call_routes_call_idx on private.inbound_call_routes(tenant_id,call_id);
create index inbound_call_routes_number_idx on private.inbound_call_routes(tenant_id,phone_number_id);
create index inbound_call_routes_session_idx on private.inbound_call_routes(tenant_id,session_id);
create index inbound_call_routes_expiry_idx on private.inbound_call_routes(expires_at) where state in ('offered','accepting','answered');

create function public.configure_inbound_number(p_number_id uuid,p_user_id uuid,p_team_id uuid,p_enabled boolean)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare tenant uuid:=public.current_tenant_id(); actor uuid:=auth.uid(); n public.phone_numbers%rowtype;
begin
 if tenant is null or actor is null or not public.has_current_role(array['owner','admin']) then raise exception 'tenant_admin_required'; end if;
 if p_enabled is null then raise exception 'inbound_enabled_required'; end if;
 select * into n from public.phone_numbers where tenant_id=tenant and id=p_number_id and status='active' and supports_voice for update;
 if not found then raise exception 'voice_number_not_found'; end if;
 if p_enabled then
  if p_user_id is null and p_team_id is null then raise exception 'inbound_recipient_required'; end if;
  if p_user_id is not null and not exists(select 1 from public.tenant_memberships where tenant_id=tenant and user_id=p_user_id and status='active' and role in ('owner','admin','team_lead','sales')) then raise exception 'inbound_active_recipient_required'; end if;
  if p_team_id is not null and not exists(select 1 from public.teams where tenant_id=tenant and id=p_team_id and status='active') then raise exception 'inbound_active_team_required'; end if;
  if p_user_id is not null and p_team_id is not null and not exists(select 1 from public.team_members where tenant_id=tenant and user_id=p_user_id and team_id=p_team_id and not assignment_paused) then raise exception 'inbound_recipient_not_in_team'; end if;
  update public.phone_numbers set assigned_user_id=p_user_id,assigned_team_id=p_team_id,updated_at=now() where tenant_id=tenant and id=n.id;
 end if;
 insert into public.tenant_features(tenant_id,feature_key,enabled,configuration,updated_at)
 values(tenant,'inbound_calls:'||n.id::text,p_enabled,'{}',now())
 on conflict(tenant_id,feature_key) do update set enabled=excluded.enabled,updated_at=now();
 insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
 values(tenant,actor,'telephony.inbound_number_configured','phone_number',n.id::text,jsonb_build_object('enabled',p_enabled,'user_id',p_user_id,'team_id',p_team_id));
end $$;
revoke all on function public.configure_inbound_number(uuid,uuid,uuid,boolean) from public,anon,service_role;
grant execute on function public.configure_inbound_number(uuid,uuid,uuid,boolean) to authenticated;

create function private.inbound_route_available(p_external_call_id text) returns boolean
language sql stable security definer set search_path=public,private,pg_temp as $$
 select exists(select 1 from private.inbound_call_routes r
 join public.webphone_sessions w on w.tenant_id=r.tenant_id and w.id=r.session_id and w.seller_user_id=r.user_id
 join public.tenant_memberships m on m.tenant_id=r.tenant_id and m.user_id=r.user_id and m.status='active' and m.role in ('owner','admin','team_lead','sales')
 join public.profiles p on p.id=r.user_id and p.active_tenant_id=r.tenant_id
 join public.tenants t on t.id=r.tenant_id and t.status in ('trial','active') and t.onboarding_status='active'
 join public.phone_numbers n on n.tenant_id=r.tenant_id and n.id=r.phone_number_id and n.status='active' and n.supports_voice
 join public.telephony_policies policy on policy.tenant_id=r.tenant_id and policy.telephony_enabled and not policy.recording_enabled
 join public.tenant_features f on f.tenant_id=r.tenant_id and f.feature_key='inbound_calls:'||n.id::text and f.enabled
 where r.external_call_id=p_external_call_id and r.state in ('offered','accepting','answered') and r.expires_at>now()
 and w.provider='sinch' and w.status='registered' and w.registration_id=w.id::text and w.last_heartbeat_at>now()-interval '90 seconds'
 and (n.assigned_user_id is null or n.assigned_user_id=r.user_id)
 and (n.assigned_team_id is null or exists(select 1 from public.team_members tm join public.teams team on team.tenant_id=tm.tenant_id and team.id=tm.team_id and team.status='active' where tm.tenant_id=r.tenant_id and tm.user_id=r.user_id and tm.team_id=n.assigned_team_id and not tm.assignment_paused))
 and (n.assigned_user_id is not null or n.assigned_team_id is not null));
$$;
revoke all on function private.inbound_route_available(text) from public,anon,authenticated,service_role;

-- Caller-ID strings are data, never destinations. Unknown/withheld caller IDs
-- remain anonymous instead of preventing legitimate inbound routing.
create function private.inbound_e164(value text) returns text language sql immutable set search_path=pg_catalog as $$
 select case when value ~ '^\+[1-9][0-9]{7,14}$' then value when value ~ '^[1-9][0-9]{7,14}$' then '+'||value else null end
$$;
revoke all on function private.inbound_e164(text) from public,anon,authenticated,service_role;

create function public.expire_inbound_calls(p_limit integer default 200) returns integer
language plpgsql security definer set search_path=public,private,pg_temp as $$
declare r private.inbound_call_routes%rowtype; count integer:=0;
begin
 if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
 for r in select route.* from private.inbound_call_routes route where route.state in ('offered','accepting','answered') and
  (route.expires_at<=now() or not exists(select 1 from public.webphone_sessions w where w.tenant_id=route.tenant_id and w.id=route.session_id and w.status='registered' and w.last_heartbeat_at>now()-interval '5 minutes'))
  order by expires_at limit greatest(1,least(coalesce(p_limit,200),1000)) for update skip locked loop
  update private.inbound_call_routes set state='expired',reason='offer_or_session_expired',updated_at=now() where external_call_id=r.external_call_id;
  update public.calls set status=case when r.state='answered' then 'failed' else 'unanswered' end,ended_at=coalesce(ended_at,now()),end_cause='inbound_lease_expired',provider_status='outcome_unknown',
   metadata=metadata||jsonb_build_object('reconciliation_required',r.state='answered'),updated_at=now() where tenant_id=r.tenant_id and id=r.call_id and ended_at is null;
  insert into public.call_events(tenant_id,call_id,event_type,payload) values(r.tenant_id,r.call_id,'inbound.offer_expired',jsonb_build_object('previous_state',r.state));
  count:=count+1;
 end loop;
 -- Rejected callbacks contain no customer data and cannot reserve a seller.
 delete from private.inbound_call_routes where state='rejected' and expires_at<now();
 return count;
end $$;
revoke all on function public.expire_inbound_calls(integer) from public,anon,authenticated;
grant execute on function public.expire_inbound_calls(integer) to service_role;

-- Keep the canonical outgoing event reducer, but accept only a live exact
-- session identity in addition to the historical user identity during rollout.
do $$ declare original text; revised text;
begin
 select pg_get_functiondef('public.ingest_sinch_voice_event(text,text,text,jsonb,timestamptz)'::regprocedure) into original;
 revised:=replace(original, 'a.seller_user_id::text = p_payload->>''user''',
 '(a.seller_user_id::text = p_payload->>''user'' or exists(select 1 from public.webphone_sessions w where w.tenant_id=a.tenant_id and w.seller_user_id=a.seller_user_id and w.id::text=p_payload->>''user'' and w.id=a.webphone_session_id and w.status=''registered'' and w.last_heartbeat_at>now()-interval ''90 seconds''))');
 if original=revised then raise exception 'sinch_session_identity_anchor_missing'; end if;
 execute revised;
end $$;
alter function public.ingest_sinch_voice_event(text,text,text,jsonb,timestamptz) rename to ingest_sinch_outgoing_event;
revoke all on function public.ingest_sinch_outgoing_event(text,text,text,jsonb,timestamptz) from public,anon,authenticated,service_role;

create function public.ingest_sinch_voice_event(p_event text,p_external_call_id text,p_provider_event_id text,p_payload jsonb,p_received_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare r private.inbound_call_routes%rowtype; n public.phone_numbers%rowtype; w public.webphone_sessions%rowtype;
 target text; caller text; candidates integer; c uuid; event_id uuid; candidate record; answered boolean; duration integer;
begin
 if auth.role()<>'service_role' then raise exception 'service_role_required'; end if;
 if p_external_call_id is null or length(p_external_call_id)>200 or p_provider_event_id is null then raise exception 'provider_call_identity_required'; end if;
 if p_event='ice' and lower(coalesce(p_payload->>'originationType',''))='pstn' then
  perform public.expire_inbound_calls(200);
  perform pg_advisory_xact_lock(hashtextextended('inbound:'||p_external_call_id,0));
  select * into r from private.inbound_call_routes where external_call_id=p_external_call_id;
  if found then
   return jsonb_build_object('connect',r.state in ('offered','accepting') and private.inbound_route_available(p_external_call_id) and exists(select 1 from public.calls where tenant_id=r.tenant_id and id=r.call_id and to_number=private.inbound_e164(p_payload#>>'{to,endpoint}')),
    'incoming',true,'sessionId',r.session_id,'destination',private.inbound_e164(p_payload#>>'{to,endpoint}'),'duplicate',true);
  end if;
  insert into private.inbound_call_routes(external_call_id,state,expires_at,reason) values(p_external_call_id,'rejected',now()+interval '7 days','not_routable');
  insert into public.provider_webhook_events(provider,event_type,provider_event_id,payload,received_at,status)
   values('sinch',p_event,p_provider_event_id,p_payload,p_received_at,'unmatched') on conflict(provider,provider_event_id) do nothing returning id into event_id;
  target:=private.inbound_e164(p_payload#>>'{to,endpoint}');
  select count(*) into candidates from public.phone_numbers where number_e164=target and status='active' and supports_voice;
  if candidates<>1 then return jsonb_build_object('connect',false,'incoming',true); end if;
  select * into n from public.phone_numbers where number_e164=target and status='active' and supports_voice for share;
  if not exists(select 1 from public.tenants where id=n.tenant_id and status in ('trial','active') and onboarding_status='active')
   or not exists(select 1 from public.telephony_policies where tenant_id=n.tenant_id and telephony_enabled and not recording_enabled)
   or not exists(select 1 from public.tenant_features where tenant_id=n.tenant_id and feature_key='inbound_calls:'||n.id::text and enabled)
   or (n.integration_id is not null and not exists(select 1 from public.tenant_integrations where tenant_id=n.tenant_id and id=n.integration_id and provider='sinch' and status='active'))
   or (n.assigned_user_id is null and n.assigned_team_id is null) then return jsonb_build_object('connect',false,'incoming',true); end if;
  for candidate in select s.id,s.seller_user_id from public.webphone_sessions s
   join public.tenant_memberships m on m.tenant_id=s.tenant_id and m.user_id=s.seller_user_id and m.status='active' and m.role in ('owner','admin','team_lead','sales')
   join public.profiles p on p.id=s.seller_user_id and p.active_tenant_id=s.tenant_id
   where s.tenant_id=n.tenant_id and s.provider='sinch' and s.status='registered' and s.registration_id=s.id::text and s.last_heartbeat_at>now()-interval '90 seconds'
   and not exists(select 1 from public.dialer_sessions d where d.tenant_id=s.tenant_id and d.user_id=s.seller_user_id and d.state not in ('ended','paused'))
   and (n.assigned_user_id is null or s.seller_user_id=n.assigned_user_id)
   and (n.assigned_team_id is null or exists(select 1 from public.team_members tm join public.teams t on t.tenant_id=tm.tenant_id and t.id=tm.team_id and t.status='active' where tm.tenant_id=n.tenant_id and tm.user_id=s.seller_user_id and tm.team_id=n.assigned_team_id and not tm.assignment_paused))
   order by (select max(created_at) from private.inbound_call_routes where tenant_id=s.tenant_id and user_id=s.seller_user_id) nulls first,s.seller_user_id
  loop
   perform pg_advisory_xact_lock(hashtextextended(n.tenant_id::text||':'||candidate.seller_user_id::text,0));
   if exists(select 1 from public.dial_attempts where tenant_id=n.tenant_id and seller_user_id=candidate.seller_user_id and public.dial_attempt_holds_seat(status))
    or exists(select 1 from private.inbound_call_routes where tenant_id=n.tenant_id and user_id=candidate.seller_user_id and state in ('offered','accepting','answered')) then continue; end if;
   select * into w from public.webphone_sessions where id=candidate.id and tenant_id=n.tenant_id and status='registered' and last_heartbeat_at>now()-interval '90 seconds' for share;
   if found then exit; end if;
  end loop;
  if w.id is null then return jsonb_build_object('connect',false,'incoming',true); end if;
  caller:=coalesce(private.inbound_e164(p_payload->>'cli'),private.inbound_e164(p_payload#>>'{from,endpoint}'),'anonymous');
  insert into public.calls(tenant_id,provider,provider_call_id,external_call_id,phone_number_id,user_id,team_id,direction,from_number,to_number,status,callback_token_hash,started_at,recording_enabled,recording_status,metadata,purpose)
  values(n.tenant_id,'sinch',p_external_call_id,p_external_call_id,n.id,w.seller_user_id,n.assigned_team_id,'inbound',caller,target,'ringing',md5(p_external_call_id||gen_random_uuid()::text),now(),false,'not_expected',jsonb_build_object('inbound_session_id',w.id,'answered_at_source',null),'customer_service') returning id into c;
  update private.inbound_call_routes set tenant_id=n.tenant_id,call_id=c,phone_number_id=n.id,user_id=w.seller_user_id,session_id=w.id,state='offered',reason=null,expires_at=now()+interval '60 seconds',updated_at=now() where external_call_id=p_external_call_id;
  update public.provider_webhook_events set tenant_id=n.tenant_id,status='processed',processed_at=now() where id=event_id;
  insert into public.call_events(tenant_id,call_id,event_type,payload) values(n.tenant_id,c,'inbound.offered',jsonb_build_object('session_id',w.id));
  return jsonb_build_object('incoming',true,'connect',true,'sessionId',w.id,'destination',target);
 end if;
 select * into r from private.inbound_call_routes where external_call_id=p_external_call_id for update;
 if found then
  if r.state='rejected' then return jsonb_build_object('matched',false); end if;
  insert into public.provider_webhook_events(provider,event_type,provider_event_id,payload,received_at,status,tenant_id)
   values('sinch',p_event,p_provider_event_id,p_payload,p_received_at,'processed',r.tenant_id) on conflict(provider,provider_event_id) do nothing returning id into event_id;
  if event_id is null then return jsonb_build_object('duplicate',true,'matched',true); end if;
  if p_event='dice' and not exists(select 1 from public.calls where tenant_id=r.tenant_id and id=r.call_id and metadata->>'inbound_provider_final'='true') then
   answered:=upper(coalesce(p_payload->>'result',''))='ANSWERED';
   duration:=case when p_payload->>'duration' ~ '^[0-9]{1,7}$' then least((p_payload->>'duration')::integer,86400) else null end;
   perform set_config('kundexa.provider_authoritative','on',true);
   update public.calls set status=case when answered then 'completed' when upper(coalesce(p_payload->>'result',''))='BUSY' then 'busy' else 'unanswered' end,
    answered_at=case when answered then coalesce(answered_at,now()-make_interval(secs=>coalesce(duration,0))) else null end,
    ended_at=coalesce(ended_at,now()),duration_seconds=duration,provider_status='ended',end_cause=left(coalesce(p_payload->>'reason','provider_ended'),100),
    metadata=metadata||jsonb_build_object('provider_answered',answered,'answered_at_source','provider_dice','reconciliation_required',false,'inbound_provider_final',true),updated_at=now() where tenant_id=r.tenant_id and id=r.call_id;
   update private.inbound_call_routes set state='ended',updated_at=now() where external_call_id=p_external_call_id;
   insert into public.call_events(tenant_id,call_id,event_type,payload) values(r.tenant_id,r.call_id,'sinch.inbound_ended',jsonb_build_object('source','provider','answered',answered));
  end if;
  return jsonb_build_object('matched',true,'incoming',true);
 end if;
 return public.ingest_sinch_outgoing_event(p_event,p_external_call_id,p_provider_event_id,p_payload,p_received_at);
end $$;
revoke all on function public.ingest_sinch_voice_event(text,text,text,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.ingest_sinch_voice_event(text,text,text,jsonb,timestamptz) to service_role;

create function public.inbound_call_command(p_session_id uuid,p_external_call_id text,p_action text) returns jsonb
language plpgsql security definer set search_path=public,private,pg_temp as $$
declare tenant uuid:=public.current_tenant_id(); actor uuid:=auth.uid(); r private.inbound_call_routes%rowtype; c public.calls%rowtype;
begin
 if tenant is null or actor is null or not public.has_current_role(array['owner','admin','team_lead','sales']) then raise exception 'call_permission_required'; end if;
 if p_action not in ('inspect','accept','decline','established','end') or p_action is null then raise exception 'inbound_action_invalid'; end if;
 select * into r from private.inbound_call_routes where external_call_id=p_external_call_id and tenant_id=tenant and user_id=actor and session_id=p_session_id for update;
 if not found then raise exception 'inbound_offer_not_found'; end if;
 select * into c from public.calls where tenant_id=tenant and id=r.call_id;
 if r.state in ('declined','ended','expired','rejected') then return jsonb_build_object('available',false,'state',r.state); end if;
 if r.expires_at<=now() or not exists(select 1 from public.webphone_sessions where tenant_id=tenant and id=p_session_id and seller_user_id=actor and status='registered' and registration_id=id::text and last_heartbeat_at>now()-interval '90 seconds') then raise exception 'inbound_offer_expired'; end if;
 if p_action in ('accept','inspect','established') and not private.inbound_route_available(p_external_call_id) then raise exception 'inbound_route_no_longer_available'; end if;
 if p_action='accept' then
  if r.state<>'offered' then return jsonb_build_object('available',false,'state',r.state); end if;
  update private.inbound_call_routes set state='accepting',updated_at=now() where external_call_id=r.external_call_id;
 elsif p_action='established' then
  if r.state='answered' then return jsonb_build_object('available',true,'callId',r.call_id,'state',r.state,'expiresAt',r.expires_at); end if;
  if r.state not in ('accepting','answered') then raise exception 'inbound_acceptance_required'; end if;
  update private.inbound_call_routes set state='answered',expires_at=now()+interval '2 hours',updated_at=now() where external_call_id=r.external_call_id;
  update public.calls set status='answered',answered_at=coalesce(answered_at,now()),metadata=metadata||jsonb_build_object('answered_at_source','client_established'),updated_at=now() where tenant_id=tenant and id=r.call_id and ended_at is null;
 elsif p_action in ('decline','end') then
  if p_action='decline' and r.state='answered' then raise exception 'inbound_call_already_answered'; end if;
  update private.inbound_call_routes set state=case when p_action='decline' then 'declined' else 'ended' end,updated_at=now() where external_call_id=r.external_call_id;
  update public.calls set status=case when r.state='answered' then 'completed' else 'unanswered' end,ended_at=coalesce(ended_at,now()),end_cause='client_'||p_action,updated_at=now() where tenant_id=tenant and id=r.call_id and ended_at is null;
 end if;
 if p_action='established' and r.state='answered' then return jsonb_build_object('available',true,'callId',r.call_id,'state',r.state,'expiresAt',r.expires_at); end if;
 if p_action<>'inspect' then
  insert into public.call_events(tenant_id,call_id,event_type,payload) values(tenant,r.call_id,'inbound.client_'||p_action,jsonb_build_object('user_id',actor,'session_id',p_session_id));
 end if;
 select * into r from private.inbound_call_routes where external_call_id=p_external_call_id;
 return jsonb_build_object('available',r.state in ('offered','accepting','answered'),'callId',r.call_id,'from',c.from_number,'expiresAt',r.expires_at,'state',case when p_action='accept' then 'accepting' when p_action='established' then 'answered' else r.state end);
end $$;
revoke all on function public.inbound_call_command(uuid,text,text) from public,anon,service_role;
grant execute on function public.inbound_call_command(uuid,text,text) to authenticated;

-- The same seller mutex fences incoming and outgoing reservations.
do $$ declare original text; revised text;
begin
 select pg_get_functiondef('public.reserve_outbound_call(uuid,uuid,text,uuid,uuid,uuid,uuid,text,text,uuid,uuid)'::regprocedure) into original;
 revised:=replace(original,'  if exists(
    select 1 from public.dial_attempts',
 '  if exists(select 1 from private.inbound_call_routes where tenant_id=v_tenant and user_id=v_user and expires_at>now() and state in (''offered'',''accepting'',''answered'')) then raise exception ''active_inbound_call_exists''; end if;
  if exists(
    select 1 from public.dial_attempts');
 if original=revised then raise exception 'inbound_outbound_mutex_anchor_missing'; end if;
 execute revised;
end $$;
commit;
