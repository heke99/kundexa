-- Två cronjobb som aldrig kunde köra, och som fick en läsare att felrapportera
-- friska schemaläggare som stillastående.
--
-- `kundexa-workers-every-minute` och `kundexa-maintenance-hourly` bygger sina
-- anrop av två vault-hemligheter, `kundexa_project_url` och
-- `kundexa_cron_secret`. `vault.secrets` har noll rader och har alltid haft det,
-- så url:en hade blivit `null || '/functions/v1/...'` — alltså null — och
-- `net.http_post` hade anropat ingenting. Båda står dessutom `active = false`.
--
-- Den riktiga schemaläggaren är Vercel Cron via `vercel.json`, och den kör: 180
-- träffar per väg på tre timmar, 1127 av 1128 svar 200. De här två är alltså
-- inte en reserv utan en dubblett — att slå på dem hade dubbelkört varje worker.
--
-- Skälet att ta bort dem i stället för att låta dem ligga: de är en fälla. Jag
-- läste `cron.job`, såg `active = false` på båda raderna och rapporterade att
-- allt bakgrundsarbete stod stilla (FAILURE-0098). Konfigurationsrader som ser
-- auktoritativa ut men inte är i drift kostar mer än de smakar.
--
-- Skulle Supabase-cron någon gång bli den rätta vägen läggs jobben upp igen,
-- och då med hemligheterna satta först.

do $$
declare
  v_removed text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- pg_cron finns inte i testriggen, och ett saknat schema är inget fel här.
    return;
  end if;

  select string_agg(jobname, ', ')
  into v_removed
  from cron.job
  where jobname in ('kundexa-workers-every-minute', 'kundexa-maintenance-hourly');

  if v_removed is null then
    return;
  end if;

  -- Vägra ta bort ett jobb som faktiskt körde. Om någon aktiverat dem sedan
  -- mätningen är förutsättningen för den här migrationen inte längre sann, och
  -- då ska den stanna och säga det i stället för att tyst stänga av produktion.
  if exists (
    select 1 from cron.job
    where jobname in ('kundexa-workers-every-minute', 'kundexa-maintenance-hourly')
      and active
  ) then
    raise exception 'refusing to drop an active cron job: %', v_removed;
  end if;

  perform cron.unschedule(jobid)
  from cron.job
  where jobname in ('kundexa-workers-every-minute', 'kundexa-maintenance-hourly');

  raise notice 'removed dead cron jobs: %', v_removed;
end $$;
