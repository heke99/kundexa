-- Kundkortet går inte att öppna, för någon.
--
-- Uppmätt i produktion 2026-09-17 15:59:48:
--
--   GET /app/customers/d64c077e-…  digest 1819667757
--   PGRST200: Could not find a relationship between 'notes' and 'created_by'
--
-- Sidan läser anteckningar med `profiles:created_by(full_name)`, men
-- `notes.created_by` pekar på `auth.users` och inte på `public.profiles`. Utan en
-- relation dit kan PostgREST inte lösa inbäddningen.
--
-- Och eftersom inbäddningen löses när frågan tolkas, inte per rad, spelar det
-- ingen roll att tabellen är tom: frågan faller innan någon rad hämtas. Alla
-- kundkort är otillgängliga, inte bara de med anteckningar.
--
-- Det träffar mer än kundkortet. "Ring ett nytt nummer" i dialern skapar ett
-- prospekt och skickar säljaren till dess kundkort -- så vägen från ett inskrivet
-- nummer till ett samtal slutar också här.
--
-- `tenant_memberships` löste detta för länge sedan med två nycklar på samma
-- kolumn: en till auth.users för identiteten, en till profiles för
-- inbäddningen. Det är samma lösning här, av samma skäl.
--
-- Uppskjuten som förebilden: en anteckning kan skrivas i samma transaktion som
-- profilen skapas, och då finns raderna först när transaktionen avslutas.

alter table public.notes
  drop constraint if exists notes_created_by_profile_fk;
alter table public.notes
  add constraint notes_created_by_profile_fk
  foreign key (created_by) references public.profiles (id)
  on delete set null
  deferrable initially deferred;

comment on constraint notes_created_by_profile_fk on public.notes is
  'Låter PostgREST lösa profiles:created_by. Identiteten ägs fortfarande av notes_created_by_fkey mot auth.users.';
