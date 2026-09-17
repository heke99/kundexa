-- Ringtiderna är en systeminställning, inte något som sätts per bolag för hand.
--
-- Förvalet har varit måndag till fredag, 09:00-18:00. Det stoppade ett samtal
-- klockan 18:12 i dag, vilket spärren skulle göra -- men fönstret var satt en
-- gång för länge sedan och har aldrig varit ett medvetet beslut.
--
-- Det nya förvalet är alla dagar, 08:00-21:00, Europe/Stockholm. Det är ägarens
-- beslut och gäller hela systemet: befintliga bolag skrivs om, och nya ärver det.
--
-- Vad som inte ändras: NIX-registret, samtyckeskravet, syftesprövningen och
-- spärrade nummer prövas på varje samtal precis som förut. Det enda som vidgas
-- är klockan.

alter table public.telephony_policies
  alter column allowed_days set default '{1,2,3,4,5,6,7}'::integer[],
  alter column allowed_start_time set default '08:00'::time,
  alter column allowed_end_time set default '21:00'::time;

-- Befintliga bolag skrivs om, men bara de som står kvar på det gamla förvalet.
-- Ett bolag som medvetet valt egna tider ska inte få dem överskrivna av att
-- förvalet ändras -- det är skillnaden mellan att flytta en standard och att
-- köra över ett beslut.
update public.telephony_policies
set allowed_days = '{1,2,3,4,5,6,7}'::integer[],
    allowed_start_time = '08:00'::time,
    allowed_end_time = '21:00'::time,
    updated_at = now()
where allowed_days = '{1,2,3,4,5}'::integer[]
  and allowed_start_time = '09:00'::time
  and allowed_end_time = '18:00'::time;

comment on column public.telephony_policies.allowed_days is
  'Veckodagar (ISO 1-7) då utgående samtal får ringas. Förval: alla dagar.';
comment on column public.telephony_policies.allowed_start_time is
  'Tidigaste tidpunkt för utgående samtal, i bolagets tidszon. Förval: 08:00.';
comment on column public.telephony_policies.allowed_end_time is
  'Senaste tidpunkt för utgående samtal, i bolagets tidszon. Förval: 21:00.';
