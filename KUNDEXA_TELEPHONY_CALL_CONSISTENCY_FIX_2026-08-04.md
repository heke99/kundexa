# Kundexa – telefoni och samtalsstart

Datum: 2026-08-04

## Vad som var inkonsekvent

1. Den manuella dialern skickade inte alltid ett explicit nummerallokerings-ID när säljaren bara hade ett tillgängligt nummer.
2. Status-RPC:n kunde bedöma verklig användare, enhet och nummer som redo, medan reservations-RPC:n fortfarande blockerade på en äldre denormaliserad `dial_configured`-flagga.
3. Delad teamåtkomst gjorde numret synligt, men caller-ID-resolvern utgick delvis från kundens team i stället för säljarens egna aktiva teammedlemskap.
4. En tenantadmin kunde välja en telefonienhet som inte hörde till den valda telefoni-användaren.
5. En sparad användarmappning skapade inte säkert säljarens direkta ringbehörighet till standardnumret.
6. Katalogsynken accepterade inte alla rimliga direkta API-svar och uppdaterade inte alltid den kanoniska readiness-modellen.
7. Lokala databas- och finaliseringsfel kunde presenteras som telefonitjänstfel.
8. Fel i säljarvyn saknade ett neutralt referens-ID som kunde kopplas till serverloggen.

## Genomförd korrigering

- Dialern väljer standardnumret eller det första tillgängliga numret och skickar alltid dess allokerings-ID.
- Samtalsknappen blockeras när säljaren saknar ett faktiskt valbart utgående nummer.
- Readiness och samtalsreservation använder samma runtime-kontrakt: aktiv mappning, aktiv tillhörande enhet och ett caller-ID som resolveras till ett aktivt provider-ID.
- Den äldre cacheflaggan får inte längre ensam stoppa ett annars giltigt manuellt samtal.
- Caller-ID kan lösas via direkt användargrant, säljarens egna teamgrantningar, tenantgrant eller explicita standarder. Endast `dial` och `manage` ger utgående ringbehörighet.
- En och samma centrala telefonnummerresurs kan ha tenantseparerade allokeringar och teamgrantningar i flera bolag.
- Säljarmappningen validerar atomiskt att enheten hör till den valda telefoni-användaren.
- När mappningen sparas skapas eller återanvänds exakt en aktiv direkt `dial`-grant för säljarens standardnummer.
- Katalogsynk uppdaterar aktiva användare, enheter, nummer och kanoniska capabilities tillsammans.
- API-fel innehåller ett `correlationId` både i svaret och i `x-correlation-id`. Säljaren ser endast en neutral `Referens: <id>`.
- `.env.example` innehåller inte längre Supabase-hemligheter.

## Ny migration

```text
supabase/migrations/202608040001_rinkel_dial_selection_consistency.sql
```

Migrationen måste vara applicerad innan den nya appversionen används.

## Rekommenderad deployordning

```bash
cd /Users/hekmath/Desktop/Projects/kundexa

npm ci
npx supabase@2.109.1 link --project-ref <KUNDEXA_PROJECT_REF>
npm run db:push
npm run types:generate
npm run types:verify
npm run verify
```

Deploya därefter applikationen till Vercel.

## Efter deploy

1. Kontrollera att `RINKEL_API_KEY` finns i Vercels Production-miljö och att `RINKEL_API_BASE_URL` är `https://api.rinkel.com/v1`.
2. Kör **Testa API** och därefter **Synkronisera katalog** i plattformsadministrationen.
3. Kontrollera att aktuell telefoni-användare har minst en aktiv enhet och att numret är aktivt i katalogen.
4. Tilldela numret till berörda bolag och team.
5. Öppna tenantens integrationssida och spara om varje säljares mappning: Kundexa-användare, telefoni-användare, enhet och standardnummer.
6. Öppna dialern. Ett tillgängligt utgående nummer ska vara valt även när bara ett nummer finns.
7. Genomför ett verkligt testsamtal.

Vid fel: kopiera `Referens: <uuid>` från säljarvyn och sök efter samma `correlationId` i Vercels serverlogg. Händelsen loggas som `rinkel_call_reservation_failed`, `dial_start_failed` eller `dial_failure_finalization_failed` utan att exponera hemligheter.

## Säkerhetsåtgärd

Den uppladdade `.env.example` innehöll en service-role-liknande Supabase-nyckel. Exempelfilen är sanerad i leveransen, men den nyckeln bör roteras i Supabase och därefter uppdateras i Vercel. En service role-nyckel ska aldrig ligga i Git eller skickas till webbläsaren.

## Verifiering i leveransmiljön

- 44 migrationer passerar projektets statiska schema- och invariantkontroller.
- Supabase type-contract-verifieringen passerar.
- Syntax/transpilering passerar för samtliga ändrade TypeScript- och TSX-filer.
- Mockad kataloghämtning och exakt ett `POST /dial` med API-header, enhet, mål och nummer passerar.
- SQL-runtime-testet är utökat för atomisk nummergrant och avvisning av en enhet från fel telefoni-användare.

Full `npm ci`, Next.js-build och PGlite-körning kunde inte slutföras i den isolerade leveransmiljön eftersom dess interna npm-register returnerade 404 för `pdf-lib@1.17.1`. Ett verkligt provideranrop kunde inte köras utan Kundexas produktionsnyckel och liveprojekt.
