-- Leverantörens datamodell lämnar databasen.
--
-- Arton tabeller, fyrtiofyra funktioner och sjutton kolumner fanns bara för att
-- spegla en leverantörs objektmodell: provisionerade användare, registrerade
-- enheter, allokerade nummer, plattformsjobb. Ingenting av det har en motsvarighet
-- i den modell som ersatte den, där webbläsaren är telefonen och `phone_numbers`
-- är numren.
--
-- Tre saker får inte försvinna med dem, och därför står de först:
--
--   1. Monotoniskt samtalstillstånd. Skyddet låg i `protect_rinkel_call_projection`
--      som inledde med `if old.provider<>'rinkel' ... then return new`. Nya samtal
--      har provider 'sinch', så skyddet var redan avstängt för varje samtal som
--      faktiskt ringts sedan bytet: en sen händelse kunde backa ett avslutat
--      samtal till "ringer". Det gäller samtalet, inte leverantören, så villkoret
--      utgår helt i stället för att peka om till ett nytt namn.
--   2. Samma sak i `complete_manual_call_work_v2`. Dess normalisering av
--      slutstatus låg bakom identiskt villkor och hoppades alltså över för varje
--      Sinch-samtal.
--   3. Frisläppning av hängande uppringningsförsök. Utan den sitter en säljare
--      vars samtal aldrig fick ett leverantörssvar fast för alltid.

-- 1. Frisläppningen, mot den nya försöksmodellen.
create or replace function public.release_stale_dial_attempts(
  p_max_age interval default '01:00:00'::interval,
  p_limit integer default 200
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_released record;
  v_count integer := 0;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required'; end if;
  -- En för kort gräns släpper försök som fortfarande pågår, och då ringer
  -- säljaren nästa nummer medan det förra samtalet lever.
  if p_max_age < interval '15 minutes' then raise exception 'stale_attempt_bound_too_short'; end if;

  for v_released in
    update public.dial_attempts a
    set status = 'failed',
        error_code = 'PROVIDER_OUTCOME_NEVER_REPORTED',
        error_message = left(format(
          'Ingen leverantörshändelse kom inom %s; uppringningsförsöket släpptes så att säljaren kan ringa igen. Samtalet självt är fortfarande oavgjort.',
          p_max_age::text
        ), 500),
        provider_request_finished_at = coalesce(a.provider_request_finished_at, now()),
        updated_at = now()
    where a.id in (
      select candidate.id
      from public.dial_attempts candidate
      where public.dial_attempt_holds_seat(candidate.status)
        and candidate.requested_at <= now() - p_max_age
      order by candidate.requested_at
      limit greatest(coalesce(p_limit,200),1)
      for update skip locked
    )
    returning a.id, a.tenant_id, a.call_id, a.seller_user_id, a.external_call_id
  loop
    v_count := v_count + 1;
    insert into public.call_events(tenant_id,call_id,event_type,payload)
    values(v_released.tenant_id, v_released.call_id, 'dial_attempt.released_unresolved', jsonb_build_object(
      'attempt_id', v_released.id,
      'external_call_id', v_released.external_call_id,
      'reason', 'PROVIDER_OUTCOME_NEVER_REPORTED',
      'max_age', p_max_age::text
    ));
    -- Samtalet stängs inte. Att gissa ett utfall vore att skriva in en osanning
    -- i underlaget; det enda vi vet är att platsen är fri igen.
    insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)
    values(v_released.tenant_id, null, 'telephony.dial_attempt_released', 'call', v_released.call_id::text, jsonb_build_object(
      'attempt_id', v_released.id,
      'seller_user_id', v_released.seller_user_id,
      'reason', 'PROVIDER_OUTCOME_NEVER_REPORTED',
      'call_outcome', 'unresolved'
    ));
  end loop;

  return jsonb_build_object('released', v_count, 'maxAge', p_max_age::text);
end $$;

comment on function public.release_stale_dial_attempts(interval, integer) is
  'Släpper uppringningsförsök som aldrig fick ett leverantörssvar, utan att påstå något om samtalets utfall.';

revoke all on function public.release_stale_dial_attempts(interval, integer) from public, anon, authenticated;

-- 2. Monotoniskt samtalstillstånd, för alla samtal.
create or replace function public.protect_call_projection()
returns trigger
language plpgsql
set search_path to ''
as $$
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
end $$;

comment on function public.protect_call_projection() is
  'Håller samtalets livscykel, utfall och inspelningsstatus monotona oavsett vilken leverantör som rapporterar.';

drop trigger if exists calls_rinkel_projection_monotonic on public.calls;
drop trigger if exists calls_projection_monotonic on public.calls;
create trigger calls_projection_monotonic
  before update on public.calls
  for each row execute function public.protect_call_projection();

