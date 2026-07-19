# Implementerad omfattning

## Verifierat i denna leverans

- Next.js/TypeScript-webbapp med server actions och versionerat REST-API
- 24 reproducerbara SQL-migrationer med 132 publika tabeller, 209 funktioner och 263 RLS-policyer i SQL-testmiljön
- Tenant, juridiska bolag, kontor/avdelningar, medlemskap, roller, team och feature-flaggor
- CRM-kunder, företag, prospekt, anteckningar, aktiviteter, listor, kampanjer och pipeline
- Säker multi-formatimport: CSV, JSON, NDJSON, XML och grundläggande tabulär XLSX
- Malware-scan-gate, preview, normalisering, deduplicering, spärrkontroll, commit och rollback
- Synkronisering från tenantimport till både CRM-kund och tenantisolerad katalog/source facts
- Central katalog: master/source entities, source facts, provenance, history, freshness, conflicts och datakvalitet
- Licensseparation mellan lagring, filtrering och visning
- Source priority, identitetsnycklar, dublettförslag, merge och undo merge
- Lokal katalogsökning med korrekta totalantal, freshnessfördelning, avancerade filter och radie
- Dynamiska segment, snapshots, memberships, refresh och policykontrollerad materialisering till kampanj eller statisk/dynamisk ringlista
- Providerkonton, permissions, tillåtna fält/domäner/paths, cacheomfattning, kvoter och parser-versioner
- Discovery från tom katalog, femdagarsschema, prioritering, pagination, kontrollpunkter och återupptagning
- Råpayload före parser, fingerprints, disappearance threshold, observations och karantän
- JSON, NDJSON, CSV och tillståndsstyrd HTML-regex som generiska discoveryformat
- 20-dagars standard-TTL samt konfigurerbar freshness per fält/provider
- Atomiska refresh-lås, providerkvoter, concurrency, retries och dead-letter-status
- Geografiskt referensregister, normalisering och versionsstyrd import
- NIX-konfiguration, kö, claim, provideradapter, separat giltighet och automatisk kampanjresume
- Många-till-många-säljtilldelning, manuella/automatiska listor, atomiska prospektclaims, återkomstprioritet och daglig säljargräns
- Sekventiell WebRTC/power dialer med caller-ID, inspelningspolicy, realtidsstatus, providerhangup-gate och obligatoriskt transaktionellt efterarbete
- Fristående manuell dialer med kanonisk nummermatchning, callbackkoppling, utfall, anteckning och kontaktspärr
- Personliga/globala återkomster med claim, snooze, omfördelning, session-release, badges och tenanttidszon
- Kanoniska anteckningar med typer, synlighet, fästning, revisionshistorik och arkivering
- Samtalsbaserade order/orderrader med produkt-/prisspårning och livscykelkonvertering utan kunddubblett
- Händelsebaserad list-/dialerrapportering och Realtime-publicering av berörda kanoniska tabeller
- SMS/e-post med idempotens, central spärrpolicy, usage-reservation och kostnadstak
- Produkter, prisversioner, avtalsmallar, godkännande, versionslås och legal/commercial snapshots
- Avtalsutskick, accept, evidence manifest/PDF/hash och kundbekräftelse
- Automationer, testläge, godkännande, loopskydd, retry och dead letter
- Retention, legal holds, DSAR-export, restriction och kontrollerad anonymisering
- API-nycklar, scopes, rate limits, OpenAPI och signerade webhooks
- TypeScript-, Deno-, arkitektur-, SQL-runtime- och produktionsbuildkontroller

## Kräver leverantörsspecifik eller extern anslutning

- Merinfo, Alla Bolag eller annan prospektkälla: permissions-, ingestion- och adapterram finns; deras exakta liveformat, credentials och avtal måste konfigureras och stagingtestas.
- NIX: adapterram och kampanjflöde finns; faktisk NIX-källa, mapping och credentials måste konfigureras.
- Geografiregister: import- och normaliseringsmotor finns; officiell aktuell fil från exempelvis SCB måste importeras.
- Malware scanning: obligatorisk gate och extern scannerintegration finns; en faktisk scannerservice måste konfigureras i produktion.
- BankID/avancerad e-signering: avtals- och bevismodellen finns; konkret provider krävs.
- Prediktiv dialer, medlyssning och coachning kräver särskild mediamotor och juridisk kontroll.
- SFTP och leverantörsspecifika Excel/XML-layouts kräver respektive adapterkonfiguration.
- Visuell drag-and-drop-editor för PDF-signaturfält kräver vald e-signmotor.
- Extern kalender-/mailboxsynk kräver OAuth-provider.
- Betalprovider för faktisk abonnemangsdebitering är inte inkopplad; usage, limits och faktureringsunderlag finns.

## Produktionsstatus

Leveransen är en sammanhängande och körbar produktgrund. Skarp försäljning kräver att relevanta punkter i `PRODUCTION_GATES.md` verifieras i riktig staging och produktion.
