# Next actions

**2026-09-22, först:** Skapa produkten (t.ex. "Elavtal rörligt") under Produkter, öppna mallen
"Gridex hemsida · Mina sidor", välj produkten under Redigera och spara. Den godkända
versionen gäller direkt. Skapa sedan ett avtal från en kund och skicka det till egen e-post.

Uppdaterad 2026-09-18. Bytet till Sinch är genomfört och **mergat till main** (PR #19,
`69f5d6f`). Webben och Edge-funktionerna är deployade; `/api/ready` svarar
`telephonyConfigured: true`, och de tre webhookarna svarar 403 på en osignerad begäran.
Det som återstår kräver leverantörskonto, ett nummer eller ett riktigt samtal.

**Ingen avtalsleverans har någonsin körts i produktion.** Det finns noll rader i
`sms_messages` och `email_messages` med en acceptlänk, så hela kedjan är oprövad skarpt.

## Användarens egna steg

1. **Registrera callback-adressen** i Sinch kontrollpanel. Använd den adress
   `GET /api/ready` skriver ut (`checks.webhookUrl`) — i dag
   `https://www.kundexa.se/api/webhooks/sinch`, alltså **med `www`**. Apex redirectar
   till www, och en POST som möter en omdirigering kan tappas tyst.
2. **Köp eller porta numren med svensk originering.** I dag finns **ett enda nummer i
   hela systemet**, `+1 208 581 0392` (US, röst men inte SMS). Gridex skulle alltså ringa
   svenska mottagare med ett amerikanskt nummer, Trustcall har inget alls, och
   `queue_sms_message` kastar `sms_sender_missing` för båda — inget avtals-SMS kan skickas
   av någon förrän ett svenskt nummer med både röst och SMS finns. Ett svenskt nummer som origineras
   utomlands blockeras av operatörerna enligt PTS föreskrift — det avgör både om samtalet
   kopplas och minutpriset (originerings­prefixet är ungefär elva gånger i skillnad).
3. **Sätt SMS-nycklarna** i Vercel och Supabase Edge Secrets: `SMS_SERVICE_PLAN_ID`,
   `SMS_API_TOKEN`, `SMS_REGION`. Utan dem dödbrevas varje avtals-SMS med
   `permanent_sms_provider_not_configured`.
   Sätt även `SINCH_PROJECT_ID`, `SINCH_KEY_ID` och `SINCH_KEY_SECRET` om ni vill
   hyra nummer inifrån Kundexa i stället för i leverantörens panel.
4. **Testsamtalet.** Ring, svara, lägg på. Det är enda sättet att se att webbtelefonen
   registrerar sig, att A-numret syns hos mottagaren och att händelserna når webhooken.
5. **Test-SMS med ett avtal.** Skicka, svara "JA", kontrollera att acceptansen registreras.
5b. **Slå på `outbound_sms` för Gridex.** Flaggan är `false` i produktion medan
   `contract_delivery_sms` är `true`. Utskicket stoppas nu före köandet med en
   förklaring till säljaren i stället för att dödbrevas i arbetaren, men avtalet går
   fortfarande inte iväg förrän flaggan är på. Trustcall har dessutom
   `contract_delivery_sms: false`.
6. Resend: verifiera `kundexa.se`, sätt `RESEND_API_KEY`, `DEFAULT_EMAIL_FROM_ADDRESS`,
   `DEFAULT_EMAIL_FROM_NAME` i Vercel, lägg till Gridex domän.
7. Godkänn en avtalsmall; rätta de två ogiltiga organisationsnumren.
8. Sätt `NEXT_PUBLIC_APP_URL` (Vercel) och `APP_URL` (Supabase Edge Secrets) till
   **samma** adress, och gör den till primär domän i Vercel. Webbappen bygger första
   utskickets länk ur den första, utskicksarbetaren bygger påminnelsens länk och
   SMS-leveransens callback ur den andra. Går de isär pekar påminnelsen på en annan värd
   än avtalet. `/api/ready` rapporterar nu `checks.delivery.linkHostAligned`, som är
   `false` precis när de två skiljer sig åt. Appen ligger i dag på `www` medan produkten
   var tänkt på apex — välj en av dem och sätt båda variablerna till den.

## Kvar att bygga

9. Webbtelefonens gränssnitt: mikrofontillstånd, headsetväljare, mute, hold, DTMF,
   nivåmätare före första samtalet och en AudioContext som låses upp av en användargest.
10. Beslut: ska inkommande samtal ringa i Kundexa? Kräver ringläge, svara/avvisa och en
    regel för vem som får samtalet.
11. Säga upp ett nummer inifrån Kundexa. Medvetet utelämnat: det har uppsägningstid
    och fakturaföljd, så det görs i leverantörens panel tills någon bestämt hur
    bekräftelsen ska se ut.
12. Migrationerna saknar table grants — schemat kan inte byggas om från dem ensamt.
    Kräver beslut om säkerhetshållning.

## Skulder som är värda att veta om

14. `release_stale_dial_attempts` och `release_lost_webphone_sessions` var skrivna men
    aldrig schemalagda, alltså skyddsnät som aldrig fångat någon. De körs nu ur
    maintenance-workern. Ingen av dem har ännu släppt ett försök i produktion.
15. Inspelningar hämtas inte från leverantören. `/api/v1/calls/[id]/recording` kastar
    `recording_not_fetched_from_provider` i stället för att dela ut en trasig länk, och
    gallringens leverantörshalva vägrar med `permanent_provider_recording_delete_unsupported`
    hellre än att märka en inspelning som gallrad medan kopian lever kvar.
- Prova ett webbläsarsamtal mot deploy med minimal SVAML (PR #40) och migration 202609230002; läs
  `sinch.call_ended`-orsaken på samtalet om DiCE kommer. Kommer ingen DiCE: kontrollera i Sinch-
  appen att "Calling → callback" även skickar DiCE, och öppna ärende hos Sinch med call-id.
