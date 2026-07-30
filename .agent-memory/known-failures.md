# Known failures

## FAILURE-0001 — Composite FK nollade tenant_id

- Upptäckt: `split_customer_list_to_team` misslyckades med SQLSTATE 23502 när källmedlem raderades.
- Orsak: sammansatt FK använde generell `ON DELETE SET NULL`, vilket försökte nolla obligatorisk `tenant_id`.
- Fix: `202607250001_platform_allocation_reference_hardening.sql` använder kolumnspecifik SET NULL och relänkar allokeringsspår före delete.
- Regressionstest: teamfördelning och återkallning i `scripts/verify-sql.mjs`.
- Status: `RESOLVED`.

## FAILURE-0002 — Tenantparametrerade katalog-RPC:er var körbara av authenticated

- Risk: direkt anrop till `SECURITY DEFINER` kunde substituera annan tenants ID eller resurser.
- Fix: `202607250002_directory_tenant_boundary_hardening.sql` gör explicita tenantprojektioner service-only och skapar guarded wrappers.
- Regressionstest: privilege checks och negativa tvåtenanttest för segment/kampanj.
- Status: `RESOLVED`.

## FAILURE-0003 — Ogiltigt API-scope för discovery

- Orsak: routen krävde `enrichment:write`, som saknas i den kanoniska scope-modellen.
- Fix: routen kräver `directory:refresh`; statisk regressionkontroll tillagd.
- Status: `RESOLVED`.

## FAILURE-0004 — Leveransmiljön avviker från runtime

- Miljö: Node 24.14.0/npm 11.9.0; projektet kräver Node 22.x/npm 10.9.2.
- Effekt: engine-varning. Komplett verifiering kan köras men måste upprepas i kanonisk runtime.
- Status: `OPEN ENVIRONMENT LIMITATION`.

## FAILURE-0005 — Rinkel-reservation saknade obligatorisk callbackhash

- Upptäckt: exekverat SQL-runtimeprov mot hela migrationskedjan.
- Orsak: kanoniska `calls.callback_token_hash` är obligatorisk men fylldes inte av den nya reservationen.
- Fix: deterministisk hash av idempotency-nyckeln lagras vid samma atomiska reservation.
- Regressionstest: Rinkel-flödet i `scripts/verify-sql.mjs`.
- Status: `RESOLVED`.

## FAILURE-0006 — Providerartefakter hade tenantbred läsning

- Upptäckt: slutlig RLS-/privilegegranskning.
- Risk: generiska tenantpolicies var bredare än kanonisk samtals-, team- och användaråtkomst; rå providerdata kunde följa tabellprivilegiet.
- Fix: precisa roll-/team-/samtalspolicies, borttagen klientskrivning av samtalsförsök samt kolumnspecifika grants utan `raw_provider_data`.
- Regressionstest: SQL-exekvering och statiska invarianter i `scripts/verify.mjs`.
- Status: `RESOLVED`.
