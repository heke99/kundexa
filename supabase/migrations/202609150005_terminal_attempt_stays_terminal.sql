-- Ett släppt samtalsförsök får aldrig tas tillbaka av en sen providerhändelse.
--
-- Mätt i produktion 2026-09-15, och det låste säljaren i en och en halv timme:
--
--   10:57:21  call.ended_by_user               attempt_released: true
--   10:58:02  callEnd                          provider_cause: ANSWERED
--   10:59:02  rinkel.call_reconciled_from_cdr  status tillbaka till 'matched'
--
-- `reconcile_rinkel_call_from_cdr` skriver
--   `status = case when p_ended_at is not null then 'completed' else 'matched' end`
-- utan att titta på vad försöket redan står på. CDR:n kom utan sluttid, så den
-- skrev `matched` — och `matched` är en av statusarna reservationen vägrar mot,
-- medan sopningen avsiktligt inte släpper den (ett `matched` försök kan vara ett
-- pågående samtal). Säljaren var alltså låst tills någon ingrep för hand.
--
-- Det här är samma klass som låste platsen i tre dygn den 11 september, men en
-- annan väg in: den gången stängdes försöket aldrig, den här gången stängdes det
-- och öppnades igen.
--
-- Spärren ligger på tabellen och inte i den funktionen, av två skäl. Minst fyra
-- ställen skriver försökets status — CDR-avstämningen, `correlate_rinkel_outgoing_event`
-- och två äldre varianter — och en regel som ska gälla alla ska stå på ett ställe.
-- Och nästa skrivare som läggs till ärver spärren utan att någon behöver minnas
-- den.
--
-- Providern får fortfarande berika raden: `external_call_id` och allt annat i
-- samma UPDATE går igenom. Det enda som vägras är att ta tillbaka platsen.

create or replace function public.keep_terminal_dial_attempt_terminal()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if old.status not in ('completed','failed','expired') then
    return new;
  end if;
  if not public.rinkel_attempt_holds_seat(new.status) then
    return new;
  end if;

  -- Behåll den terminala statusen men släpp igenom resten av skrivningen, så en
  -- sen CDR fortfarande kan fylla i `external_call_id` och liknande.
  new.status := old.status;
  new.error_code := coalesce(old.error_code, new.error_code);
  new.error_message := coalesce(old.error_message, new.error_message);
  return new;
end $$;

comment on function public.keep_terminal_dial_attempt_terminal() is
  'Hindrar en sen providerhändelse från att flytta ett avslutat samtalsförsök tillbaka till en status som håller säljarens plats upptagen.';

drop trigger if exists keep_terminal_dial_attempt_terminal on public.rinkel_call_attempts_v2;
create trigger keep_terminal_dial_attempt_terminal
  before update of status on public.rinkel_call_attempts_v2
  for each row execute function public.keep_terminal_dial_attempt_terminal();

revoke all on function public.keep_terminal_dial_attempt_terminal() from public, anon, authenticated;

-- Städa upp det som redan hunnit bli återöppnat: ett försök som står i en
-- platshållande status trots att dess samtal är avslutat har inget att skydda.
update public.rinkel_call_attempts_v2 a
set status = case when a.error_code is not null and a.error_code like '%FAIL%' then 'failed' else 'completed' end,
    error_code = coalesce(a.error_code, 'REOPENED_AFTER_RELEASE'),
    updated_at = now()
from public.calls c
where c.id = a.call_id
  and public.rinkel_attempt_holds_seat(a.status)
  and public.call_status_rank(c.status) >= 100;
