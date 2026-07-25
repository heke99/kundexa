# Decisions

## ADR-0001 — Ett kanoniskt CRM

`customers` är kund-/prospektkortet. Listmedlemskap, samtal, återkomster, anteckningar och order hålls i separata kanoniska tabeller; inga parallella kundkopior.

## ADR-0002 — Plattformens lista är supply/revisionsspår

`platform_lists` och allokeringar levererar data till tenantens operativa `customer_lists`. Allokeringsposten bevarar tenant och lineage även om operativ referens senare kopplas loss.

## ADR-0003 — RLS plus atomiska RPC:er

RLS är grundskydd. Flertabellsmutationer och concurrencykritiska flöden genomförs i serverkontrollerade, atomiska RPC:er.

## ADR-0004 — Kataloglicens är fältspecifik

Lagring, filtrering och visning är separata rättigheter. Ett filtrerbart fält behöver inte vara synligt.

## ADR-0005 — Tenantparametrerade definer-RPC:er är service-only

Autentiserade användarflöden härleder aktiv tenant. Serviceflöden använder `*_for_tenant` och validerar tenant mot varje resurs.

## ADR-0006 — Providerarbete går via adapters/outbox

46elks, Resend, ParseHub och NIX isoleras bakom adapters/workers. Domänmutation och köläggning sker atomiskt och idempotent.

## ADR-0007 — Node 22 är kanonisk runtime

`package.json` styr Node 22.x och npm 10.9.2. Verifiering under annan Node-version är informativ men ersätter inte CI/staging på Node 22.
