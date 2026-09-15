-- Webbtelefonens session: den som gör att en död flik inte låser säljaren.
--
-- I dag är säljarens "enhet" ett `deviceId` hos telefonitjänsten, och Kundexa
-- får bara veta hur ett samtal gick via en webhook. När webhooken uteblir står
-- försöket kvar som aktivt och säljaren kan inte ringa någon alls. Det har hänt
-- två gånger i produktion: ett samtal 2026-09-11 låste platsen i tre dygn, och
-- ett 2026-09-15 08:12 låste den igen — `awaiting_provider_event`, inget
-- `external_call_id`, noll `call_events`.
--
-- Med en webbtelefon är webbläsaren själv samtalsbenet. Då gäller något som
-- inte gäller i dag: **är fliken borta är ljudet borta**. Sessionen är därför
-- ett ärligt livstecken på ett sätt som ett `deviceId` aldrig kan vara, och när
-- den tystnar får försöket släppas.
--
-- Avgränsningen är medveten och viktig: sopningen här rör **bara** försök som
-- har en `webphone_session_id`. Försök som dagens `/dial`-väg skapat har ingen,
-- och ska aldrig röras härifrån — där är webbläsaren inte samtalsbenet och en
-- stängd flik säger ingenting om huruvida samtalet lever. Samma misstag som
-- nästan gjordes när `matched` skulle läggas till i den gamla sopningen.

create table if not exists public.webphone_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  seller_user_id uuid not null references public.profiles(id) on delete cascade,
  -- Vilken telefonileverantör registreringen gäller. Eget fält, inte härlett,
  -- eftersom webbtelefonen är byggd för att kunna byta leverantör utan att
  -- historiken blir tvetydig.
  provider text not null,
  -- Registreringens id hos leverantören (SIP call-id, registrerings-id eller
  -- motsvarande). Null tills registreringen faktiskt gått igenom.
  registration_id text,
  status text not null default 'registering'
    check (status in ('registering','registered','closed','lost')),
  user_agent text,
  started_at timestamptz not null default now(),
  registered_at timestamptz,
  last_heartbeat_at timestamptz not null default now(),
  closed_at timestamptz,
  close_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.webphone_sessions is
  'En säljares levande registrering av webbtelefonen. Hjärtslaget är beviset på att samtalsbenet finns kvar; tystnar det släpps säljarens samtalsförsök.';
comment on column public.webphone_sessions.provider is
  'Telefonileverantören registreringen gäller. Lagras eftersom webbtelefonen ska kunna byta leverantör utan att historiken blir tvetydig.';

create index if not exists webphone_sessions_tenant_seller_idx
  on public.webphone_sessions(tenant_id, seller_user_id, status);
-- Sopningen söker på (status, last_heartbeat_at) över alla tenants, så den
-- indexeras för sig och inte som ett påhäng på tenant-indexet ovan.
create index if not exists webphone_sessions_live_heartbeat_idx
  on public.webphone_sessions(last_heartbeat_at)
  where status in ('registering','registered');

-- Exakt en levande session per säljare. Öppnar säljaren en ny flik stängs den
-- gamla i `open_webphone_session` — sista fliken vinner — och det här indexet
-- gör att två aldrig kan existera samtidigt ens vid en kapplöpning.
create unique index if not exists webphone_sessions_one_live_per_seller
  on public.webphone_sessions(tenant_id, seller_user_id)
  where status in ('registering','registered');

alter table public.webphone_sessions enable row level security;

drop policy if exists webphone_sessions_scoped_select on public.webphone_sessions;
create policy webphone_sessions_scoped_select on public.webphone_sessions
  for select using (
    tenant_id = public.current_tenant_id()
    and (seller_user_id = (select auth.uid()) or public.is_tenant_admin(tenant_id))
  );

-- Ingen insert-, update- eller deletepolicy: sessioner skrivs uteslutande genom
-- RPC:erna nedan, som äger hjärtslagets och frisläppningens invarianter. En
-- säljare som kunde skriva raden direkt skulle kunna förfalska ett livstecken
-- för ett samtalsben som inte finns.

