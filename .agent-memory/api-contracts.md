# API contracts

Versionerat REST-API ligger under `src/app/api/v1`.

Kanoniska regler:

- Session eller API-nyckel autentiseras i serverlagret.
- API-nyckelscopes kommer från `src/lib/permissions.ts`; introducera inte lokala strängvarianter i routes.
- `directory:read`, `directory:refresh`, `segments:read` och `segments:write` är separata rättigheter.
- Validering sker med Zod och affärsmutationer via atomisk RPC när flera tabeller berörs.
- Sessionklient används när RLS ska skydda anropet. Admin/service-klient får bara användas efter separat verifierad tenantkontext.
- Providercallbacks identifierar tenant från signerad/tokeniserad serverkontext, inte från fritt requestfält.
- API-fel får inte läcka service-nycklar, krypterad payload eller data från annan tenant.

Öppen punkt: publicerad OpenAPI-kontraktstestning är `UNVERIFIED`.
