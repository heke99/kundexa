-- Kodgranskningen 2026-09-24 (FAILURE-0137…0139).
--
-- - Ett listsamtal prövade inte återkomst-id:t. Reservationen och efterarbetet
--   tog och stängde därför den aktivitet id:t pekade på, oavsett typ, ägare
--   eller kund.
-- - Kön kunde ge en återkomst tillsammans med ett annat prospekt, när
--   återkomstens kund saknade listplats.
-- - Webbläsarens egen rapport om att kunden svarat stod kvar även när DiCE
--   sade att ingen svarade. Leverantörens slutbesked rättar nu samtalsraden.
--   Avtalsbehörigheten ändras inte: ett avtal kräver ingen leverantörs-
--   bekräftelse och kan fortfarande skickas efter ett manuellt registrerat samtal.
--
-- Varje funktion ersätts i sin helhet från sin senaste definition; bara de
-- markerade stegen är nya. `create or replace` behåller EXECUTE-rättigheterna.

-- 1. Reservationen prövar återkomsten även på listsamtal.
CREATE OR REPLACE FUNCTION public.reserve_outbound_call(p_customer_id uuid, p_contact_person_id uuid, p_target_phone text, p_session_id uuid, p_list_member_id uuid, p_callback_activity_id uuid, p_client_request_id uuid, p_idempotency_key text, p_purpose text DEFAULT 'direct_marketing'::text, p_caller_id_phone_number_id uuid DEFAULT NULL::uuid, p_webphone_session_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_customer public.customers%rowtype;
  v_policy public.telephony_policies%rowtype;
  v_caller record;
  v_existing record;
  v_existing_count integer := 0;
  v_call uuid;
  v_attempt uuid;
  v_local timestamp;
  v_is_automatic boolean := false;
  v_list_id uuid;
  v_purpose text;
  v_callback_team_id uuid;
  v_effective_team_id uuid;
  v_exact_policy jsonb;
begin
  if v_tenant is null or v_user is null then raise exception 'authentication_required'; end if;
  if not public.has_current_role(array['owner','admin','team_lead','sales']) then raise exception 'call_create_permission_required'; end if;
  if p_client_request_id is null or nullif(trim(p_idempotency_key),'') is null then raise exception 'idempotency_required'; end if;
  if p_target_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'target_phone_invalid'; end if;

  select count(distinct a.id) into v_existing_count
  from public.dial_attempts a
  where a.tenant_id = v_tenant and (a.client_request_id = p_client_request_id or a.idempotency_key = p_idempotency_key);
  if v_existing_count > 1 then raise exception 'idempotency_identity_conflict'; end if;

  select c.id call_id, a.id attempt_id, a.status attempt_status, c.status call_status, c.provider_status
  into v_existing
  from public.calls c
  join public.dial_attempts a on a.tenant_id = c.tenant_id and a.call_id = c.id
  where c.tenant_id = v_tenant and (a.client_request_id = p_client_request_id or a.idempotency_key = p_idempotency_key)
  order by a.requested_at desc, a.id
  limit 1;
  if found then
    return jsonb_build_object(
      'callId', v_existing.call_id, 'attemptId', v_existing.attempt_id,
      'status', v_existing.call_status, 'attemptStatus', v_existing.attempt_status,
      'providerStatus', coalesce(v_existing.provider_status, 'unknown'),
      'callActive', public.dial_attempt_holds_seat(v_existing.attempt_status),
      'message', case
        when v_existing.attempt_status = 'failed' then 'Det tidigare samtalsförsöket misslyckades.'
        when v_existing.attempt_status in ('provider_outcome_unknown','reconciliation_required')
          then 'Det tidigare samtalsförsökets providerutfall är ännu okänt.'
        when v_existing.attempt_status = 'completed'
          or v_existing.call_status in ('completed','failed','cancelled','blocked','unanswered')
          then 'Det tidigare samtalsförsöket är redan avslutat.'
        else 'Det befintliga samtalsförsöket återanvänds.' end,
      'idempotentReplay', true);
  end if;

  if not exists(select 1 from public.tenants where id = v_tenant and status in ('trial','active')) then raise exception 'tenant_not_active'; end if;
  if not exists(select 1 from public.tenant_features where tenant_id = v_tenant and feature_key = 'outbound_calls' and enabled)
    then raise exception 'outbound_calls_feature_disabled'; end if;
  select * into v_policy from public.telephony_policies where tenant_id = v_tenant;
  if not found or not v_policy.telephony_enabled then raise exception 'TELEPHONY_DISABLED'; end if;
  v_local := now() at time zone v_policy.timezone;
  if not (extract(isodow from v_local)::integer = any(v_policy.allowed_days)
    and v_local::time >= v_policy.allowed_start_time and v_local::time < v_policy.allowed_end_time)
    then raise exception 'TELEPHONY_OUTSIDE_ALLOWED_TIME'; end if;

  select * into v_customer from public.customers
  where tenant_id = v_tenant and id = p_customer_id and deleted_at is null for share;
  if not found then raise exception 'customer_not_found'; end if;

  if p_callback_activity_id is not null then
    select a.assigned_team_id into v_callback_team_id
    from public.activities a
    where a.tenant_id = v_tenant and a.id = p_callback_activity_id and a.customer_id = p_customer_id and a.type = 'callback';
  end if;

  -- NIX, samtycke och syfte. Oförändrad, och oberoende av vem som kopplar
  -- samtalet: att byta telefonileverantör ändrar ingenting om vem som får ringas.
  v_exact_policy := public.evaluate_exact_call_policy(
    v_tenant, v_user, p_customer_id, p_contact_person_id, p_target_phone,
    p_session_id, p_list_member_id, p_callback_activity_id, null
  );
  if coalesce(v_exact_policy->>'allowed','false') <> 'true' then
    raise exception 'exact_call_policy_denied:%', coalesce(v_exact_policy->>'reason','unknown');
  end if;
  v_purpose := v_exact_policy->>'purpose';
  if v_purpose is null then raise exception 'exact_call_policy_purpose_missing'; end if;

  if p_session_id is not null or p_list_member_id is not null then
    if p_session_id is null or p_list_member_id is null then raise exception 'list_call_context_incomplete'; end if;
    select ds.list_id, (ds.mode = 'automatic') into v_list_id, v_is_automatic
    from public.dialer_sessions ds
    join public.customer_list_members lm on lm.tenant_id = ds.tenant_id and lm.list_id = ds.list_id
      and lm.id = p_list_member_id and lm.customer_id = p_customer_id
      and lm.claimed_by = v_user and lm.claim_expires_at > now()
    join public.customer_lists l on l.tenant_id = ds.tenant_id and l.id = ds.list_id and l.status = 'active'
    where ds.tenant_id = v_tenant and ds.id = p_session_id and ds.user_id = v_user and ds.state in ('active','after_call')
    for update of ds, lm;
    if not found then raise exception 'dialer_session_or_claim_not_active'; end if;
    -- callback_belongs_to_the_claim: återkomsten måste vara den som kön gav
    -- säljaren för just det här prospektet. Tidigare prövades id:t inte alls på
    -- listsamtal, och vilken aktivitet som helst i företaget togs och stängdes.
    if p_callback_activity_id is not null and not exists(
      select 1
      from public.dialer_sessions ds
      join public.activities a on a.tenant_id = ds.tenant_id and a.id = ds.current_callback_activity_id
      where ds.tenant_id = v_tenant and ds.id = p_session_id and ds.user_id = v_user
        and ds.current_callback_activity_id = p_callback_activity_id
        and a.type = 'callback' and a.customer_id = p_customer_id and a.list_id = v_list_id
        and a.status in ('open','in_progress')
        and (a.claimed_by = v_user or a.assigned_user_id = v_user)
    ) then raise exception 'exact_call_policy_denied:callback_not_available'; end if;
  elsif p_callback_activity_id is not null and not exists(
    select 1 from public.activities a
    where a.tenant_id = v_tenant and a.id = p_callback_activity_id
      and a.customer_id = p_customer_id and a.type = 'callback' and a.status in ('open','in_progress')
      and (a.assigned_user_id = v_user or (a.callback_scope = 'global' and a.claimed_by = v_user))
      and (a.assigned_team_id is null or public.can_operate_in_team(a.assigned_team_id, v_user))
      and (a.list_id is null or public.can_work_customer_list(a.list_id))
  ) then raise exception 'callback_not_available'; end if;

  if v_is_automatic then
    if not v_policy.automatic_dialer_enabled then raise exception 'automatic_dialer_disabled'; end if;
  elsif not v_policy.manual_dialer_enabled then
    raise exception 'manual_dialer_disabled';
  end if;

  -- list_shared_to_teams
  if v_list_id is not null then
    if not public.can_work_customer_list(v_list_id) then raise exception 'list_work_permission_required'; end if;
    v_effective_team_id := public.list_team_for_seller(v_list_id, v_user);
  else
    v_effective_team_id := coalesce(v_callback_team_id, v_customer.assigned_team_id, (
      select tm.team_id from public.team_members tm join public.teams t on t.tenant_id = tm.tenant_id and t.id = tm.team_id and t.status = 'active'
      where tm.tenant_id = v_tenant and tm.user_id = v_user and not tm.assignment_paused
      order by tm.is_primary desc, tm.team_id limit 1));
  end if;
  if v_effective_team_id is not null
    and not (public.can_operate_in_team(v_effective_team_id, v_user) or public.is_tenant_admin(v_tenant)) then
    raise exception 'DIAL_TEAM_PERMISSION_REQUIRED';
  end if;

  select * into v_caller from public.resolve_caller_id_phone_number(
    v_tenant, v_effective_team_id, v_list_id,
    coalesce((select l.campaign_id from public.customer_lists l where l.tenant_id = v_tenant and l.id = v_list_id), v_customer.campaign_id),
    p_caller_id_phone_number_id
  );
  -- Ett samtal utan A-nummer får ett samtals-ID från Sinch och når aldrig
  -- mottagaren. Vägra här, innan det finns ett samtal, ett försök eller en
  -- listmedlem som tror att hon har ringts.
  if not found then raise exception 'CALLER_ID_MISSING'; end if;
  if p_caller_id_phone_number_id is not null and v_caller.phone_number_id <> p_caller_id_phone_number_id
    then raise exception 'DIAL_PERMISSION_DENIED'; end if;

  -- Att ringa sitt eget A-nummer kopplar samtalet tillbaka till samma trunk.
  if p_target_phone = v_caller.number_e164 then raise exception 'SELF_DIAL_NOT_ALLOWED'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_tenant::text || ':' || v_user::text, 0));
  if exists(
    select 1 from public.dial_attempts
    where tenant_id = v_tenant and seller_user_id = v_user and public.dial_attempt_holds_seat(status)
  ) then raise exception 'active_call_already_exists'; end if;

  insert into public.calls(
    tenant_id, provider, customer_id, contact_person_id, user_id, team_id, direction,
    from_number, to_number, status, recording_enabled, recording_status,
    transcription_status, insights_status, idempotency_key, purpose, list_id, list_member_id,
    dialer_session_id, callback_activity_id, callback_token_hash, metadata
  ) values(
    -- call_counts_to_access_team
    v_tenant, 'sinch', p_customer_id, p_contact_person_id, v_user, coalesce(v_effective_team_id, v_customer.assigned_team_id), 'outbound',
    v_caller.number_e164, p_target_phone, 'requested',
    v_policy.recording_enabled, case when v_policy.recording_enabled then 'pending' else 'not_expected' end,
    case when v_policy.transcription_enabled then 'pending' else 'disabled' end,
    case when v_policy.ai_analysis_enabled then 'pending' else 'disabled' end,
    p_idempotency_key, v_purpose, v_list_id, p_list_member_id, p_session_id, p_callback_activity_id,
    encode(digest(p_idempotency_key, 'sha256'), 'hex'),
    jsonb_build_object(
      'caller_id_phone_number_id', v_caller.phone_number_id,
      'caller_id_source', v_caller.caller_id_source,
      'derived_purpose', v_purpose, 'client_purpose_hint', p_purpose,
      'effective_team_id', v_effective_team_id, 'exact_call_policy', v_exact_policy
    )
  ) returning id into v_call;

  insert into public.dial_attempts(
    tenant_id, call_id, seller_user_id, provider, caller_id_phone_number_id, caller_id_source,
    source_number_e164, destination_number_e164, client_request_id, idempotency_key,
    status, expires_at, webphone_session_id
  ) values(
    v_tenant, v_call, v_user, 'sinch', v_caller.phone_number_id, v_caller.caller_id_source,
    v_caller.number_e164, p_target_phone, p_client_request_id, p_idempotency_key,
    'requested', now() + interval '2 hours', p_webphone_session_id
  ) returning id into v_attempt;

  if p_session_id is not null then
    update public.customer_list_members
      set state = 'dialing', attempts = attempts + 1, last_call_id = v_call,
          last_contacted_at = now(), claim_expires_at = now() + interval '2 hours'
      where tenant_id = v_tenant and id = p_list_member_id;
    update public.dialer_sessions set state = 'calling', current_call_id = v_call, last_seen_at = now()
      where tenant_id = v_tenant and id = p_session_id;
  end if;
  if p_callback_activity_id is not null then
    update public.activities
      set status = 'in_progress', claimed_by = v_user, claim_expires_at = now() + interval '2 hours', call_id = v_call
      where tenant_id = v_tenant and id = p_callback_activity_id
        and type = 'callback' and customer_id = p_customer_id;
  end if;

  insert into public.audit_logs(tenant_id, actor_user_id, action, entity_type, entity_id, after_data)
  values(v_tenant, v_user, 'call.reserved', 'call', v_call::text,
    jsonb_build_object('attempt_id', v_attempt, 'customer_id', p_customer_id,
      'destination_suffix', right(p_target_phone, 4)));

  return jsonb_build_object(
    'callId', v_call, 'attemptId', v_attempt, 'to', p_target_phone,
    'callerId', v_caller.number_e164, 'callerIdSource', v_caller.caller_id_source,
    'callerIdPhoneNumberId', v_caller.phone_number_id,
    'status', 'requested', 'attemptStatus', 'requested', 'providerStatus', 'requesting',
    'purpose', v_purpose, 'idempotentReplay', false
  );