-- Sammansatt nyckel, inte bara `id`. En enkolumns-FK mellan två tenantägda
-- tabeller låter en rad peka på en annan tenants rad, och just det försöket
-- fångades av `verify-sql.mjs` när den här migrationen skrevs. Paret
-- (tenant_id, id) gör korsningen omöjlig i databasen i stället för i koden.
alter table public.webphone_sessions
  drop constraint if exists webphone_sessions_tenant_id_key;
alter table public.webphone_sessions
  add constraint webphone_sessions_tenant_id_key unique (tenant_id, id);

alter table public.rinkel_call_attempts_v2
  add column if not exists webphone_session_id uuid;

alter table public.rinkel_call_attempts_v2
  drop constraint if exists rinkel_call_attempts_v2_webphone_session_tenant_fk;
alter table public.rinkel_call_attempts_v2
  add constraint rinkel_call_attempts_v2_webphone_session_tenant_fk
  foreign key (tenant_id, webphone_session_id)
  references public.webphone_sessions(tenant_id, id)
  on delete set null;

comment on column public.rinkel_call_attempts_v2.webphone_session_id is
  'Webbtelefonsessionen som bär samtalsbenet. Null för försök som startats via provider-/dial, och de får aldrig släppas av sessionssopningen.';

create index if not exists rinkel_call_attempts_v2_webphone_session_idx
  on public.rinkel_call_attempts_v2(webphone_session_id)
  where webphone_session_id is not null;

-- Statusarna som betyder "försöket håller platsen upptagen". Samma lista som
-- reservationen i `rinkel_reserve_platform_outbound_call_v2` vägrar mot, uttryckt
-- en gång så att de inte kan glida isär.
create or replace function public.rinkel_attempt_holds_seat(p_status text)
returns boolean language sql immutable set search_path to '' as $$
  select p_status in (
    'requested','dial_requested','awaiting_provider_event',
    'matched','provider_outcome_unknown','reconciliation_required'
  )
$$;

comment on function public.rinkel_attempt_holds_seat(text) is
  'Om ett samtalsförsök i den här statusen hindrar säljaren från att ringa. En källa, så reservationen och frisläppningen aldrig kan glida isär.';

-- Stänger en session och släpper det samtalsben den bar.
--
-- Intern: den tar ingen ställning till vem som ringer, utan förutsätter att
-- anroparen redan avgjort det. Returnerar antalet släppta försök så anroparen
-- kan säga vad som faktiskt hände i stället för att gissa.
create or replace function public.close_webphone_session_internal(
  p_session_id uuid,
  p_status text,
  p_reason text
) returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_session record;
  v_released record;
  v_count integer := 0;
begin
  update public.webphone_sessions s
     set status = p_status,
         closed_at = now(),
         close_reason = left(nullif(trim(coalesce(p_reason, '')), ''), 200),
         updated_at = now()
   where s.id = p_session_id
     and s.status in ('registering','registered')
  returning s.id, s.tenant_id, s.seller_user_id into v_session;
  if not found then
    return 0;
  end if;

  -- Bara försök som den här sessionen bar. Aldrig ett `/dial`-försök: där är
  -- webbläsaren inte samtalsbenet, och en stängd flik säger ingenting om
  -- huruvida samtalet lever.
  for v_released in
    update public.rinkel_call_attempts_v2 a
       set status = 'failed',
           error_code = coalesce(a.error_code, 'WEBPHONE_SESSION_ENDED'),
           error_message = left(format(
             'Webbtelefonen tappade registreringen (%s), så samtalsbenet fanns inte kvar. Försöket släpptes så att nästa nummer kan ringas.',
             coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'okänd orsak')
           ), 500),
           provider_request_finished_at = coalesce(a.provider_request_finished_at, now()),
           updated_at = now()
     where a.webphone_session_id = v_session.id
       and public.rinkel_attempt_holds_seat(a.status)
    returning a.id, a.tenant_id, a.call_id, a.seller_user_id
  loop
    v_count := v_count + 1;

    -- Samtalet självt avslutas bara om det ännu inte nått ett svarat läge.
    -- Rank 40 är `answered`/`in_progress`; ett svarat samtal som tappat sin
    -- webbtelefon är inte "avbrutet", det är avslutat av avstämningen och får
    -- inte skrivas om här.
    update public.calls c
       set status = 'failed',
           ended_at = coalesce(c.ended_at, now()),
           end_cause = coalesce(c.end_cause, 'webphone_session_lost'),
           updated_at = now()
     where c.id = v_released.call_id
       and c.tenant_id = v_released.tenant_id
       and public.call_status_rank(c.status) < 40;

    insert into public.call_events(tenant_id, call_id, event_type, payload)
    values (v_released.tenant_id, v_released.call_id, 'webphone.session_ended', jsonb_build_object(
      'session_id', v_session.id,
      'attempt_id', v_released.id,
      'status', p_status,
      'reason', p_reason
    ));

    insert into public.audit_logs(tenant_id, actor_user_id, action, entity_type, entity_id, after_data)
    values (v_released.tenant_id, null, 'webphone.attempt_released', 'call', v_released.call_id::text, jsonb_build_object(
      'session_id', v_session.id,
      'seller_user_id', v_released.seller_user_id,
      'session_status', p_status,
      'reason', p_reason
    ));
  end loop;

  return v_count;
