-- ---------------------------------------------------------------------------
-- Den borttagna leverantören fanns kvar som levande konfiguration
-- ---------------------------------------------------------------------------
-- Schemat och källkoden städades i 202609170009, och bygget fäller sedan dess
-- varje försök att skriva namnet igen. Ingen av de kontrollerna ser data: de
-- läser källträdet och de genererade typerna, alltså vilka tabeller och
-- funktioner som finns -- inte vad som står i raderna.
--
-- Tre rader beskrev därför fortfarande en leverantör som inte längre kan göra
-- någonting, och två av dem är fällor snarare än skräp:
--
--   platform_integrations       en rad med status 'connected' mot en leverantör
--                               vars klient inte finns kvar i koden.
--
--   provider_network_allowlists två aktiva nät för den gamla leverantörens
--                               webhookar. `is_provider_ip_allowed` frågar per
--                               leverantör, och det finns inga nät för den
--                               nuvarande. Den dagen någon sätter
--                               ENFORCE_SMS_IP_ALLOWLIST=true avvisas därför
--                               varje leveransrapport och varje inkommande SMS
--                               med 403 -- inklusive kundens "JA" på ett avtal --
--                               medan den gamla leverantörens adresser är de
--                               enda som släpps in.
--
--   platform_worker_heartbeats  en rad i status 'failed' för en arbetare som
--                               inte längre schemaläggs. Ett permanent rött
--                               larm som ingen kan åtgärda gör nästa riktiga
--                               larm omöjligt att se.
--
-- Historiken rörs inte. `audit_logs`, `platform_audit_logs`, `calls.provider`,
-- `calls.end_cause` och de färdiga jobben i `outbox_jobs` bär vad som faktiskt
-- hände: de samtalen kopplades av den leverantören. Att skriva om dem vore att
-- förfalska protokollet, och `calls.provider` är dokumenterad just som "vem som
-- kopplade samtalet".

delete from public.platform_integrations where provider = 'rinkel';

delete from public.provider_network_allowlists where provider = 'rinkel';

delete from public.platform_worker_heartbeats where worker_key = 'rinkel-platform-worker';

-- Självkontroll i samma anda som borttagningsmigrationen: om något av ovanstående
-- inte tog, ska migrationen säga det nu och inte upptäckas av den som slår på
-- IP-spärren ett halvår senare.
do $$
declare
  v_left bigint;
begin
  select
    (select count(*) from public.platform_integrations where provider = 'rinkel')
    + (select count(*) from public.provider_network_allowlists where provider = 'rinkel')
    + (select count(*) from public.platform_worker_heartbeats where worker_key like '%rinkel%')
  into v_left;
  if v_left > 0 then
    raise exception 'provider_configuration_removal_incomplete: % rader kvar', v_left;
  end if;
end $$;
