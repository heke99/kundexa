# Next actions

Uppdaterad 2026-09-17. Bytet till Sinch är genomfört: Rinkel och 46elks finns varken i
källkoden, i schemat eller i driftdokumentationen, och `npm run verify` är grön i sin
helhet. Det som återstår kräver leverantörskonto eller ett riktigt samtal.

## Användarens egna steg

1. **Registrera callback-adressen** i Sinch kontrollpanel:
   `https://kundexa.se/api/webhooks/sinch`. Den går inte att läsa tillbaka via API, så
   `GET /api/ready` rapporterar vilken adress den borde vara (`checks.webhookUrl`).
2. **Köp eller porta numren med svensk originering.** Ett svenskt nummer som origineras
   utomlands blockeras av operatörerna enligt PTS föreskrift — det avgör både om samtalet
   kopplas och minutpriset (originerings­prefixet är ungefär elva gånger i skillnad).
3. **Sätt SMS-nycklarna** i Vercel och Supabase Edge Secrets: `SMS_SERVICE_PLAN_ID`,
   `SMS_API_TOKEN`, `SMS_REGION`. Utan dem dödbrevas varje avtals-SMS med
   `permanent_sms_provider_not_configured`.
4. **Testsamtalet.** Ring, svara, lägg på. Det är enda sättet att se att webbtelefonen
   registrerar sig, att A-numret syns hos mottagaren och att händelserna når webhooken.
5. **Test-SMS med ett avtal.** Skicka, svara "JA", kontrollera att acceptansen registreras.
6. Resend: verifiera `kundexa.se`, sätt `RESEND_API_KEY`, `DEFAULT_EMAIL_FROM_ADDRESS`,
   `DEFAULT_EMAIL_FROM_NAME` i Vercel, lägg till Gridex domän.
7. Godkänn en avtalsmall; rätta de två ogiltiga organisationsnumren.
8. Sätt `NEXT_PUBLIC_APP_URL` och `APP_URL` till `https://kundexa.se`, och gör apex till
   primär domän i Vercel. Callback-adressen härleds ur app-URL:en, så de två kan inte
   längre glida isär — men appen ligger i dag på `www` medan produkten ska ligga på apex.

## Kvar att bygga

9. Webbtelefonens gränssnitt: mikrofontillstånd, headsetväljare, mute, hold, DTMF,
   nivåmätare före första samtalet och en AudioContext som låses upp av en användargest.
10. Nummertilldelning per team, lista och kampanj i gränssnittet. Kolumnerna och
    resolvern finns (`caller_id_phone_number_id`, `resolve_caller_id_phone_number`);
    det som saknas är formulären. Företagets förval går redan att sätta.
11. Hyra nya nummer från leverantören inifrån Kundexa. I dag köps de i deras panel och
    läggs in för hand i `phone_numbers`.
12. Beslut: ska inkommande samtal ringa i Kundexa? Kräver ringläge, svara/avvisa och en
    regel för vem som får samtalet.
13. Migrationerna saknar table grants — schemat kan inte byggas om från dem ensamt.
    Kräver beslut om säkerhetshållning.

## Skulder som är värda att veta om

14. `release_stale_dial_attempts` och `release_lost_webphone_sessions` var skrivna men
    aldrig schemalagda, alltså skyddsnät som aldrig fångat någon. De körs nu ur
    maintenance-workern. Ingen av dem har ännu släppt ett försök i produktion.
15. Inspelningar hämtas inte från leverantören. `/api/v1/calls/[id]/recording` kastar
    `recording_not_fetched_from_provider` i stället för att dela ut en trasig länk, och
    gallringens leverantörshalva vägrar med `permanent_provider_recording_delete_unsupported`
    hellre än att märka en inspelning som gallrad medan kopian lever kvar.