-- 3. Slutstatusnormaliseringen, för alla samtal som gått via en leverantör.
create or replace function public.complete_manual_call_work_v2(
  p_call_id uuid, p_disposition text, p_notes text, p_callback_scope text, p_callback_due_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid:=public.current_tenant_id();
  v_user uuid:=auth.uid();
  v_provider text;
  v_status text;
  v_result jsonb;
  v_normalize boolean;
begin
  select provider,status into v_provider,v_status from public.calls
    where tenant_id=v_tenant and id=p_call_id and user_id=v_user for update;
  if not found then raise exception 'manual_call_not_found'; end if;
  -- Villkoret gällde ett leverantörsnamn och slutade därför gälla i samma stund
  -- som namnet byttes. Det som avgör är om samtalet kopplats av en leverantör
  -- alls -- ett externt registrerat samtal har ingen leverantörsstatus att
  -- normalisera.
  v_normalize := coalesce(v_provider,'') not in ('','manual','external');
  if v_normalize then
    if not public.is_terminal_call_status(v_status) then
      raise exception 'call_not_finished';
    end if;
    update public.calls set status=case
      when v_status='unanswered' then 'no_answer'
      when v_status in ('blocked','outside_business_hours') then 'failed'
      when v_status='voicemail' then 'completed'
      else v_status end
    where tenant_id=v_tenant and id=p_call_id;
  end if;
  v_result:=public.complete_manual_call_work(p_call_id,p_disposition,p_notes,p_callback_scope,p_callback_due_at);
  if v_normalize then
    update public.calls set status=v_status where tenant_id=v_tenant and id=p_call_id;
  end if;
  return v_result;
end $$;

-- 4. Kolumnerna som pekade på leverantörens allokeringar. De ersattes av
-- `caller_id_phone_number_id` respektive `default_caller_id_phone_number_id`.
alter table public.teams drop column if exists rinkel_number_allocation_id;
alter table public.campaigns drop column if exists rinkel_number_allocation_id;
alter table public.customer_lists drop column if exists rinkel_number_allocation_id;
alter table public.telephony_policies drop column if exists default_number_allocation_id;
-- Anteckningssynk mot leverantörens CRM-vy. Den funktionen finns inte att synka mot.
alter table public.telephony_policies drop column if exists sync_notes_to_rinkel;

-- 5. Den ursprungliga försökstabellen, ersatt två gånger om: först av
-- `rinkel_call_attempts_v2`, nu av `dial_attempts`.
drop table if exists public.call_attempts cascade;

-- 6. Leverantörens tabeller.
drop table if exists public.rinkel_call_attempts_v2 cascade;
drop table if exists public.rinkel_number_grants cascade;
drop table if exists public.rinkel_user_mappings_v2 cascade;
drop table if exists public.rinkel_user_mappings cascade;
drop table if exists public.rinkel_number_allocations cascade;
drop table if exists public.rinkel_user_allocations cascade;
drop table if exists public.rinkel_numbers cascade;
drop table if exists public.rinkel_users cascade;
drop table if exists public.rinkel_capabilities cascade;
drop table if exists public.rinkel_webhook_subscriptions cascade;
drop table if exists public.platform_rinkel_webhook_events cascade;
drop table if exists public.platform_rinkel_webhook_subscriptions cascade;
drop table if exists public.platform_rinkel_jobs cascade;
drop table if exists public.platform_rinkel_conflicts cascade;
drop table if exists public.platform_rinkel_capabilities cascade;
drop table if exists public.platform_rinkel_devices cascade;
drop table if exists public.platform_rinkel_numbers cascade;
drop table if exists public.platform_rinkel_users cascade;

-- 7. Leverantörens funktioner.
--
-- Uppräknade dynamiskt och inte för hand. En handskriven lista missar en
-- signatur, och en kvarlämnad funktion mot en borttagen tabell är värre än
-- ingen funktion: den går att anropa och fallerar först inuti.
do $$
declare v_fn record;
begin
  for v_fn in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like '%rinkel%'
  loop
    execute format('drop function if exists %s cascade', v_fn.signature);
  end loop;
end $$;

-- Ingenting får vara kvar. Kontrollen står i migrationen därför att en halvt
-- genomförd borttagning annars upptäcks först när något anropar det som blev kvar.
do $$
declare v_left integer;
begin
  select count(*) into v_left
  from (
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and c.relname like '%rinkel%'
    union all
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like '%rinkel%'
    union all
    select 1 from information_schema.columns
      where table_schema='public' and column_name like '%rinkel%'
  ) remaining;
  if v_left > 0 then
    raise exception 'rinkel_schema_removal_incomplete: % objects remain', v_left;
  end if;
end $$;
