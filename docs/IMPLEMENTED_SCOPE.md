# Implementerad omfattning

## Verifierat i denna leverans

- Next.js/TypeScript-webbapp med server actions och versionerat REST-API
- 18 reproducerbara SQL-migrationer med 108 publika tabeller, 140 funktioner och 220 RLS-policyer i SQL-testmiljön
- Tenant, juridiska bolag, kontor/avdelningar, medlemskap, roller, team och feature-flaggor
- CRM-kunder, företag, prospekt, anteckningar, aktiviteter, listor, kampanjer och pipeline
- CSV-import med simulering, normalisering, deduplicering, spärrkontroll, commit och rollback
- Central katalog: master entities, source entities/facts, field provenance/history och freshness
- Providerkonton, permissions, tillåtna fält/domäner/paths, kvoter och parser-versioner
- Lokal katalogsökning, entitetsvisning, stale-while-revalidate, segment och bulkberikningsjobb
- Generisk JSON-provideradapter med krypterade credentials/raw payloads, SSRF-skydd, timeout och karantän
- 20-dagars standard-TTL samt konfigurerbar freshness per fält/provider
- Atomiska refresh-lås, providerkvoter, concurrency, retries och enrichment usage
- Dialergränssnitt, WebRTC-klient, samtalskö, calls/outbox och 46elks-callbacks
- SMS/e-post med idempotens, central spärrpolicy, NIX/freshnessmodell, usage-reservation och kostnadstak
- Produkter, prisversioner, avtalsmallar, godkännande, versionslås och legal/commercial snapshots
- Avtalsutskick, accept, evidence manifest/PDF/hash och kundbekräftelse
- Automationer, testläge, godkännande, loopskydd, retry och dead letter
- API-nycklar, scopes, rate limits, OpenAPI och signerade webhooks
- TypeScript-, Deno-, statiska arkitektur-, SQL-exekverings- och produktionsbuildkontroller

## Finns som plattform men kräver leverantörsspecifik anslutning

- Merinfo/Alla Bolag/annan kommersiell datakälla: generisk adapter och permissionsmodell finns; deras exakta API-/fil-/parserkontrakt och credentials måste konfigureras enligt skriftligt tillstånd.
- Bolagsverket, SCB och geokodning: datamodellen är förberedd men respektive liveadapter ingår inte utan valt avtal/API.
- NIX: tabell, freshness och central pre-contact-kontroll finns; faktisk NIX-leverantör/import måste anslutas.
- BankID/avancerad e-signering: avtals- och bevismodellen finns; konkret BankID/Documenso/DocuSeal-provider måste väljas och implementeras.
- Prediktiv dialer, supervisor-medlyssning och coachning kräver särskild mediamotor och juridisk kontroll.
- Excel, SFTP och leverantörsspecifika schemalagda importer kräver respektive adapter; webbappen genomför CSV.
- Visuell drag-and-drop-editor för signaturfält kräver vald e-signmotor.
- Extern kalender-/mailboxsynk kräver OAuth-provider.
- Betalprovider och kommersiell abonnemangsdebitering är inte inkopplad, men usage/limits/faktureringsunderlag finns.

## Produktionsstatus

Det är fel att beskriva hela kravbilden som färdig enbart för att build och migrationer är gröna. Leveransen är en sammanhängande, körbar produktgrund. Skarp försäljning kräver att samtliga relevanta punkter i `PRODUCTION_GATES.md` verifieras i staging och produktion.
