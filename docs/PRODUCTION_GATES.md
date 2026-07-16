# Produktionsgrindar

Följande måste godkännas före försäljning eller skarp kundtrafik.

## Leverantörer och data

- Signerat upplägg och livecredentials för 46elks, e-postleverantör, dataleverantör och NIX-källa.
- Exakta providerfält, kvoter, cacheomfattning, lagring, filtrering, visning, export och retention registrerade från avtalet.
- Officiellt och aktuellt geografiskt referensregister importerat och verifierat.
- Verifierade callbackpayloads och providerfel mot staging.
- NIX-resultatmapping, giltighet och omkontroll testad med verklig källa.
- SPF, DKIM och DMARC verifierade för alla avsändardomäner.
- Vald BankID/e-signleverantör där stark identitet krävs.

## Juridik och dataskydd

- Juristgodkända B2C- och B2B-mallar per bransch.
- Kontroll av distansavtals-, telefonförsäljnings-, ångerrätts- och informationskrav.
- DPIA, registerförteckning, rättslig grund och retention per datakälla och tenant.
- Personuppgiftsbiträdesavtal med samtliga underleverantörer.
- Inspelningsinformation, rättslig grund och gallring.
- DSAR-process, identitetsverifiering, legal hold, registerutdrag och radering genomförda i testfall.
- NIX-/invändningsprocess och minimal suppression-post juridiskt fastställda.

## Teknik och säkerhet

- Full `db push` körd i ren Supabase staging och ny tom produktionsmiljö.
- Genererade Supabase-typer incheckade efter den riktiga databasen.
- RLS-penetrationstest med minst två tenants och samtliga roller.
- Backup/restore-test med dokumenterad RTO och RPO.
- Extern malware-scanner konfigurerad; `REQUIRE_IMPORT_MALWARE_SCAN=true`; ren och infekterad testfil verifierade.
- MFA-enforcement för adminroller.
- Key rotation, incidentprocess, loggexport och larm.
- Lasttest av dialer, webhook retries, outbox, automationer, katalogsökning, segment och importvolymer.
- Browser-, tillgänglighets-, SAST-, DAST- och penetrationstest.
- Retention- och DSAR-worker provkörd mot anonymiserad stagingdata.

## Produkt och drift

- Slutlig branding, domän och bolagsinformation.
- Abonnemang, usage limits, överdebitering och avstängningsregler.
- Support-, SLA-, status- och incidentkommunikation.
- Onboardingmaterial och administratörsutbildning.
- Schedulerövervakning för samtliga sex workers och larm på dead-letter/kvarstående jobb.
