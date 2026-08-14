# Central Rinkel-miljö

Samma logiska `RINKEL_API_KEY` ska sättas i Vercel och Supabase Edge Secrets när båda runtime-miljöerna gör provideranrop. Skapa inte olika nycklar per tenant eller funktion.

```dotenv
RINKEL_API_KEY=<CENTRAL_RINKEL_API_KEY>
RINKEL_API_BASE_URL=https://api.rinkel.com/v1
RINKEL_WEBHOOK_PUBLIC_BASE_URL=https://kundexa.se
RINKEL_WEBHOOK_SECRET=<MINST_40_SLUMPMASSIGA_TECKEN>
RINKEL_WEBHOOK_ALLOWED_IPS=82.199.77.220,188.122.73.177
RINKEL_REQUEST_TIMEOUT_MS=15000
RINKEL_ENFORCE_WEBHOOK_IP_ALLOWLIST=true
RINKEL_RECONCILIATION_ENABLED=true
CRON_SECRET=<LANG_SLUMPMASSIG_HEMLIGHET>
```

Krävs fortsatt:

```dotenv
NEXT_PUBLIC_APP_URL=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
KUNDEXA_ENCRYPTION_KEY=
KUNDEXA_WEBHOOK_PEPPER=
```

`RINKEL_API_KEY` och `RINKEL_WEBHOOK_SECRET` får inte ha prefixet `NEXT_PUBLIC_`, sparas per tenant, loggas eller visas i UI. Webhooksecret ska vara separat från API-nyckeln.


`RINKEL_WEBHOOK_ALLOWED_IPS` är den servervaliderade bootstrap-listan. Databasens providerallowlist kan komplettera den, men kan inte ersätta kravet på en betrodd proxyheader. I Vercel används endast `x-vercel-forwarded-for`; utanför Vercel måste `RINKEL_TRUST_X_REAL_IP=true` vara ett medvetet infrastrukturbeslut.
