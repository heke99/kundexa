begin;

alter table public.calls
  add column if not exists contact_person_id uuid;

do $$ begin
  alter table public.calls add constraint calls_contact_person_tenant_fk
    foreign key(tenant_id,contact_person_id) references public.contact_people(tenant_id,id) on delete set null;
exception when duplicate_object then null; end $$;

create index if not exists calls_contact_person_idx on public.calls(tenant_id,contact_person_id,created_at desc) where contact_person_id is not null;

-- Apply normalized import rows without a partial UPSERT that could accidentally
-- take the INSERT path and violate required import_rows columns.
create or replace function public.apply_import_row_normalization(p_import_run_id uuid,p_rows jsonb)
returns integer language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_count integer:=0;
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin','team_lead']) then raise exception 'import_manage_permission_required'; end if;
  if not exists(select 1 from public.import_runs where tenant_id=v_tenant and id=p_import_run_id) then raise exception 'import_run_not_found'; end if;
  if jsonb_typeof(coalesce(p_rows,'[]'::jsonb))<>'array' or jsonb_array_length(coalesce(p_rows,'[]'::jsonb))>500 then raise exception 'invalid_import_row_batch'; end if;

  with incoming as (
    select * from jsonb_to_recordset(coalesce(p_rows,'[]'::jsonb)) as x(
      id uuid, normalized_data jsonb, decision text, row_status text, error_code text, errors jsonb, warning_codes jsonb, source_external_id text
    )
  ), changed as (
    update public.import_rows r set
      normalized_data=coalesce(i.normalized_data,'{}'::jsonb),
      decision=i.decision, row_status=i.row_status, error_code=i.error_code,
      errors=coalesce(i.errors,'[]'::jsonb), warning_codes=coalesce(i.warning_codes,'[]'::jsonb),
      source_external_id=i.source_external_id, processing_ms=null
    from incoming i
    where r.tenant_id=v_tenant and r.import_run_id=p_import_run_id and r.id=i.id
    returning r.id
  ) select count(*) into v_count from changed;
  return v_count;
end $$;

-- Contact numbers are personal data. When they become candidates in an active
-- ring list, queue NIX checks using the tenant's existing provider configuration.
create or replace function public.queue_contact_nix_checks_for_customer(p_tenant_id uuid,p_customer_id uuid,p_requested_by uuid default null)
returns integer language plpgsql security definer set search_path=public as $$
declare v_cfg uuid; v_phone text; v_count integer:=0;
begin
  if not exists(
    select 1 from public.customer_list_members lm join public.customer_lists l on l.tenant_id=lm.tenant_id and l.id=lm.list_id
    where lm.tenant_id=p_tenant_id and lm.customer_id=p_customer_id and l.status='active' and l.archived_at is null
  ) then return 0; end if;
  select id into v_cfg from public.nix_provider_configurations where tenant_id=p_tenant_id and status='active' order by updated_at desc limit 1;
  if v_cfg is null then return 0; end if;
  for v_phone in
    select distinct phone from (
      select cp.phone_e164 phone from public.contact_people cp where cp.tenant_id=p_tenant_id and cp.customer_id=p_customer_id
      union all
      select cp.alternate_phone_e164 from public.contact_people cp where cp.tenant_id=p_tenant_id and cp.customer_id=p_customer_id
    ) p
    where phone ~ '^\+[1-9][0-9]{7,14}$'
      and not exists(select 1 from public.nix_checks nx where nx.tenant_id=p_tenant_id and nx.phone_e164=phone and nx.valid_until>now() and nx.result<>'error')
  loop
    insert into public.nix_check_jobs(tenant_id,configuration_id,customer_id,phone_e164,idempotency_key,requested_by)
    values(p_tenant_id,v_cfg,p_customer_id,v_phone,'nix:'||v_phone||':'||to_char(current_date,'YYYY-MM'),p_requested_by)
    on conflict do nothing;
    if found then v_count:=v_count+1; end if;
  end loop;
  return v_count;
