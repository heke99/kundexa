# Kundexa – plattformslistor, tenants, team och säljare

Datum: 2026-07-22

## Levererad målbild

Den här leveransen bygger vidare på Kundexas befintliga multi-tenant-, ringliste- och dialermodell. Den skapar inte ett parallellt listsystem. En central plattformslista materialiseras i den mottagande tenantens befintliga `customers`, `contact_people`, `customer_lists` och `customer_list_members`, så dialer, aktiviteter, callbacks, affärer och statistik fortsätter använda samma kanoniska flöde.

## Huvudflöde

1. Plattformens ägare eller administratör skapar och importerar en central lista.
2. Importen normaliserar och deduplicerar poster samt sparar källhashar och importresultat.
3. Plattformen väljer en aktiv tenant, antal poster, filter och exklusivitetsregler.
4. Databasen låser urvalet och skapar en auditerad tenanttilldelning i en transaktion.
5. Poster materialiseras som tenantägda kunder, kontakter och listmedlemmar.
6. Tenantägare eller tenantadmin delar tenantlistan till ett team.
7. Teamledaren hanterar teamets säljare och använder befintlig listfördelning för att tilldela säljare.
8. Dialern kontrollerar tenant, team, listbehörighet, pausstatus och daglig leadgräns innan ett lead kan hämtas.
9. Tidsbegränsade eller återkallade tilldelningar tar bara tillbaka obearbetade poster. Bearbetad historik bevaras i tenantens CRM.
10. Alla kritiska steg skrivs till tenantens eller plattformens revisionslogg.

## Roller

### Plattformägare och plattformsadmin

- skapar tenants;
- bjuder in den första tenantägaren;
- importerar centrala listor från CSV, JSON, NDJSON och XLSX;
- tilldelar hela eller filtrerade delar av listor till tenants;
- väljer exklusiv, delad eller tidsbegränsad rätt;
- återkallar aktiva tilldelningar;
- ser centrala listantal och tilldelningsstatus.

### Tenantägare och tenantadmin

- skapar team;
- bjuder in användare och väljer roller/team;
- utser teamledare;
- delar tenantlistor vidare till team;
- hanterar teammedlemmar, primärt team, paus och daglig leadgräns;
- använder befintlig säljarfördelning på teamlistor.

### Teamledare

- kan skapa team när tenantinställningen tillåter det;
- kan bjuda in säljare till team där personen är manager och inbjudningar är aktiverade;
- kan lägga till, pausa, begränsa och ta bort säljare i egna team;
- kan inte bjuda in högre roller eller administrera andra team;
- kan fördela teamets listor till säljare genom Kundexas befintliga listflöde.

### Säljare

- ser endast listor som är öppna för eller tilldelade till säljaren och dennes team;
- kan inte hämta nya leads när teamtilldelningen är pausad eller den dagliga gränsen är nådd;
- använder samma atomiska claim-, samtals-, disposition- och callbackflöde som tidigare.

## Databasändringar

Migration:

`supabase/migrations/202607220001_platform_list_distribution_and_team_admin.sql`

Nya centrala tabeller:

- `tenant_invitations`
- `platform_lists`
- `platform_list_entries`
- `platform_list_allocations`
- `platform_list_allocation_entries`

Utökade befintliga tabeller:

- `teams`
- `team_members`
- `tenant_memberships`
- `customer_lists`
- `customer_list_members`

Viktiga RPC-funktioner:

- `create_platform_tenant`
- `register_tenant_invitation`
- `activate_current_user_invitation`
- `list_current_user_tenants`
- `switch_active_tenant`
- `create_managed_team`
- `update_managed_team`
- `update_tenant_member`
- `set_managed_team_member`
- `remove_managed_team_member`
- `allocate_platform_list_to_tenant`
- `split_customer_list_to_team`
- `revoke_platform_list_allocation`
- `release_expired_platform_allocations`

## Säkerhet och tenantisolering

- Kritiska mutationer går genom `security definer`-RPC:er med explicita roll-, tenant- och teamkontroller.
- Direkta skrivpolicys för tenantmedlemskap, team och teammedlemmar tas bort; skrivningar går genom auditerade funktioner.
- Äldre överlappande läspolicys för teamledare ersätts av en enda tenant- och teamskopad medlems- och profilpolicy.
- Centrala listtabeller har tvingad RLS och är endast synliga för behöriga plattformsroller.
- En tenanttilldelning kan endast materialiseras till en aktiv tenant.
- En användare kan bara växla till en aktiv tenant där användaren har ett aktivt medlemskap.
- Teamledare kan endast administrera säljare i team där de är manager.
- Klienten bestämmer aldrig tenantåtkomst utan server- och databaskontroll.
- Tilldelning och claim använder databaslåsning för att motverka dubbel tilldelning.

## Inbjudningsflöde

Auth-callbacken kör `activate_current_user_invitation` direkt efter Supabase code exchange. Lösenordsinloggningen kör samma aktivering, vilket gör att även en redan registrerad användare kan acceptera en ny tenantinbjudan vid nästa inloggning. Det innebär att användaren aktiveras i rätt tenant innan onboarding kan skapa en separat organisation. En befintlig användare kan ha aktiva medlemskap i flera tenants och byta aktiv tenant i toppfältet.

## Centrala listor och återtagning

En central post har en separat distributionsrelation. Plattformens huvudpost, tenantens CRM-kund och listmedlemskapet är inte samma objekt.

Vid återkallning eller utgång:

- obearbetade listmedlemmar tas bort från aktiva arbetsköer;
- bearbetade eller claimade poster markeras som konverterade och historiken behålls;
- berörda tenant- och teamlistor pausas;
- en central post blir åter tillgänglig endast när ingen aktiv eller konverterad rätt blockerar den.

## Gränssnitt

- `/app/platform` – tenants, första ägarinbjudan och plattformsöversikt.
- `/app/platform/lists` – central listimport, filter, tenanttilldelning och återkallning.
- `/app/users` – inbjudningar, roller och teamkopplingar.
- `/app/teams` – team, teamledare, medlemmar, paus och dagliga leadgränser.
- `/app/lists/[id]` – dela en tenantlista vidare till team och använda befintlig säljarfördelning.
- Toppfältet – säker växling mellan användarens aktiva tenants.

## Underhåll

`supabase/functions/maintenance-worker/index.ts` kör även `release_expired_platform_allocations`. Funktionen tar atomiskt hand om tidsbegränsade tilldelningar som passerat slutdatum.

## Driftsättning

Kör från projektroten:

```bash
npm ci
npm run typecheck
npm run typecheck:edge
npm run test
npm run db:push
npm run types:generate
npm run functions:deploy
npm run build
```

På Vercel ska projektet använda Node `22.x`, samma version som är låst i `package.json`.

## Produktionskontroll efter migration

1. Skapa en testtenant som plattformsägare.
2. Acceptera ägarinbjudan och kontrollera att rätt tenant aktiveras.
3. Skapa ett team och bjud in en teamledare och säljare.
4. Importera en liten central lista med unika orgnummer och telefonnummer.
5. Tilldela ett urval till testtenanten.
6. Dela tenantlistan till teamet.
7. Tilldela poster till säljaren och verifiera dialerclaim.
8. Pausa säljaren och verifiera att nya claims stoppas.
9. Återkalla tilldelningen och verifiera att obearbetade poster tas tillbaka men bearbetad historik finns kvar.
10. Försök läsa och ändra data från en annan tenant och verifiera att RLS nekar åtkomst.
