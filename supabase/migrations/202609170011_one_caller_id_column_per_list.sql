-- En lista hade två utgående nummer.
--
-- `customer_lists.outbound_phone_number_id` läses av listdialerns kökod, och
-- `customer_lists.caller_id_phone_number_id` läses av `resolve_caller_id_phone_number`
-- som den manuella uppringningen använder. Samma lista kunde alltså visa ett
-- nummer när säljaren ringde ur listan och ett annat när hon ringde samma kund
-- från kundkortet -- och ingen inställning i gränssnittet förklarade varför.
--
-- Det här slår ihop dem till en kolumn: `caller_id_phone_number_id`, samma namn
-- som teamet och kampanjen redan använder. Efter det finns ett nummer per lista,
-- och det väljs på ett ställe.
--
-- Listdialern får dessutom hela företräde­sordningen i stället för bara listans
-- eget val. Den hoppade tidigare över team och företagsförval helt, så en lista
-- utan eget nummer ringde med vad `queue_outbound_call_target` råkade sätta.

-- 1. Rädda det som står i den gamla kolumnen innan den försvinner.
update public.customer_lists
   set caller_id_phone_number_id = outbound_phone_number_id
 where caller_id_phone_number_id is null
   and outbound_phone_number_id is not null;

-- 2. Listdialern använder resolvern, precis som den manuella vägen.
create or replace function public.queue_list_outbound_call_target(
  p_session_id uuid, p_list_member_id uuid, p_callback_activity_id uuid, p_contact_person_id uuid,
  p_target_phone text, p_callback_token_hash text, p_callback_token text, p_voice_client_number text,
  p_idempotency_key text, p_purpose text default 'direct_marketing')
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_member public.customer_list_members%rowtype;
  v_session public.dialer_sessions%rowtype;
  v_list public.customer_lists%rowtype;
  v_caller record;
  v_team uuid;
  v_call uuid;
begin
  select * into v_session from public.dialer_sessions
    where tenant_id=v_tenant and id=p_session_id and user_id=v_user and state in ('active','after_call') for update;
  if not found then raise exception 'dialer_session_not_active'; end if;
  select * into v_member from public.customer_list_members
    where tenant_id=v_tenant and id=p_list_member_id and list_id=v_session.list_id
      and claimed_by=v_user and claim_expires_at>now() for update;
  if not found then raise exception 'list_member_claim_expired'; end if;
  if p_callback_activity_id is distinct from v_session.current_callback_activity_id then raise exception 'callback_claim_mismatch'; end if;
  select * into v_list from public.customer_lists where tenant_id=v_tenant and id=v_session.list_id;

  -- Säljarens primära team, så att ett teamnummer kan vinna över företagets
  -- förval på samma sätt som vid manuell uppringning.
  select tm.primary_team_id into v_team
  from public.tenant_memberships tm where tm.tenant_id=v_tenant and tm.user_id=v_user;

  -- Listor har ingen kampanjkoppling i schemat, så kampanjledet lämnas tomt.
  select * into v_caller from public.resolve_caller_id_phone_number(
    v_tenant, v_team, v_list.id, null, null);

  v_call := public.queue_outbound_call_target(
    v_member.customer_id, p_contact_person_id, p_target_phone,
    p_callback_token_hash, p_callback_token, p_voice_client_number, p_idempotency_key, p_purpose);

  update public.calls set list_id=v_member.list_id, list_member_id=v_member.id,
    dialer_session_id=p_session_id, callback_activity_id=p_callback_activity_id,
    phone_number_id=coalesce(v_caller.phone_number_id, phone_number_id),
    from_number=coalesce(v_caller.number_e164, from_number),
    recording_enabled=coalesce((v_list.settings->>'recordingEnabled')::boolean,false),
    metadata=metadata||jsonb_build_object('mode','list_dialer','list_id',v_member.list_id,
      'list_member_id',v_member.id,'dialer_session_id',p_session_id,
      'caller_id_source', v_caller.caller_id_source)
  where tenant_id=v_tenant and id=v_call;

  update public.customer_list_members set state='dialing', attempts=attempts+1, last_call_id=v_call,
    last_contacted_at=now(), claim_expires_at=now()+interval '2 hours' where id=v_member.id;
  update public.dialer_sessions set state='calling', current_call_id=v_call, last_seen_at=now() where id=p_session_id;
  return v_call;