end $function$;

-- 2. Efterarbetet stänger bara samtalets egen återkomst.
CREATE OR REPLACE FUNCTION public.complete_dialer_work(p_call_id uuid, p_disposition_key text, p_notes text, p_callback_scope text, p_callback_due_at timestamp with time zone, p_create_order boolean, p_product_id uuid, p_quantity numeric, p_unit_price numeric, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_call public.calls%rowtype; v_member public.customer_list_members%rowtype;
  v_list public.customer_lists%rowtype; v_disposition public.list_dispositions%rowtype; v_order uuid; v_order_number text;
  v_product public.products%rowtype; v_price public.product_price_versions%rowtype; v_quantity numeric:=greatest(coalesce(p_quantity,1),0.0001);
  v_unit numeric; v_line numeric; v_next timestamptz; v_callback uuid; v_team uuid;
begin
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'idempotency_key_required'; end if;
  select * into v_call from public.calls where tenant_id=v_tenant and id=p_call_id and user_id=v_user for update;
  if not found or v_call.list_id is null or v_call.list_member_id is null or v_call.dialer_session_id is null then raise exception 'list_call_not_found'; end if;
  if v_call.after_call_completed_at is not null then
    select id into v_order from public.sales_orders where tenant_id=v_tenant and source_call_id=p_call_id;
    return jsonb_build_object('completed',true,'idempotentReplay',true,'orderId',v_order);
  end if;
  if not public.is_terminal_call_status(v_call.status) or v_call.ended_at is null then raise exception 'call_not_finished'; end if;
  select * into v_list from public.customer_lists where tenant_id=v_tenant and id=v_call.list_id;
  select * into v_member from public.customer_list_members where tenant_id=v_tenant and id=v_call.list_member_id for update;
  select * into v_disposition from public.list_dispositions where tenant_id=v_tenant and list_id=v_call.list_id and key=p_disposition_key and active;
  if not found then raise exception 'invalid_list_disposition'; end if;
  if v_disposition.requires_note and nullif(trim(p_notes),'') is null then raise exception 'disposition_note_required'; end if;
  if v_disposition.requires_callback and (p_callback_due_at is null or p_callback_due_at<=now()) then raise exception 'future_callback_required'; end if;
  if p_callback_scope is not null and p_callback_scope not in ('personal','global') then raise exception 'callback_scope_invalid'; end if;
  if v_disposition.requires_callback and not (v_list.callback_policy='both' or v_list.callback_policy=p_callback_scope) then raise exception 'callback_scope_not_allowed'; end if;

  update public.calls set disposition=p_disposition_key,notes=nullif(trim(p_notes),''),after_call_completed_at=now(),
    status=case when status in ('queued','initiating','ringing','answered') then 'completed' else status end,ended_at=coalesce(ended_at,now())
  where id=p_call_id;
  update public.customers set last_contact_at=now(),call_attempts=call_attempts+1 where tenant_id=v_tenant and id=v_call.customer_id;
  if nullif(trim(p_notes),'') is not null then
    insert into public.notes(tenant_id,customer_id,body,visibility,note_type,call_id,list_id,created_by)
    values(v_tenant,v_call.customer_id,trim(p_notes),'team',case when v_disposition.requires_callback then 'callback' else 'call' end,p_call_id,v_call.list_id,v_user);
  end if;

  if v_call.callback_activity_id is not null then
    -- callback_completion_scoped
    update public.activities set status='completed',completed_at=now(),handled_at=now(),claimed_by=null,claim_expires_at=null
      where tenant_id=v_tenant and id=v_call.callback_activity_id and type='callback' and customer_id=v_call.customer_id;
  end if;
  if v_disposition.requires_callback then
    -- callback_team_that_gave_access
    v_team:=public.list_team_for_seller(v_call.list_id, v_user);
    insert into public.activities(tenant_id,customer_id,type,status,title,description,assigned_user_id,assigned_team_id,priority,due_at,created_by,list_id,call_id,callback_scope,metadata)
    values(v_tenant,v_call.customer_id,'callback','open','Återkomst · '||v_list.name,nullif(trim(p_notes),''),case when p_callback_scope='personal' then v_user else null end,
      case when p_callback_scope='global' then v_team else null end,'high',p_callback_due_at,v_user,v_call.list_id,p_call_id,p_callback_scope,jsonb_build_object('source','dialer','disposition',p_disposition_key))
    returning id into v_callback;
    v_next:=p_callback_due_at;
  elsif v_disposition.retry_after_minutes is not null then
    v_next:=now()+make_interval(mins=>v_disposition.retry_after_minutes);
  end if;

  if p_create_order or v_disposition.requires_order then
    if p_product_id is null then raise exception 'order_product_required'; end if;
    select * into v_product from public.products where tenant_id=v_tenant and id=p_product_id and active;
    if not found then raise exception 'active_product_not_found'; end if;
    select * into v_price from public.product_price_versions where tenant_id=v_tenant and product_id=p_product_id and active and valid_from<=current_date and (valid_to is null or valid_to>=current_date) order by version desc limit 1;
    v_unit:=coalesce(p_unit_price,v_price.setup_fee+v_price.recurring_fee,0); v_line:=round(v_quantity*v_unit,2);
    v_order_number:='KX-'||to_char(now(),'YYYYMM')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
    insert into public.sales_orders(tenant_id,order_number,customer_id,source_call_id,source_list_id,owner_user_id,status,currency,subtotal,total,notes,confirmed_at)
    values(v_tenant,v_order_number,v_call.customer_id,p_call_id,v_call.list_id,v_user,'confirmed',coalesce(v_price.currency,'SEK'),v_line,v_line,nullif(trim(p_notes),''),now()) returning id into v_order;
    insert into public.sales_order_items(tenant_id,order_id,product_id,price_version_id,description,quantity,unit_price,line_total)
    values(v_tenant,v_order,p_product_id,v_price.id,v_product.name,v_quantity,v_unit,v_line);
    update public.customers set lifecycle='customer' where tenant_id=v_tenant and id=v_call.customer_id and lifecycle in ('prospect','lead');
  end if;

  update public.customer_list_members set
    state=case when p_disposition_key in ('do_not_call','nix_listed') then 'blocked' when v_disposition.requires_callback then 'callback'
      when v_disposition.retry_after_minutes is not null and attempts<v_list.max_attempts then 'retry' else 'completed' end,
    outcome=p_disposition_key,next_attempt_at=v_next,claimed_by=null,claim_expires_at=null,
    completed_at=case when v_disposition.terminal or p_create_order or v_disposition.requires_order then now() else null end
  where id=v_member.id;
  if p_disposition_key in ('do_not_call','nix_listed') then
    perform public.apply_call_block_disposition(v_tenant,v_call.customer_id,p_disposition_key,p_notes,v_user,'dialer');
  end if;
  if v_next is not null then
    update public.customers set next_activity_at=least(coalesce(next_activity_at,v_next),v_next) where tenant_id=v_tenant and id=v_call.customer_id;
  end if;
  update public.dialer_sessions set state='active',current_list_member_id=null,current_callback_activity_id=null,current_call_id=null,last_seen_at=now() where tenant_id=v_tenant and id=v_call.dialer_session_id and user_id=v_user;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,request_id,after_data)
  values(v_tenant,v_user,'dialer.after_call_completed','call',p_call_id::text,p_idempotency_key,jsonb_build_object('disposition',p_disposition_key,'callback_id',v_callback,'order_id',v_order));
  return jsonb_build_object('completed',true,'orderId',v_order,'callbackId',v_callback,'nextAttemptAt',v_next,'autoNextDelaySeconds',v_list.auto_next_delay_seconds);