end $$;

create or replace function public.queue_contact_nix_checks_trigger() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  perform public.queue_contact_nix_checks_for_customer(new.tenant_id,new.customer_id,coalesce(auth.uid(),new.added_by));
  return new;
end $$;

drop trigger if exists customer_list_members_queue_contact_nix on public.customer_list_members;
create trigger customer_list_members_queue_contact_nix after insert or update of state on public.customer_list_members
for each row execute function public.queue_contact_nix_checks_trigger();

create or replace function public.queue_contact_nix_checks_contact_trigger() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  perform public.queue_contact_nix_checks_for_customer(new.tenant_id,new.customer_id,auth.uid());
  return new;
end $$;

drop trigger if exists contact_people_queue_nix on public.contact_people;
create trigger contact_people_queue_nix after insert or update of phone_e164,alternate_phone_e164 on public.contact_people
for each row execute function public.queue_contact_nix_checks_contact_trigger();

-- Extend the existing atomic claim; do not introduce a second claiming model.
create or replace function public.claim_next_list_member(p_list_id uuid,p_session_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_list public.customer_lists%rowtype;
  v_session public.dialer_sessions%rowtype; v_member public.customer_list_members%rowtype; v_customer public.customers%rowtype;
  v_callback public.activities%rowtype; v_local timestamp; v_time time; v_callback_id uuid; v_notes jsonb;
begin
  if not public.can_work_customer_list(p_list_id) then raise exception 'list_work_permission_required'; end if;
  select * into v_list from public.customer_lists where tenant_id=v_tenant and id=p_list_id and status='active';
  if not found then raise exception 'list_not_active'; end if;
  select * into v_session from public.dialer_sessions where tenant_id=v_tenant and id=p_session_id and list_id=p_list_id and user_id=v_user and state<>'ended' for update;
  if not found then raise exception 'dialer_session_not_found'; end if;
  v_local:=now() at time zone v_list.timezone; v_time:=v_local::time;
  if not extract(isodow from v_local)::integer=any(v_list.allowed_days)
    or (v_list.allowed_start_time<=v_list.allowed_end_time and (v_time<v_list.allowed_start_time or v_time>v_list.allowed_end_time))
    or (v_list.allowed_start_time>v_list.allowed_end_time and (v_time<v_list.allowed_start_time and v_time>v_list.allowed_end_time))
  then raise exception 'outside_list_calling_hours'; end if;
  if v_list.starts_at is not null and v_list.starts_at>now() then raise exception 'list_not_started'; end if;
  if v_list.ends_at is not null and v_list.ends_at<=now() then raise exception 'list_ended'; end if;
  if exists(
    select 1 from public.customer_list_seller_assignments a where a.tenant_id=v_tenant and a.list_id=p_list_id and a.user_id=v_user
      and a.daily_capacity is not null and (
        select count(*) from public.calls c where c.tenant_id=v_tenant and c.list_id=p_list_id and c.user_id=v_user
          and (c.created_at at time zone v_list.timezone)::date=v_local::date
      )>=a.daily_capacity
  ) then raise exception 'seller_daily_capacity_reached'; end if;

  update public.customer_list_members set state=case when attempts>=v_list.max_attempts then 'completed' else 'retry' end,claimed_by=null,claim_expires_at=null
    where tenant_id=v_tenant and list_id=p_list_id and state in ('claimed','dialing') and claim_expires_at<now();
  update public.activities set status='open',claimed_by=null,claim_expires_at=null
    where tenant_id=v_tenant and list_id=p_list_id and type='callback' and status='in_progress' and claim_expires_at<now();

  if v_session.current_list_member_id is not null then
    select * into v_member from public.customer_list_members where tenant_id=v_tenant and id=v_session.current_list_member_id and claimed_by=v_user and claim_expires_at>now();
    v_callback_id:=v_session.current_callback_activity_id;
  end if;

  if v_member.id is null then
    select a.* into v_callback from public.activities a
    where a.tenant_id=v_tenant and a.list_id=p_list_id and a.type='callback' and a.status='open'
      and coalesce(a.snoozed_until,a.due_at)<=now()
      and (a.assigned_user_id=v_user or (a.callback_scope='global' and (a.assigned_team_id is null or exists(select 1 from public.team_members tm where tm.tenant_id=v_tenant and tm.team_id=a.assigned_team_id and tm.user_id=v_user))))
    order by coalesce(a.snoozed_until,a.due_at),a.created_at for update skip locked limit 1;
    if v_callback.id is not null then
      update public.activities set status='in_progress',claimed_by=v_user,claim_expires_at=now()+interval '10 minutes' where id=v_callback.id;
      select * into v_member from public.customer_list_members where tenant_id=v_tenant and list_id=p_list_id and customer_id=v_callback.customer_id for update;
      v_callback_id:=v_callback.id;
    end if;
  end if;

  if v_member.id is null then
    select lm.* into v_member from public.customer_list_members lm
    join public.customers c on c.tenant_id=lm.tenant_id and c.id=lm.customer_id
    where lm.tenant_id=v_tenant and lm.list_id=p_list_id and lm.state in ('pending','retry','callback','skipped')
      and (lm.next_attempt_at is null or lm.next_attempt_at<=now()) and lm.attempts<v_list.max_attempts
      and c.deleted_at is null and not c.do_not_call and c.lifecycle<>'blocked'
      and (
        c.phone_e164 is not null
        or c.alternate_phone_e164 is not null
        or exists(
          select 1
          from public.contact_people cp
          where cp.tenant_id=c.tenant_id and cp.customer_id=c.id
            and coalesce(cp.phone_e164,cp.alternate_phone_e164) is not null
            and exists(
              select 1 from public.nix_checks nx
              where nx.tenant_id=c.tenant_id
                and nx.phone_e164 in (cp.phone_e164,cp.alternate_phone_e164)
                and nx.valid_until>now() and nx.result='not_listed'
            )
        )
      )
      and public.evaluate_contact_policy_for_tenant(v_tenant,c.id,'call','direct_marketing')->>'allowed'='true'
      and (not v_list.lock_to_seller or lm.assigned_user_id is null or lm.assigned_user_id=v_user)
      and (lm.claimed_by is null or lm.claim_expires_at<now())
    order by case when lm.state='callback' then 0 else 1 end,lm.priority desc,lm.next_attempt_at nulls first,lm.created_at
    for update of lm skip locked limit 1;
  end if;

  if v_member.id is null then
    update public.dialer_sessions set current_list_member_id=null,current_callback_activity_id=null,current_call_id=null,last_seen_at=now() where id=p_session_id;
    return jsonb_build_object('empty',true,'sessionId',p_session_id);
  end if;
  update public.customer_list_members set state='claimed',claimed_by=v_user,claim_expires_at=now()+interval '10 minutes',assigned_user_id=coalesce(assigned_user_id,case when v_list.lock_to_seller then v_user else null end) where id=v_member.id returning * into v_member;
  update public.dialer_sessions set state='active',current_list_member_id=v_member.id,current_callback_activity_id=v_callback_id,current_call_id=null,last_seen_at=now() where id=p_session_id;
  select * into v_customer from public.customers where tenant_id=v_tenant and id=v_member.customer_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',n.id,'body',n.body,'isPinned',n.is_pinned,'createdAt',n.created_at) order by n.is_pinned desc,n.created_at desc),'[]'::jsonb)
    into v_notes from (select id,body,is_pinned,created_at from public.notes where tenant_id=v_tenant and customer_id=v_member.customer_id and archived_at is null order by is_pinned desc,created_at desc limit 8) n;
  return jsonb_build_object(
    'empty',false,'sessionId',p_session_id,'memberId',v_member.id,'callbackActivityId',v_callback_id,
    'mode',v_list.dialing_mode,'autoNextDelaySeconds',v_list.auto_next_delay_seconds,'allowSkip',v_list.allow_skip,
    'script',v_list.script,'questionnaire',v_list.questionnaire,
    'customer',jsonb_build_object('id',v_customer.id,'displayName',v_customer.display_name,'customerType',v_customer.customer_type,
      'companyName',v_customer.company_name,'organizationNumber',v_customer.organization_number,'phone',v_customer.phone_e164,'email',v_customer.email,
      'address',concat_ws(', ',v_customer.address_line1,v_customer.postal_code,v_customer.city),'industry',v_customer.industry,'sniCode',v_customer.sni_code,
      'callAttempts',v_member.attempts,'lastContactAt',v_customer.last_contact_at,'customFields',v_customer.custom_fields,'notes',v_notes)
  );
end $$;

create or replace function public.claim_next_list_member_with_contacts(p_list_id uuid,p_session_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_claim jsonb; v_tenant uuid:=public.current_tenant_id(); v_customer uuid; v_contacts jsonb; v_options jsonb; v_default jsonb;
begin
  v_claim:=public.claim_next_list_member(p_list_id,p_session_id);
  if coalesce((v_claim->>'empty')::boolean,false) then return v_claim; end if;
  v_customer:=(v_claim#>>'{customer,id}')::uuid;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',cp.id,'fullName',cp.full_name,'firstName',cp.first_name,'lastName',cp.last_name,
    'title',cp.title,'role',cp.role,'phone',cp.phone_e164,'alternatePhone',cp.alternate_phone_e164,
    'email',cp.email,'isPrimary',cp.is_primary,'ownershipPercentage',cp.ownership_percentage,'isSignatory',cp.is_signatory
  ) order by cp.is_primary desc,cp.full_name),'[]'::jsonb)
  into v_contacts from public.contact_people cp where cp.tenant_id=v_tenant and cp.customer_id=v_customer;

  with target_options as (
    select 0 sort_order,null::uuid contact_id,'company'::text source,'Företagets telefon'::text label,c.phone_e164 phone,'eligible'::text eligibility
      from public.customers c where c.tenant_id=v_tenant and c.id=v_customer and c.phone_e164 is not null
    union all
    select 1,null,'company','Företagets alternativa telefon',c.alternate_phone_e164,'eligible'
      from public.customers c where c.tenant_id=v_tenant and c.id=v_customer and c.alternate_phone_e164 is not null
    union all
    select 10+row_number() over(order by cp.is_primary desc,cp.full_name)::integer,cp.id,'contact',
      concat_ws(' · ',cp.full_name,nullif(coalesce(cp.role,cp.title),''),'primärt nummer'),cp.phone_e164,
      case nx.result when 'not_listed' then 'eligible' when 'listed' then 'blocked' else 'pending_nix' end
      from public.contact_people cp
      left join lateral (
        select n.result from public.nix_checks n where n.tenant_id=cp.tenant_id and n.phone_e164=cp.phone_e164 and n.valid_until>now() order by n.checked_at desc limit 1
      ) nx on true
      where cp.tenant_id=v_tenant and cp.customer_id=v_customer and cp.phone_e164 is not null
    union all
    select 100+row_number() over(order by cp.is_primary desc,cp.full_name)::integer,cp.id,'contact',
      concat_ws(' · ',cp.full_name,nullif(coalesce(cp.role,cp.title),''),'alternativt nummer'),cp.alternate_phone_e164,
      case nx.result when 'not_listed' then 'eligible' when 'listed' then 'blocked' else 'pending_nix' end
      from public.contact_people cp
      left join lateral (
        select n.result from public.nix_checks n where n.tenant_id=cp.tenant_id and n.phone_e164=cp.alternate_phone_e164 and n.valid_until>now() order by n.checked_at desc limit 1
      ) nx on true
      where cp.tenant_id=v_tenant and cp.customer_id=v_customer and cp.alternate_phone_e164 is not null
  ), distinct_options as (
    select distinct on(phone,coalesce(contact_id,'00000000-0000-0000-0000-000000000000'::uuid)) * from target_options
    where phone ~ '^\+[1-9][0-9]{7,14}$' order by phone,coalesce(contact_id,'00000000-0000-0000-0000-000000000000'::uuid),sort_order
  )
  select coalesce(jsonb_agg(jsonb_build_object('contactPersonId',contact_id,'source',source,'label',label,'phone',phone,'eligibility',eligibility) order by (eligibility='eligible') desc,sort_order),'[]'::jsonb),
    (jsonb_agg(jsonb_build_object('contactPersonId',contact_id,'source',source,'label',label,'phone',phone,'eligibility',eligibility) order by (eligibility='eligible') desc,sort_order)->0)
  into v_options,v_default from distinct_options;

  return v_claim || jsonb_build_object('contacts',v_contacts,'phoneOptions',v_options,'defaultTarget',v_default);
