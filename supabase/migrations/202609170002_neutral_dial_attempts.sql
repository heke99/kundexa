-- Platsmodellen för utgående samtal, utan leverantören inbakad.
--
-- `rinkel_call_attempts_v2` är i grunden rätt modell: ett samtalsförsök håller
-- säljarens plats tills det är avgjort, och släpper den sedan. Men nio av dess
-- trettioen kolumner är NOT NULL och finns bara för att Rinkels `POST /dial`
-- kräver ett `deviceId`:
--
--   mapping_id, user_allocation_id, number_allocation_id, rinkel_user_id,
--   rinkel_number_id, external_rinkel_user_id, external_rinkel_number_id,
--   rinkel_device_id, platform_integration_id
--
-- Hos en leverantör som originerar samtalet själv finns ingen enhet att peka ut,
-- ingen provisionerad användare och ingen seat-policy. Kolumnerna har ingen
-- motsvarighet, och eftersom de är NOT NULL går de inte att bara låta stå tomma.
--
-- Den här tabellen är samma modell utan dem, plus det som faktiskt behövs
-- framåt: vilken leverantör försöket gick till, och vilket av tenantens egna
-- nummer som visades. A-numret pekar på `phone_numbers`, samma neutrala tabell
-- som lagen, kampanjerna och listorna nu pekar på.
--
-- Tabellen är oanvänd när den läggs in. Uppringningsvägen flyttas hit i en egen
-- migration, och den gamla tabellen droppas när ingenting läser den längre.

create table if not exists public.dial_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  call_id uuid not null,
  seller_user_id uuid not null,

  provider text not null,
  caller_id_phone_number_id uuid,
  caller_id_source text,
  source_number_e164 text not null,
  destination_number_e164 text not null,

  client_request_id uuid not null,
  idempotency_key text not null,
  status text not null,

  requested_at timestamptz not null default now(),
  provider_request_started_at timestamptz,
  provider_request_finished_at timestamptz,
  external_call_id text,

  error_code text,
  error_message text,

  expires_at timestamptz not null,
  webphone_session_id uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint dial_attempts_tenant_id_id_key unique (tenant_id, id),
  constraint dial_attempts_tenant_idempotency_key unique (tenant_id, idempotency_key),

  -- Varje referens är komposit på tenant_id. En enkolumnsnyckel här skulle låta
  -- ett försök i ett bolag peka på ett samtal, en säljare eller ett nummer i ett
  -- annat, och verifieringen vägrar sådana nycklar mellan tenantägda tabeller.
  constraint dial_attempts_call_tenant_fk
    foreign key (tenant_id, call_id) references public.calls (tenant_id, id) on delete cascade,
  constraint dial_attempts_seller_tenant_fk
    foreign key (tenant_id, seller_user_id) references public.tenant_memberships (tenant_id, user_id),
  constraint dial_attempts_caller_id_phone_number_tenant_fk
    foreign key (tenant_id, caller_id_phone_number_id) references public.phone_numbers (tenant_id, id),
  constraint dial_attempts_webphone_session_tenant_fk
    foreign key (tenant_id, webphone_session_id) references public.webphone_sessions (tenant_id, id),

  constraint dial_attempts_provider_check check (provider in ('sinch')),
  constraint dial_attempts_status_check check (status in (
    'requested','dial_requested','awaiting_provider_event','matched',
    'provider_outcome_unknown','reconciliation_required',
    'completed','failed','expired'
  )),
  constraint dial_attempts_caller_id_source_check check (
    caller_id_source is null or caller_id_source in ('list','campaign','team','tenant_default')
  )
);

comment on table public.dial_attempts is
  'Ett utgående samtalsförsök. Håller säljarens plats tills utfallet är avgjort. Leverantörsneutral efterföljare till rinkel_call_attempts_v2.';
comment on column public.dial_attempts.provider is
  'Vilken telefonileverantör försöket gick till. Kolumnen finns för att ett byte inte ska kräva en ny tabell igen.';
comment on column public.dial_attempts.caller_id_phone_number_id is
  'Numret som visades för mottagaren, ur tenantens egna nummer.';

-- Ett försök som håller platsen hindrar säljaren från att ringa nästa nummer.
-- Regeln står på ett ställe, för minst fyra ställen skriver status och nästa
-- skrivare ska ärva den utan att någon behöver minnas den.
create or replace function public.dial_attempt_holds_seat(p_status text)
returns boolean language sql immutable set search_path to '' as $$
  select p_status in ('requested','dial_requested','awaiting_provider_event',
    'matched','provider_outcome_unknown','reconciliation_required')
$$;

comment on function public.dial_attempt_holds_seat(text) is
  'Sant för de statusar där ett samtalsförsök fortfarande håller säljarens plats upptagen.';

-- En säljare får bara ha ett öppet försök i taget. Det är den här spärren som
-- gör platsmodellen till en plats och inte en räknare.
create unique index if not exists dial_attempts_one_open_per_seller_uidx
  on public.dial_attempts (tenant_id, seller_user_id)
  where public.dial_attempt_holds_seat(status);

create index if not exists dial_attempts_call_idx
  on public.dial_attempts (tenant_id, call_id);
create index if not exists dial_attempts_webphone_session_idx
  on public.dial_attempts (tenant_id, webphone_session_id)
  where webphone_session_id is not null;
create index if not exists dial_attempts_external_call_idx
  on public.dial_attempts (provider, external_call_id)
  where external_call_id is not null;

-- Samma spärr som redan finns på den gamla tabellen, och av samma anledning:
-- en sen providerhändelse tog i produktion tillbaka ett släppt försök och låste
-- säljaren i nittio minuter. Providern får fortfarande berika raden; det enda
-- som vägras är att ta tillbaka platsen.
create or replace function public.keep_dial_attempt_terminal()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if old.status not in ('completed','failed','expired') then
    return new;
  end if;
  if not public.dial_attempt_holds_seat(new.status) then
    return new;
  end if;

  new.status := old.status;
  new.error_code := coalesce(old.error_code, new.error_code);
  new.error_message := coalesce(old.error_message, new.error_message);
  return new;
end $$;

comment on function public.keep_dial_attempt_terminal() is
  'Hindrar en sen providerhändelse från att flytta ett avslutat samtalsförsök tillbaka till en status som håller säljarens plats upptagen.';

drop trigger if exists keep_dial_attempt_terminal on public.dial_attempts;
create trigger keep_dial_attempt_terminal
  before update of status on public.dial_attempts
  for each row execute function public.keep_dial_attempt_terminal();

revoke all on function public.keep_dial_attempt_terminal() from public, anon, authenticated;

alter table public.dial_attempts enable row level security;

-- Läsning speglar webphone_sessions: tenanten via current_tenant_id(), och inom
-- den ser säljaren sina egna försök medan en administratör ser alla. auth.uid()
-- ligger i en subquery så den utvärderas en gång och inte per rad.
--
-- Ingen insert-, update- eller deletepolicy: försök skrivs uteslutande genom
-- SECURITY DEFINER-funktioner, som äger platsens invarianter. En säljare som
-- kunde skriva raden direkt skulle kunna släppa sin egen plats mitt i ett samtal,
-- eller ta en som inte är hens.
drop policy if exists dial_attempts_scoped_select on public.dial_attempts;
create policy dial_attempts_scoped_select on public.dial_attempts
  for select using (
    tenant_id = public.current_tenant_id()
    and (seller_user_id = (select auth.uid()) or public.is_tenant_admin(tenant_id))
  );

grant select on public.dial_attempts to authenticated;