end $function$;

-- 3. Samma sak för manuella samtal.
CREATE OR REPLACE FUNCTION public.complete_manual_call_work(p_call_id uuid, p_disposition text, p_notes text, p_callback_scope text, p_callback_due_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_call public.calls%rowtype; v_callback uuid; v_team uuid;
begin
  if p_disposition not in ('no_answer','busy','voicemail','callback','interested','not_interested','wrong_number','do_not_call','nix_listed') then raise exception 'manual_disposition_invalid'; end if;
  select * into v_call from public.calls where tenant_id=v_tenant and id=p_call_id and user_id=v_user for update;
  if not found or v_call.list_id is not null then raise exception 'manual_call_not_found'; end if;
  if v_call.disposition is not null then return jsonb_build_object('completed',true,'idempotentReplay',true); end if;
  if not public.is_terminal_call_status(v_call.status) or v_call.ended_at is null then raise exception 'call_not_finished'; end if;
  if p_disposition='callback' and (p_callback_due_at is null or p_callback_due_at<=now() or p_callback_scope not in ('personal','global')) then raise exception 'future_callback_required'; end if;
  update public.calls set disposition=p_disposition,notes=nullif(trim(p_notes),''),after_call_completed_at=now() where tenant_id=v_tenant and id=p_call_id;
  update public.customers set last_contact_at=coalesce(v_call.ended_at,now()),call_attempts=call_attempts+1 where tenant_id=v_tenant and id=v_call.customer_id;
  if nullif(trim(p_notes),'') is not null then
    insert into public.notes(tenant_id,customer_id,body,visibility,note_type,call_id,created_by)
    values(v_tenant,v_call.customer_id,trim(p_notes),'team',case when p_disposition='callback' then 'callback' else 'call' end,p_call_id,v_user);
  end if;
  if v_call.callback_activity_id is not null then
    -- callback_completion_scoped
    update public.activities set status='completed',completed_at=now(),handled_at=now(),claimed_by=null,claim_expires_at=null
      where tenant_id=v_tenant and id=v_call.callback_activity_id and type='callback' and customer_id=v_call.customer_id;
  end if;
  if p_disposition='callback' then
    select assigned_team_id into v_team from public.customers where tenant_id=v_tenant and id=v_call.customer_id;
    insert into public.activities(tenant_id,customer_id,type,status,title,description,assigned_user_id,assigned_team_id,priority,due_at,created_by,call_id,callback_scope)
    values(v_tenant,v_call.customer_id,'callback','open','Återkomst',nullif(trim(p_notes),''),case when p_callback_scope='personal' then v_user else null end,
      case when p_callback_scope='global' then v_team else null end,'high',p_callback_due_at,v_user,p_call_id,p_callback_scope) returning id into v_callback;
    update public.customers set next_activity_at=least(coalesce(next_activity_at,p_callback_due_at),p_callback_due_at) where tenant_id=v_tenant and id=v_call.customer_id;
  end if;
  if p_disposition in ('do_not_call','nix_listed') then
    perform public.apply_call_block_disposition(v_tenant,v_call.customer_id,p_disposition,p_notes,v_user,'manuell dialer');
  end if;
  -- manual_outcome_closes_list_members
  if p_disposition in ('not_interested','wrong_number','do_not_call','nix_listed') then
    update public.customer_list_members
       set state = case when p_disposition in ('do_not_call','nix_listed') then 'blocked' else 'completed' end,
           outcome = p_disposition, completed_at = now(), next_attempt_at = null, updated_at = now()
     where tenant_id = v_tenant and customer_id = v_call.customer_id
       and state in ('pending','retry','skipped','callback') and claimed_by is null;
  end if;
  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
  values(v_tenant,v_user,'manual_call.after_work_completed','call',p_call_id::text,jsonb_build_object('disposition',p_disposition,'callbackId',v_callback));
  return jsonb_build_object('completed',true,'callbackId',v_callback);
end $function$;

-- 4. Kön ger aldrig en återkomst tillsammans med ett annat prospekt.
CREATE OR REPLACE FUNCTION public.claim_next_list_member(p_list_id uuid, p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid:=public.current_tenant_id(); v_user uuid:=auth.uid(); v_list public.customer_lists%rowtype;
  v_session public.dialer_sessions%rowtype; v_member public.customer_list_members%rowtype; v_customer public.customers%rowtype;
  v_callback public.activities%rowtype; v_local timestamp; v_time time; v_callback_id uuid; v_notes jsonb;
  v_pointer public.customer_list_distribution_state%rowtype; v_round_robin_user uuid;
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

  if exists(select 1 from public.customer_list_seller_assignments a where a.tenant_id=v_tenant and a.list_id=p_list_id and a.user_id=v_user and a.daily_capacity is not null and (
    select count(*) from public.calls c where c.tenant_id=v_tenant and c.list_id=p_list_id and c.user_id=v_user and (c.created_at at time zone v_list.timezone)::date=v_local::date
  )>=a.daily_capacity) then raise exception 'seller_daily_capacity_reached'; end if;

  -- Reclaim abandoned leases before selecting new work.
  update public.customer_list_members set state=case when attempts>=v_list.max_attempts then 'completed' else 'retry' end,claimed_by=null,claim_expires_at=null,updated_at=now()
    where tenant_id=v_tenant and list_id=p_list_id and state in ('claimed','dialing') and claim_expires_at<now();
  update public.activities set status='open',claimed_by=null,claim_expires_at=null,updated_at=now()
    where tenant_id=v_tenant and list_id=p_list_id and type='callback' and status='in_progress' and claim_expires_at<now();

  if v_session.current_list_member_id is not null then
    select * into v_member from public.customer_list_members where tenant_id=v_tenant and id=v_session.current_list_member_id and claimed_by=v_user and claim_expires_at>now();
    v_callback_id:=v_session.current_callback_activity_id;
  end if;

  if v_member.id is null then
    select a.* into v_callback from public.activities a
    -- own_claimed_callback_first
    where a.tenant_id=v_tenant and a.list_id=p_list_id and a.type='callback'
      and (
        (a.status='in_progress' and a.claimed_by=v_user and a.claim_expires_at>now())
        or (a.status='open' and coalesce(a.snoozed_until,a.due_at)<=now()
          and (a.assigned_user_id=v_user or (a.callback_scope='global' and (a.assigned_team_id is null or public.can_operate_in_team(a.assigned_team_id,v_user)))))
      )
      -- callback_needs_its_list_member: en återkomst vars kund saknar listplats
      -- kan inte ringas härifrån och fick tidigare följa med ett annat prospekt.
      and exists(select 1 from public.customer_list_members m
                 where m.tenant_id=a.tenant_id and m.list_id=p_list_id and m.customer_id=a.customer_id)
    order by (a.status='in_progress') desc, coalesce(a.snoozed_until,a.due_at),a.created_at for update skip locked limit 1;
    if v_callback.id is not null then
      update public.activities set status='in_progress',claimed_by=v_user,claim_expires_at=now()+interval '10 minutes',updated_at=now() where id=v_callback.id;
      select * into v_member from public.customer_list_members where tenant_id=v_tenant and list_id=p_list_id and customer_id=v_callback.customer_id
        and (claimed_by is null or claimed_by=v_user or claim_expires_at<now()) for update;
      if v_member.id is null then
        update public.activities set status='open',claimed_by=null,claim_expires_at=null,updated_at=now() where id=v_callback.id;
      else
        v_callback_id:=v_callback.id;
      end if;
    end if;
  end if;

  if v_member.id is null and v_list.distribution_strategy='round_robin' then
    insert into public.customer_list_distribution_state(tenant_id,list_id) values(v_tenant,p_list_id)
      on conflict(list_id) do nothing;
    select * into v_pointer from public.customer_list_distribution_state where tenant_id=v_tenant and list_id=p_list_id for update;
    select eligible.user_id into v_round_robin_user
    from (
      select a.user_id,a.created_at
      from public.customer_list_seller_assignments a
      join public.tenant_memberships m on m.tenant_id=a.tenant_id and m.user_id=a.user_id and m.status='active'
      where a.tenant_id=v_tenant and a.list_id=p_list_id and a.status='active'
        and (a.starts_at is null or a.starts_at<=now()) and (a.ends_at is null or a.ends_at>now())
        and (v_list.team_id is null or public.can_operate_in_team(v_list.team_id,a.user_id))
        and (a.daily_capacity is null or (select count(*) from public.calls c where c.tenant_id=v_tenant and c.list_id=p_list_id and c.user_id=a.user_id and (c.created_at at time zone v_list.timezone)::date=v_local::date)<a.daily_capacity)
    ) eligible
    order by case when v_pointer.last_user_id is null then 0 when eligible.user_id::text>v_pointer.last_user_id::text then 0 else 1 end,eligible.user_id::text
    limit 1;
    -- queue_is_shared_not_turn_based: turen styr ordningen men spärrar ingen.
  end if;

  if v_member.id is null then
    select lm.* into v_member from public.customer_list_members lm
    join public.customers c on c.tenant_id=lm.tenant_id and c.id=lm.customer_id
    where lm.tenant_id=v_tenant and lm.list_id=p_list_id and lm.state in ('pending','retry','callback','skipped')
      and (lm.next_attempt_at is null or lm.next_attempt_at<=now()) and lm.attempts<v_list.max_attempts
      and c.deleted_at is null and not c.do_not_call and c.lifecycle<>'blocked'
      and (c.phone_e164 is not null or c.alternate_phone_e164 is not null or exists(
        select 1 from public.contact_people cp where cp.tenant_id=c.tenant_id and cp.customer_id=c.id and coalesce(cp.phone_e164,cp.alternate_phone_e164) is not null
          and exists(select 1 from public.nix_checks nx where nx.tenant_id=c.tenant_id and nx.phone_e164 in (cp.phone_e164,cp.alternate_phone_e164) and nx.valid_until>now() and nx.result='not_listed')
      ))
      and public.evaluate_contact_policy_for_tenant(v_tenant,c.id,'call','direct_marketing')->>'allowed'='true'
      and (lm.claimed_by is null or lm.claim_expires_at<now())
      and (
        v_list.distribution_strategy in ('shared_queue','round_robin')
        or (v_list.distribution_strategy in ('fixed_owner','manual') and lm.assigned_user_id=v_user)
      )
      and (not v_list.lock_to_seller or lm.assigned_user_id is null or lm.assigned_user_id=v_user)
    order by case when lm.state='callback' then 0 else 1 end,lm.priority desc,lm.next_attempt_at nulls first,lm.created_at
    for update of lm skip locked limit 1;
  end if;

  if v_member.id is null then
    update public.dialer_sessions set current_list_member_id=null,current_callback_activity_id=null,current_call_id=null,last_seen_at=now() where id=p_session_id;
    return jsonb_build_object('empty',true,'sessionId',p_session_id,'distributionStrategy',v_list.distribution_strategy);
  end if;
  update public.customer_list_members set state='claimed',claimed_by=v_user,claim_expires_at=now()+interval '10 minutes',
    assigned_user_id=case when v_list.distribution_strategy in ('round_robin','fixed_owner','manual') or v_list.lock_to_seller then coalesce(assigned_user_id,v_user) else assigned_user_id end,
    updated_at=now() where id=v_member.id returning * into v_member;
  if v_list.distribution_strategy='round_robin' then
    update public.customer_list_distribution_state set last_user_id=v_user,sequence=sequence+1,updated_at=now() where tenant_id=v_tenant and list_id=p_list_id;
  end if;
  update public.dialer_sessions set state='active',current_list_member_id=v_member.id,current_callback_activity_id=v_callback_id,current_call_id=null,last_seen_at=now() where id=p_session_id;
  select * into v_customer from public.customers where tenant_id=v_tenant and id=v_member.customer_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',n.id,'body',n.body,'isPinned',n.is_pinned,'createdAt',n.created_at) order by n.is_pinned desc,n.created_at desc),'[]'::jsonb)
    into v_notes from (select id,body,is_pinned,created_at from public.notes where tenant_id=v_tenant and customer_id=v_member.customer_id and archived_at is null order by is_pinned desc,created_at desc limit 8) n;
  return jsonb_build_object(
    'empty',false,'sessionId',p_session_id,'memberId',v_member.id,'callbackActivityId',v_callback_id,'mode',v_list.dialing_mode,
    'distributionStrategy',v_list.distribution_strategy,'autoNextDelaySeconds',v_list.auto_next_delay_seconds,'allowSkip',v_list.allow_skip,'allowBrowse',v_list.allow_browse,
    'script',v_list.script,'questionnaire',v_list.questionnaire,
    'customer',jsonb_build_object('id',v_customer.id,'displayName',v_customer.display_name,'customerType',v_customer.customer_type,'companyName',v_customer.company_name,
      'organizationNumber',v_customer.organization_number,'phone',v_customer.phone_e164,'email',v_customer.email,'address',concat_ws(', ',v_customer.address_line1,v_customer.postal_code,v_customer.city),
      'industry',v_customer.industry,'sniCode',v_customer.sni_code,'callAttempts',v_member.attempts,'lastContactAt',v_customer.last_contact_at,'customFields',v_customer.custom_fields,'notes',v_notes)
  );
end $function$;

-- 5. ACE och DiCE är leverantörens besked om svaret.
CREATE OR REPLACE FUNCTION public.ingest_sinch_voice_event(p_event text, p_external_call_id text, p_provider_event_id text, p_payload jsonb, p_received_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_event_id uuid;
  v_attempt record;
  v_reason text;
  v_call_status text;
  v_answered boolean := false;
  v_provider_answered boolean := false;
  v_overruled boolean := false;
  v_result text;
  v_ended timestamptz;
  v_duration integer;
begin
  insert into public.provider_webhook_events(
    provider, event_type, provider_event_id, payload, received_at, status)
  values('sinch', p_event, p_provider_event_id, p_payload, p_received_at, 'received')
  on conflict (provider, provider_event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    -- Redan mottagen. Sinch gör om leveransen vid utebliven kvittering, och att
    -- behandla samma händelse två gånger skulle kunna stänga ett samtal som
    -- hunnit börja om.
    -- ice_connects_only_reserved_calls: en omlevererad ICE får samma besked.
    if p_event = 'ice' then
      return coalesce((
        select jsonb_build_object('duplicate', true, 'matched', true, 'event', 'ice',
          'connect', public.dial_attempt_holds_seat(a.status) and a.status <> 'matched'
            and a.seller_user_id::text = p_payload->>'user'
            and a.destination_number_e164 = p_payload#>>'{to,endpoint}',
          'destination', a.destination_number_e164,
          'callerId', a.source_number_e164)
        from public.dial_attempts a
        where a.provider = 'sinch' and a.external_call_id = p_external_call_id
        limit 1
      ), jsonb_build_object('duplicate', true, 'matched', false, 'event', 'ice', 'connect', false));
    end if;
    return jsonb_build_object('duplicate', true, 'matched', false);
  end if;

  select a.id, a.tenant_id, a.call_id, a.status
  into v_attempt
  from public.dial_attempts a
  where a.provider = 'sinch' and a.external_call_id = p_external_call_id
  limit 1;

  -- ice_matched_by_seller_and_number
  if not found and p_event = 'ice' then
    select a.id, a.tenant_id, a.call_id, a.status
    into v_attempt
    from public.dial_attempts a
    where a.provider = 'sinch'
      and a.external_call_id is null
      and a.seller_user_id::text = p_payload->>'user'
      and a.destination_number_e164 = p_payload#>>'{to,endpoint}'
      and a.status in ('requested','dial_requested','awaiting_provider_event')
      and a.requested_at > p_received_at - interval '2 minutes'
    order by a.requested_at desc
    limit 1
    for update;
    if found then
      update public.dial_attempts
        set external_call_id = p_external_call_id, updated_at = now()
        where id = v_attempt.id;
    end if;
  end if;

  if not found then
    -- Händelsen kom före klientens rapport om sitt samtals-ID. Raden ligger kvar
    -- olöst i stället för att kastas, så den går att koppla i efterhand.
    update public.provider_webhook_events
      set status = 'unmatched'
      where id = v_event_id;
    return jsonb_build_object('duplicate', false, 'matched', false);
  end if;

  update public.provider_webhook_events
    set tenant_id = v_attempt.tenant_id, status = 'processed', processed_at = now()
    where id = v_event_id;

  if p_event = 'ace' then
    -- Besvarat. Providerns ord väger tyngre än klientens, så källan skrivs ut:
    -- webbläsaren kan också rapportera ett svar, och den som läser raden ska
    -- kunna se vilken av dem som satte tiden.
    update public.calls c
    set status = 'answered',
        answered_at = coalesce(c.answered_at, coalesce((p_payload->>'timestamp')::timestamptz, p_received_at)),
        provider_status = 'connected',
        metadata = c.metadata || jsonb_build_object('answered_at_source', 'sinch_ace'),
        updated_at = now()
    where c.id = v_attempt.call_id and c.tenant_id = v_attempt.tenant_id
      and public.call_status_rank(c.status) < public.call_status_rank('answered');

    -- provider_confirms_answer: ACE är leverantörens besked att kunden svarade.
    -- Det skrivs även när webbläsaren hann före, så att DiCE vet att svaret
    -- kom från leverantören och inte rättar bort det.
    update public.calls c
    set answered_at = case when c.answered_at is null and public.call_status_rank(c.status) < 100
          then coalesce((p_payload->>'timestamp')::timestamptz, p_received_at) else c.answered_at end,
        metadata = c.metadata || jsonb_build_object('provider_answered', true),
        updated_at = now()
    where c.id = v_attempt.call_id and c.tenant_id = v_attempt.tenant_id
      and not coalesce((c.metadata->>'provider_answered')::boolean, false);

    update public.dial_attempts
      set status = 'matched', updated_at = now()
      where id = v_attempt.id and public.dial_attempt_holds_seat(status);

    insert into public.call_events(tenant_id, call_id, event_type, payload)
    values(v_attempt.tenant_id, v_attempt.call_id, 'sinch.call_answered',
      jsonb_build_object('attempt_id', v_attempt.id, 'source', 'provider'));

    return jsonb_build_object('duplicate', false, 'matched', true, 'event', 'ace');
  end if;

  if p_event = 'dice' then
    v_reason := upper(coalesce(p_payload->>'reason', 'N/A'));
    v_result := upper(coalesce(p_payload->>'result', ''));
    v_ended := coalesce((p_payload->>'timestamp')::timestamptz, p_received_at);
    v_duration := (p_payload->>'duration')::integer;
    perform set_config('kundexa.provider_authoritative', 'on', true);
    select c.answered_at is not null, coalesce((c.metadata->>'provider_answered')::boolean, false)
      into v_answered, v_provider_answered
      from public.calls c
      where c.id = v_attempt.call_id and c.tenant_id = v_attempt.tenant_id
      for update;
    v_answered := coalesce(v_answered, false);
    v_provider_answered := coalesce(v_provider_answered, false);

    -- dice_result_is_authoritative: leverantörens utfall väger tyngre än
    -- webbläsarens rapport. Ett svar som bara klienten sett, och som DiCE
    -- säger aldrig kom, räknas inte som besvarat.
    if v_result = 'ANSWERED' then
      v_answered := true;
      v_provider_answered := true;
    elsif v_result in ('NOANSWER','BUSY','FAILED') and v_answered and not v_provider_answered then
      v_answered := false;
      v_overruled := true;
    end if;

    -- Ett samtal som besvarades är genomfört, oavsett vem som lade på. Ett som
    -- aldrig besvarades är obesvarat, inte misslyckat -- skillnaden avgör om
    -- numret ska ringas igen.
    v_call_status := case
      when v_reason = 'BLOCKED' then 'blocked'
      when v_answered then 'completed'
      -- dice_result_busy
      when upper(coalesce(p_payload->>'result', '')) = 'BUSY' then 'busy'
      when v_reason in ('TIMEOUT','CALLERHANGUP','CALLEEHANGUP','MANAGERHANGUP','CANCEL') then 'unanswered'
      else 'failed' end;

    if v_overruled then
      update public.calls c
      set status = v_call_status,
          answered_at = null,
          provider_status = 'ended',
          ended_at = coalesce(c.ended_at, v_ended),
          end_cause = lower(v_reason),
          duration_seconds = coalesce(v_duration, 0),
          metadata = c.metadata || jsonb_build_object(
            'answered_at_source', 'overruled_by_provider',
            'client_reported_answered_at', c.answered_at),
          updated_at = now()
      where c.id = v_attempt.call_id and c.tenant_id = v_attempt.tenant_id;
    end if;

    update public.calls c
    set status = v_call_status,
        provider_status = 'ended',
        answered_at = case when v_provider_answered and c.answered_at is null
          then v_ended - make_interval(secs => coalesce(v_duration, 0)) else c.answered_at end,
        metadata = case when v_provider_answered
          then c.metadata || jsonb_build_object('provider_answered', true) else c.metadata end,
        ended_at = coalesce(c.ended_at, v_ended),
        end_cause = coalesce(c.end_cause, lower(v_reason)),
        duration_seconds = coalesce(c.duration_seconds, v_duration),
        updated_at = now()
    where c.id = v_attempt.call_id and c.tenant_id = v_attempt.tenant_id
      and (public.call_status_rank(c.status) < public.call_status_rank(v_call_status)
        or (c.status = 'unanswered' and v_call_status in ('failed','busy') and c.answered_at is null)
        or (v_call_status = 'completed' and v_provider_answered and c.answered_at is null
            and c.status in ('unanswered','failed')));

    if v_provider_answered then
      update public.calls c
      set answered_at = coalesce(c.answered_at, v_ended - make_interval(secs => coalesce(v_duration, 0))),
          metadata = c.metadata || jsonb_build_object('provider_answered', true),
          updated_at = now()
      where c.id = v_attempt.call_id and c.tenant_id = v_attempt.tenant_id and c.status = 'completed'
        and not coalesce((c.metadata->>'provider_answered')::boolean, false);
    end if;

    -- Samma slutstatus som webbläsaren redan satt: leverantörens längd och
    -- orsak är de riktiga och ersätter klientens uppskattning.
    update public.calls c
    set duration_seconds = coalesce((p_payload->>'duration')::integer, c.duration_seconds),
        end_cause = case when c.end_cause is null or c.end_cause = 'webphone_leg_ended' then lower(v_reason) else c.end_cause end,
        updated_at = now()
    where c.id = v_attempt.call_id and c.tenant_id = v_attempt.tenant_id and c.status = v_call_status;

    update public.dial_attempts
      set status = case when v_call_status = 'failed' then 'failed' else 'completed' end,
          provider_request_finished_at = coalesce(provider_request_finished_at, now()),
          updated_at = now()
      where id = v_attempt.id and public.dial_attempt_holds_seat(status);

    insert into public.call_events(tenant_id, call_id, event_type, payload)
    values(v_attempt.tenant_id, v_attempt.call_id, 'sinch.call_ended', jsonb_build_object(
      'attempt_id', v_attempt.id, 'reason', v_reason,
      'duration', p_payload->'duration', 'debit', p_payload->'debit'));

    return jsonb_build_object('duplicate', false, 'matched', true,
      'event', 'dice', 'callStatus', v_call_status);
  end if;

  if p_event = 'ice' then
    return (
      select jsonb_build_object('duplicate', false, 'matched', true, 'event', 'ice',
        'connect', public.dial_attempt_holds_seat(a.status) and a.status <> 'matched'
          and a.seller_user_id::text = p_payload->>'user'
          and a.destination_number_e164 = p_payload#>>'{to,endpoint}',
        'destination', a.destination_number_e164,
        'callerId', a.source_number_e164)
      from public.dial_attempts a
      where a.id = v_attempt.id
    );
  end if;
  return jsonb_build_object('duplicate', false, 'matched', true, 'event', p_event);
end $function$;

-- 6. Triggern släpper igenom leverantörens rättelse, inget annat.
CREATE OR REPLACE FUNCTION public.protect_call_projection()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  -- Inspelningsupptäckt är monoton. När en inspelning väl finns hos leverantören
  -- eller hos oss får en senare händelse utan inspelningsdata inte flytta
  -- tillbaka tillståndet.
  if old.recording_status in ('available_at_provider','copy_pending','stored_privately')
    and new.recording_status in ('not_expected','pending','unavailable') then
    new.recording_status:=old.recording_status;
  end if;

  -- Ett känt leverantörsutfall är bevis. En händelse som utelämnar det får inte
  -- radera det; ett senare icke-tomt utfall får däremot rätta det.
  if old.provider_outcome is not null and new.provider_outcome is null then
    new.provider_outcome:=old.provider_outcome;
  end if;

  if old.status='unanswered' and new.status in ('failed','busy') and old.answered_at is null
    and coalesce(current_setting('kundexa.provider_authoritative', true),'')='on' then
    return new;
  end if;

  -- dice_result_is_authoritative: leverantörens slutbesked får rätta ett svar
  -- som bara webbläsaren rapporterat, och ett svar som webbläsaren missat.
  if coalesce(current_setting('kundexa.provider_authoritative', true),'')='on' then
    if old.status='completed' and new.status in ('unanswered','busy','failed') and new.answered_at is null
      and not coalesce((old.metadata->>'provider_answered')::boolean,false) then
      return new;
    end if;
    if old.status in ('unanswered','failed') and old.answered_at is null
      and new.status='completed' and new.answered_at is not null
      and coalesce((new.metadata->>'provider_answered')::boolean,false) then
      return new;
    end if;
  end if;

  if public.call_status_rank(old.status)=100 and new.status<>old.status then
    new.status:=old.status;
    new.answered_at:=old.answered_at;
    new.ended_at:=old.ended_at;
    new.duration_seconds:=old.duration_seconds;
    new.end_cause:=old.end_cause;
    new.provider_status:=old.provider_status;
    new.provider_outcome:=old.provider_outcome;
    new.provider_cause:=old.provider_cause;
    new.provider_state_updated_at:=old.provider_state_updated_at;
    return new;
  end if;

  -- Avvisa både livscykelregression och gammal leverantörstid. Återhämtnings-
  -- markörerna deltar inte i tidsordningen: deras tidsstämplar är lokala
  -- osäkerhetsmarkörer, inte leverantörens händelsetid.
  if public.call_status_rank(new.status) < public.call_status_rank(old.status)
    or (
      old.status not in ('provider_outcome_unknown','reconciliation_required')
      and old.provider_state_updated_at is not null
      and new.provider_state_updated_at is not null
      and new.provider_state_updated_at < old.provider_state_updated_at
    ) then
    new.status:=old.status;
    new.answered_at:=old.answered_at;
    new.ended_at:=old.ended_at;
    new.duration_seconds:=old.duration_seconds;
    new.end_cause:=old.end_cause;
    new.provider_status:=old.provider_status;
    new.provider_outcome:=old.provider_outcome;
    new.provider_cause:=old.provider_cause;
    new.provider_state_updated_at:=old.provider_state_updated_at;
  end if;

  return new;
end $function$;

-- 7. Samtal som leverantören redan bekräftat genom ACE märks, så att DiCE
--    aldrig rättar bort ett svar leverantören själv rapporterat.
update public.calls
   set metadata = metadata || jsonb_build_object('provider_answered', true)
 where provider = 'sinch'
   and answered_at is not null
   and metadata->>'answered_at_source' = 'sinch_ace'
   and not coalesce((metadata->>'provider_answered')::boolean, false);