end $$;

create or replace function public.queue_outbound_call_target(
  p_customer_id uuid,p_contact_person_id uuid,p_target_phone text,
  p_callback_token_hash text,p_callback_token text,p_voice_client_number text,p_idempotency_key text,
  p_purpose text default 'direct_marketing'
) returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_customer public.customers%rowtype;
  v_contact public.contact_people%rowtype; v_number public.phone_numbers%rowtype; v_call uuid; v_nix text;
begin
  if v_user is null or v_tenant is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin','team_lead','sales']) then raise exception 'call_create_permission_required'; end if;
  if nullif(trim(p_callback_token_hash),'') is null or nullif(trim(p_callback_token),'') is null then raise exception 'callback_token_required'; end if;
  if p_voice_client_number !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'voice_client_number_invalid'; end if;
  if p_target_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'target_phone_invalid'; end if;
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'idempotency_key_required'; end if;
  select id into v_call from public.calls where tenant_id=v_tenant and idempotency_key=p_idempotency_key;
  if v_call is not null then return v_call; end if;
  select * into v_customer from public.customers where tenant_id=v_tenant and id=p_customer_id and deleted_at is null;
  if not found then raise exception 'customer_not_found'; end if;

  if p_contact_person_id is null then
    if p_target_phone is distinct from v_customer.phone_e164 and p_target_phone is distinct from v_customer.alternate_phone_e164 then raise exception 'target_phone_customer_mismatch'; end if;
  else
    select * into v_contact from public.contact_people where tenant_id=v_tenant and id=p_contact_person_id and customer_id=p_customer_id;
    if not found then raise exception 'contact_person_not_found'; end if;
    if p_target_phone is distinct from v_contact.phone_e164 and p_target_phone is distinct from v_contact.alternate_phone_e164 then raise exception 'target_phone_contact_mismatch'; end if;
    if p_purpose in ('direct_marketing','automation_marketing') then
      select n.result into v_nix from public.nix_checks n where n.tenant_id=v_tenant and n.phone_e164=p_target_phone and n.valid_until>now() order by n.checked_at desc limit 1;
      if v_nix is null or v_nix in ('unknown','error') then raise exception 'target_nix_check_required'; end if;
      if v_nix<>'not_listed' then raise exception 'target_nix_%',v_nix; end if;
    end if;
  end if;

  select * into v_number from public.phone_numbers where tenant_id=v_tenant and supports_voice and status='active' order by created_at,id limit 1;
  if not found then raise exception 'voice_number_missing'; end if;
  insert into public.calls(
    tenant_id,customer_id,contact_person_id,phone_number_id,user_id,direction,from_number,to_number,status,
    callback_token_hash,metadata,idempotency_key,purpose
  ) values (
    v_tenant,p_customer_id,p_contact_person_id,v_number.id,v_user,'outbound',v_number.number_e164,p_target_phone,'queued',
    p_callback_token_hash,jsonb_build_object('mode','webrtc_bridge','target_source',case when p_contact_person_id is null then 'customer' else 'contact_person' end),p_idempotency_key,p_purpose
  ) returning id into v_call;
  insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key)
    values(v_tenant,'call.start','call',v_call,jsonb_build_object('call_id',v_call,'callback_token',p_callback_token,'voice_client_number',p_voice_client_number),'call.start:'||v_call::text);
  insert into public.activities(tenant_id,customer_id,type,status,title,assigned_user_id,created_by,metadata)
    values(v_tenant,p_customer_id,'call','in_progress','Utgående samtal',v_user,v_user,jsonb_build_object('call_id',v_call,'contact_person_id',p_contact_person_id,'target_phone',p_target_phone));
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_tenant,v_user,'call.queued','call',v_call::text,jsonb_build_object('customer_id',p_customer_id,'contact_person_id',p_contact_person_id,'target_phone_masked',right(p_target_phone,4),'purpose',p_purpose));
  return v_call;