end $$;

create or replace function public.queue_list_outbound_call(
  p_session_id uuid, p_list_member_id uuid, p_callback_activity_id uuid,
  p_callback_token_hash text, p_callback_token text, p_voice_client_number text,
  p_idempotency_key text, p_purpose text default 'direct_marketing')
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_member public.customer_list_members%rowtype;
  v_session public.dialer_sessions%rowtype;
  v_list public.customer_lists%rowtype;
  v_caller record;
  v_team uuid;
  v_call uuid;
begin
  select * into v_session from public.dialer_sessions
    where tenant_id=v_tenant and id=p_session_id and user_id=v_user and state in ('active','after_call') for update;
  if not found then raise exception 'dialer_session_not_active'; end if;
  select * into v_member from public.customer_list_members
    where tenant_id=v_tenant and id=p_list_member_id and list_id=v_session.list_id
      and claimed_by=v_user and claim_expires_at>now() for update;
  if not found then raise exception 'list_member_claim_expired'; end if;
  if p_callback_activity_id is distinct from v_session.current_callback_activity_id then raise exception 'callback_claim_mismatch'; end if;
  select * into v_list from public.customer_lists where tenant_id=v_tenant and id=v_session.list_id;

  select tm.primary_team_id into v_team
  from public.tenant_memberships tm where tm.tenant_id=v_tenant and tm.user_id=v_user;
  select * into v_caller from public.resolve_caller_id_phone_number(
    v_tenant, v_team, v_list.id, null, null);

  v_call := public.queue_outbound_call(
    v_member.customer_id, p_callback_token_hash, p_callback_token,
    p_voice_client_number, p_idempotency_key, p_purpose);

  update public.calls set list_id=v_member.list_id, list_member_id=v_member.id,
    dialer_session_id=p_session_id, callback_activity_id=p_callback_activity_id,
    phone_number_id=coalesce(v_caller.phone_number_id, phone_number_id),
    from_number=coalesce(v_caller.number_e164, from_number),
    recording_enabled=coalesce((v_list.settings->>'recordingEnabled')::boolean,false),
    metadata=metadata||jsonb_build_object('mode','list_dialer','list_id',v_member.list_id,
      'list_member_id',v_member.id,'dialer_session_id',p_session_id,
      'caller_id_source', v_caller.caller_id_source)
  where tenant_id=v_tenant and id=v_call;

  update public.customer_list_members set state='dialing', attempts=attempts+1, last_call_id=v_call,
    last_contacted_at=now(), claim_expires_at=now()+interval '2 hours' where id=v_member.id;
  update public.dialer_sessions set state='calling', current_call_id=v_call, last_seen_at=now() where id=p_session_id;
  return v_call;
end $$;

-- 3. Listkopian till ett team följer med den nya kolumnen.
--
-- Kroppen skrivs om ur `prosrc` i stället för att skrivas av för hand: den är
-- fyra kilobyte lång, allt utom kolumnnamnet ska vara oförändrat, och en
-- avskrift är just det ställe där en rad tyst tappas. Bytet kontrolleras -- om
-- kolumnnamnet inte fanns där vi tror har funktionen ändrats under oss, och då
-- ska migrationen stanna i stället för att skriva tillbaka en kropp som inte
-- längre stämmer.
do $$
declare v_src text; v_new text; v_args text; v_result text;
begin
  select p.prosrc, pg_get_function_arguments(p.oid), pg_get_function_result(p.oid)
    into v_src, v_args, v_result
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='split_customer_list_to_team';
  if v_src is null then return; end if;
  v_new := replace(v_src, 'outbound_phone_number_id', 'caller_id_phone_number_id');
  if v_new = v_src then
    raise exception 'split_customer_list_to_team no longer copies the column this migration removes';
  end if;
  -- Signaturen läses av från funktionen själv, inklusive parametrarnas
  -- standardvärden. Att skriva av den för hand tappade dem, och Postgres vägrar
  -- -- med rätta -- att tyst ta bort ett standardvärde ur en befintlig funktion.
  execute format(
    'create or replace function public.split_customer_list_to_team(%s) returns %s language plpgsql security definer set search_path to ''public'' as %L',
    v_args, v_result, v_new);
