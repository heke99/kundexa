# Kundexa agent instructions

Läs `.agent-memory/README.md`, `.agent-memory/current-state.md`, `.agent-memory/open-blockers.md` och `.agent-memory/next-actions.md` innan du ändrar projektet.

## Kanoniska regler

- Behandla källkod, migrationer och körd verifiering som primär evidens.
- Gissa inte produktionsstatus, credentials, tenantkontext, providerformat, branch eller commit.
- Ändra aldrig redan levererade migrationer; lägg till en ny migration.
- Alla tenantägda dataflöden måste ha verifierad tenantkontext, RLS och negativa tvåtenanttest.
- `SECURITY DEFINER` ska ha explicit `search_path` och minsta möjliga `EXECUTE`.
- Autentiserade flöden härleder tenant från aktivt medlemskap. Explicita tenantparametrar är service-only och måste korsvalideras mot resurserna.
- `customers` är kanoniskt CRM-kort; `customer_list_members` är arbetskö, inte en kundkopia.
- Providerarbete går genom adapters, atomiska RPC:er och transactional outbox.
- Bevara idempotens, audit, lineage, NIX/contact-policy och dokumentimmutabilitet.
- Handredigera inte genererade Supabase-typer; regenerera dem från länkat projekt.

## Obligatorisk verifiering

Kör vid relevanta ändringar:

```bash
npm run typecheck
npm run typecheck:edge
npm run test
npm run build
```

Före leverans körs `npm run verify`. Avsedd runtime är Node 22.x/npm 10.9.2. Live DB-, RLS-, Storage- eller providertest ska redovisas som `NOT RUN` om rätt miljö saknas.

## Minnesdisciplin

Efter varje pass:

- uppdatera `.agent-memory/current-state.md`;
- registrera blockerare i `open-blockers.md`;
- registrera beslut i `decisions.md` och fel i `known-failures.md`;
- uppdatera `verification-matrix.md`, `completed-work.md`, `next-actions.md` och `session-log.md`.
