# Next actions

Uppdaterad 2026-09-15. Webbtelefonens leverantörsoberoende halva är byggd, verifierad och
mergad-klar. Det som återstår på den delen kräver ett svar från telefonitjänsten.

## Blockerat på ett externt svar

1. **Skicka förfrågan i `docs/integrations/RINKEL_WEBPHONE_FORFRAGAN.md`.** Fyra frågor,
   varje svar ett ja eller ett nej. Fråga 1 — får vi SIP-registreringsuppgifter per plats —
   avgör vilken väg webbtelefonen tar.
   - **Ja** → byt ut `src/lib/telephony/webphone/rinkel.ts`. Inget annat.
   - **Nej** → flytta utgående röst till en leverantör med WebRTC-SDK (Twilio, Telnyx,
     Sinch, Vonage) och porta numret. Adapterlagret gör det till en fil.
2. Sätt `WEBPHONE_STUN_URLS`, `WEBPHONE_TURN_URLS` och `WEBPHONE_TURN_SECRET` när
   TURN finns. Utan relä blir felet "kunden hör mig inte" i stället för ett ärligt
   uppkopplingsfel.

## Kvar att bygga när uppgifterna finns

3. Webbtelefonens gränssnitt: mikrofontillstånd, headsetväljare, mute, hold, DTMF via
   `RTCDTMFSender`, nivåmätare före första samtalet, dolt `<audio playsInline>` och en
   AudioContext som låses upp av en användargest.
4. `sip.js`-registreringen som anropar `/api/v1/telephony/webphone/session`, slår hjärtslag
   var 15:e sekund och rapportar benet till `/api/v1/telephony/webphone/leg`.
5. Beslut: ska inkommande samtal ringa i Kundexa? Kräver ringläge, svara/avvisa och en
   regel för vem som får samtalet.

## Oberoende av webbtelefonen

6. **Webhookarna är inte verifierade.** `platform_rinkel_capabilities.webhooks: false`,
   `core_webhooks_verified: false`. Det är därför samtal hänger och `answered_at` aldrig
   fylls i på `/dial`-vägen. Högsta prioritet av det som återstår.
7. Ta bort de två döda Supabase-cronjobben (`kundexa-workers-every-minute`,
   `kundexa-maintenance-hourly`). De är avstängda dubbletter av Vercel Cron vars
   vault-hemligheter aldrig skapats, och de har redan fått en läsare att felrapportera
   friska jobb som stillastående (FAILURE-0098).
8. Skriv om meddelandet i `current_user_dial_path` som ber administratören köra
   "Rätta uppringningsvägen". Rättningen kan inte ge det meddelandet lovar (FAILURE-0097).
9. Migrationerna saknar table grants — schemat kan inte byggas om från dem ensamt
   (13 av 181 tabeller läsbara på en färsk branch). Kräver beslut om säkerhetshållning.
10. Påminnelsemailets rubrik använder `tenant.legal_name` i stället för den valda
    `tenant_legal_entities`-raden, och visar fel bolag för en tenant med flera juridiska
    personer.

## Användarens egna steg

11. Testsamtalet: ring, svara, lägg på. Enda sättet att se om `answered_at` fylls i.
12. Resend: verifiera `kundexa.se`, sätt `RESEND_API_KEY`, `DEFAULT_EMAIL_FROM_ADDRESS`,
    `DEFAULT_EMAIL_FROM_NAME` i Vercel, lägg till Gridex domän.
13. Godkänn en avtalsmall; rätta de två ogiltiga organisationsnumren.