end $$;

revoke all on function public.close_webphone_session_internal(uuid, text, text) from public, anon, authenticated;

-- Säljaren öppnar webbtelefonen.
--
-- Öppnar säljaren en ny flik stängs den gamla sessionen först — sista fliken
-- vinner. Det är avsiktligt: två registreringar för samma säljare betyder två
-- telefoner som kan ringa samtidigt, vilket är precis det reservationen finns
-- till för att förhindra.
create or replace function public.open_webphone_session(
  p_provider text,
  p_user_agent text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_previous record;
  v_replaced integer := 0;
  v_session uuid;
begin
  if v_tenant is null or v_user is null then
    raise exception 'authentication_required';
  end if;
  if not public.has_current_role(array['owner','admin','team_lead','sales']) then
    raise exception 'call_create_permission_required';
  end if;
  if nullif(trim(coalesce(p_provider, '')), '') is null then
    raise exception 'webphone_provider_required';
  end if;

  -- Serialisera mot samma säljare, så två flikar som öppnas samtidigt inte kan
  -- båda passera det unika indexet och en av dem få ett råt indexfel i ansiktet.
  perform pg_advisory_xact_lock(hashtextextended('webphone:' || v_tenant::text || ':' || v_user::text, 0));

  for v_previous in
    select s.id from public.webphone_sessions s
    where s.tenant_id = v_tenant
      and s.seller_user_id = v_user
      and s.status in ('registering','registered')
  loop
    v_replaced := v_replaced + public.close_webphone_session_internal(
      v_previous.id, 'closed', 'Ersatt av en ny webbtelefonsession'
    );
  end loop;

  insert into public.webphone_sessions(tenant_id, seller_user_id, provider, user_agent)
  values (v_tenant, v_user, trim(p_provider), left(nullif(trim(coalesce(p_user_agent, '')), ''), 400))
  returning id into v_session;

  return jsonb_build_object(
    'sessionId', v_session,
    'status', 'registering',
    -- Klienten ska inte hitta på sin egen takt. Servern äger både intervallet
    -- och tystnadsgränsen, så de kan ändras utan att en gammal flik blir fel.
    'heartbeatSeconds', 15,
    'lostAfterSeconds', 90,
    'releasedAttempts', v_replaced
  );
end $$;

revoke all on function public.open_webphone_session(text, text) from public, anon;
grant execute on function public.open_webphone_session(text, text) to authenticated;

-- Hjärtslaget. Bär också registreringens id första gången den gått igenom, så
-- `registered` aldrig sätts av något annat än ett faktiskt lyckat SIP-svar.
create or replace function public.heartbeat_webphone_session(
  p_session_id uuid,
  p_registration_id text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_session record;
begin
  if v_tenant is null or v_user is null then
    raise exception 'authentication_required';
  end if;

  update public.webphone_sessions s
     set last_heartbeat_at = now(),
         registration_id = coalesce(nullif(trim(coalesce(p_registration_id, '')), ''), s.registration_id),
         status = case
           when s.status = 'registering' and nullif(trim(coalesce(p_registration_id, '')), '') is not null
             then 'registered'
           else s.status
         end,
         registered_at = case
           when s.status = 'registering' and nullif(trim(coalesce(p_registration_id, '')), '') is not null
             then now()
           else s.registered_at
         end,
         updated_at = now()
   where s.id = p_session_id
     and s.tenant_id = v_tenant
     and s.seller_user_id = v_user
     and s.status in ('registering','registered')
  returning s.id, s.status, s.registration_id into v_session;

  -- Sessionen är borta eller redan stängd. Säg det rakt ut i stället för att
  -- låta klienten fortsätta slå hjärtslag mot ingenting: den ska registrera om
  -- sig, och tystnad här hade dolt att webbtelefonen inte längre är ansluten.
  if not found then
    return jsonb_build_object('sessionId', p_session_id, 'alive', false, 'status', 'lost');
  end if;

  return jsonb_build_object(
    'sessionId', v_session.id,
    'alive', true,
    'status', v_session.status,
    'registrationId', v_session.registration_id
  );
end $$;

revoke all on function public.heartbeat_webphone_session(uuid, text) from public, anon;
grant execute on function public.heartbeat_webphone_session(uuid, text) to authenticated;

-- Säljaren stänger fliken, loggar ut, eller webbtelefonen tappar registreringen.
create or replace function public.close_webphone_session(
  p_session_id uuid,
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user uuid := auth.uid();
  v_owned boolean;
  v_released integer;
begin
  if v_tenant is null or v_user is null then
    raise exception 'authentication_required';
  end if;

  select exists(
    select 1 from public.webphone_sessions s
    where s.id = p_session_id
      and s.tenant_id = v_tenant
      -- En administratör får stänga någon annans session, av samma skäl som i
      -- `end_active_call`: den som är låst är inte alltid den som når skärmen.
      and (s.seller_user_id = v_user or public.is_tenant_admin(v_tenant))
  ) into v_owned;
  if not v_owned then
    raise exception 'webphone_session_not_found';
  end if;

  v_released := public.close_webphone_session_internal(
    p_session_id, 'closed', coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'Stängd av användaren')
  );

  return jsonb_build_object(
    'sessionId', p_session_id,
    'closed', true,
    'releasedAttempts', v_released,
    'message', case
      when v_released > 0 then 'Webbtelefonen stängdes och samtalsförsöket släpptes.'
      else 'Webbtelefonen stängdes.'
    end
  );
end $$;

revoke all on function public.close_webphone_session(uuid, text) from public, anon;
grant execute on function public.close_webphone_session(uuid, text) to authenticated;

-- Sopningen: sessioner som tystnat.
--
-- Till skillnad från `rinkel_release_stale_call_attempts`, som har en golvgräns
-- på femton minuter för att den aldrig kan veta om ett `/dial`-samtal fortfarande
-- pågår, får den här släppa efter halvannan minut. Skillnaden är att här *är*
-- webbläsaren samtalsbenet: tystnar hjärtslaget finns inget ljud kvar att skydda.
--
-- Golvet på en minut står ändå kvar, så ingen kan be om en gräns så kort att ett
-- normalt nätverkshack räknas som ett tappat samtal.
create or replace function public.release_lost_webphone_sessions(
  p_max_silence interval default '00:01:30'::interval,
  p_limit integer default 200
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_session record;
  v_sessions integer := 0;
  v_attempts integer := 0;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception 'service_role_required';
  end if;
  if p_max_silence < interval '1 minute' then
    raise exception 'webphone_silence_bound_too_short';
  end if;

  for v_session in
    select s.id
    from public.webphone_sessions s
    where s.status in ('registering','registered')
      and s.last_heartbeat_at <= now() - p_max_silence
    order by s.last_heartbeat_at
    limit greatest(coalesce(p_limit, 200), 1)
    for update skip locked
  loop
    v_sessions := v_sessions + 1;
    v_attempts := v_attempts + public.close_webphone_session_internal(
      v_session.id,
      'lost',
      format('Inget hjärtslag på %s', p_max_silence::text)
    );
  end loop;

  return jsonb_build_object(
    'sessionsClosed', v_sessions,
    'attemptsReleased', v_attempts,
    'maxSilence', p_max_silence::text
  );
end $$;

revoke all on function public.release_lost_webphone_sessions(interval, integer) from public, anon, authenticated;
grant execute on function public.release_lost_webphone_sessions(interval, integer) to service_role;

grant select on public.webphone_sessions to authenticated;
