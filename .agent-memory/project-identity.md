# Project identity

- Produkt: Kundexa
- Typ: multi-tenant SaaS CRM, prospekteringsplattform och sekventiell dialer
- Primär marknad/språk: Sverige, svensk UI och compliance
- Webb: Next.js 16 / React 19 / TypeScript
- Backend: Supabase Auth, PostgreSQL/RLS, Storage, Realtime och Edge Functions
- Telefoni: en central Rinkel-plattformsintegration och en server-side API-nyckel; resurser allokeras historiserat till isolerade tenants
- SMS: 46elks via outbox/provideradapter
- E-post: Resend via outbox/provideradapter
- Pakethanterare: npm 10.9.2
- Avsedd runtime: Node 22.x

Källan är ett levererat zip-arkiv utan git-historik. Branch, remote och commit är därför `UNVERIFIED`.