end $$;

-- 4. Listinställningarna slutar äga numret. Det väljs med samma formulär som
-- teamets och kampanjens, så parametern tas bort i stället för att bli en
-- kvarglömd ingång som skriver till en kolumn som inte längre finns.
drop function if exists public.update_customer_list_configuration(
  uuid, text, text, text, text, integer, time, time, integer, integer, integer,
  text, boolean, boolean, boolean, text, text, integer[], uuid, boolean, timestamptz, timestamptz);

create or replace function public.update_customer_list_configuration(
  p_list_id uuid, p_name text, p_description text, p_status text, p_dialing_mode text,
  p_priority integer, p_start_time time, p_end_time time, p_max_attempts integer,
  p_retry_delay_minutes integer, p_auto_next_delay_seconds integer, p_callback_policy text,
  p_allow_skip boolean, p_allow_browse boolean, p_lock_to_seller boolean, p_script text,
  p_timezone text, p_allowed_days integer[], p_recording_enabled boolean,
  p_starts_at timestamptz, p_ends_at timestamptz)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not public.can_manage_customer_list(p_list_id) then raise exception 'list_manage_permission_required'; end if;
  if nullif(trim(p_timezone),'') is null then raise exception 'list_timezone_required'; end if;
  if coalesce(array_length(p_allowed_days,1),0)=0 or exists(select 1 from unnest(p_allowed_days) day where day not between 1 and 7)
    then raise exception 'list_allowed_days_invalid'; end if;
  if p_ends_at is not null and p_starts_at is not null and p_ends_at<=p_starts_at
    then raise exception 'list_end_must_follow_start'; end if;

  update public.customer_lists set name=trim(p_name),description=nullif(trim(p_description),''),
    status=p_status,dialing_mode=p_dialing_mode,
    priority=greatest(0,least(p_priority,10000)),allowed_start_time=p_start_time,allowed_end_time=p_end_time,
    max_attempts=greatest(1,least(p_max_attempts,100)),retry_delay_minutes=greatest(1,least(p_retry_delay_minutes,525600)),
    auto_next_delay_seconds=greatest(0,least(p_auto_next_delay_seconds,300)),callback_policy=p_callback_policy,
    allow_skip=p_allow_skip,allow_browse=p_allow_browse,lock_to_seller=p_lock_to_seller,
    script=nullif(p_script,''),timezone=trim(p_timezone),
    allowed_days=(select array_agg(distinct day order by day) from unnest(p_allowed_days) day),
    starts_at=p_starts_at,ends_at=p_ends_at,
    settings=jsonb_set(settings,'{recordingEnabled}',to_jsonb(p_recording_enabled),true)
  where tenant_id=public.current_tenant_id() and id=p_list_id;
  if not found then raise exception 'list_not_found'; end if;
end $$;

revoke all on function public.update_customer_list_configuration(
  uuid, text, text, text, text, integer, time, time, integer, integer, integer,
  text, boolean, boolean, boolean, text, text, integer[], boolean, timestamptz, timestamptz)
  from public, anon;
grant execute on function public.update_customer_list_configuration(
  uuid, text, text, text, text, integer, time, time, integer, integer, integer,
  text, boolean, boolean, boolean, text, text, integer[], boolean, timestamptz, timestamptz)
  to authenticated;

-- 5. Den dubbla kolumnen försvinner.
alter table public.customer_lists drop column if exists outbound_phone_number_id;

do $$
begin
  if exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='customer_lists' and column_name='outbound_phone_number_id')
  then raise exception 'list_caller_id_consolidation_incomplete'; end if;
end $$;
