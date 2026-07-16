# Produktionsgrindar

Följande måste godkännas före försäljning eller skarp kundtrafik.

## Leverantörer

- Signerat kommersiellt upplägg med 46elks, inklusive subkonton, krediter, nummer, portering, caller ID och WebRTC.
- Verifierade 46elks-callbacknät i `provider_network_allowlists`.
- Verifierad e-postdomän, SPF, DKIM och DMARC.
- Avtal och användningsändamål för Merinfo eller annan prospektleverantör.
- Vald BankID/e-signleverantör för avtal där starkare identitet krävs.

## Juridik och dataskydd

- Juristgodkända B2C- och B2B-mallar per bransch.
- Kontroll av distansavtals-, telefonförsäljnings-, ångerrätts- och informationskrav.
- DPIA, registerförteckning, rättslig grund och retention per datakälla.
- Personuppgiftsbiträdesavtal med samtliga underleverantörer.
- Inspelningsinformation, rättslig grund och gallring.
- NIX-/invändningsprocess och dokumenterad spärrhantering.

## Teknik och säkerhet

- Full migration körd i staging och ny tom produktion.
- RLS-penetrationstest med minst två tenants och samtliga roller.
- Backup/restore-test med dokumenterad RTO och RPO.
- Malware-scanning för uppladdningar.
- MFA-enforcement för adminroller.
- Key rotation, incidentprocess, loggexport och larm.
- Lasttest av dialer, webhook retries, outbox, automationer och importvolymer.
- Browser- och tillgänglighetstest.
- Verifiering av faktiska 46elks/Resend-callbackpayloads mot staging.

## Produkt

- Slutlig branding, domän och bolagsinformation.
- Abonnemang, usage limits, överdebitering och avstängningsregler.
- Support-, SLA-, status- och incidentkommunikation.
- Onboardingmaterial och administratörsutbildning.