end $$;

create or replace function public.queue_list_outbound_call_target(
  p_session_id uuid,p_list_member_id uuid,p_callback_activity_id uuid,p_contact_person_id uuid,p_target_phone text,
  p_callback_token_hash text,p_callback_token text,p_voice_client_number text,p_idempotency_key text,p_purpose text default 'direct_marketing'
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_member public.customer_list_members%rowtype; v_session public.dialer_sessions%rowtype; v_list public.customer_lists%rowtype; v_call uuid;
begin
  select * into v_session from public.dialer_sessions where tenant_id=v_tenant and id=p_session_id and user_id=v_user and state in ('active','after_call') for update;
  if not found then raise exception 'dialer_session_not_active'; end if;
  select * into v_member from public.customer_list_members where tenant_id=v_tenant and id=p_list_member_id and list_id=v_session.list_id and claimed_by=v_user and claim_expires_at>now() for update;
  if not found then raise exception 'list_member_claim_expired'; end if;
  if p_callback_activity_id is distinct from v_session.current_callback_activity_id then raise exception 'callback_claim_mismatch'; end if;
  select * into v_list from public.customer_lists where tenant_id=v_tenant and id=v_session.list_id;
  v_call:=public.queue_outbound_call_target(v_member.customer_id,p_contact_person_id,p_target_phone,p_callback_token_hash,p_callback_token,p_voice_client_number,p_idempotency_key,p_purpose);
  update public.calls set list_id=v_member.list_id,list_member_id=v_member.id,dialer_session_id=p_session_id,callback_activity_id=p_callback_activity_id,
    phone_number_id=coalesce(v_list.outbound_phone_number_id,phone_number_id),
    from_number=coalesce((select number_e164 from public.phone_numbers where tenant_id=v_tenant and id=v_list.outbound_phone_number_id and status='active' and supports_voice),from_number),
    recording_enabled=coalesce((v_list.settings->>'recordingEnabled')::boolean,false),
    metadata=metadata||jsonb_build_object('mode','list_dialer','list_id',v_member.list_id,'list_member_id',v_member.id,'dialer_session_id',p_session_id)
    where tenant_id=v_tenant and id=v_call;
  update public.customer_list_members set state='dialing',attempts=attempts+1,last_call_id=v_call,last_contacted_at=now(),claim_expires_at=now()+interval '2 hours' where id=v_member.id;
  update public.dialer_sessions set state='calling',current_call_id=v_call,last_seen_at=now() where id=p_session_id;
  return v_call;
end $$;

revoke all on function public.apply_import_row_normalization(uuid,jsonb) from public,anon;
grant execute on function public.apply_import_row_normalization(uuid,jsonb) to authenticated,service_role;
revoke all on function public.queue_contact_nix_checks_for_customer(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.queue_contact_nix_checks_for_customer(uuid,uuid,uuid) to service_role;
grant execute on function public.claim_next_list_member_with_contacts(uuid,uuid) to authenticated;
grant execute on function public.queue_outbound_call_target(uuid,uuid,text,text,text,text,text,text) to authenticated;
grant execute on function public.queue_list_outbound_call_target(uuid,uuid,uuid,uuid,text,text,text,text,text,text) to authenticated;

commit;
