# Authentication and RBAC

- Webbsessioner verifieras med Supabase Auth `getUser`.
- Aktiv tenant kräver aktivt medlemskap; team och plattformsroll byggs in i appkontexten.
- API-nycklar lagras hashade, visas endast vid skapande och har explicita scopes.
- Kanoniska API-scopes definieras i `src/lib/permissions.ts`; kataloguppdatering använder `directory:refresh`.
- Tenantroller omfattar bland annat `owner`, `admin`, `team_lead`, `backoffice` och `seller`.
- Plattformsroller hålls separata från tenantroller.
- Privilegierade UI-actions ska använda autentiserad klient och RPC:er som härleder aktiv tenant.
- Server/service-RPC:er ska kräva service-role och explicit validera tenant/resource-samband.

MFA-enforcement och administrativ recoveryprocess är produktionsblockerare.
