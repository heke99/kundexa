# Canonical flows

## Plattform till säljare

1. Plattform importerar central lista.
2. Lista allokeras till tenant med revisionsspår.
3. Tenant delar till team; teamledare fördelar till säljare.
4. Allokeringspost relänkas till operativ listmedlem.
5. Återkallning/utgång avaktiverar bearbetning utan att nolla tenantens revisionsspår.

## Ingestion till katalog

Permission/kvot → jobb/run → atomiskt claim → providerfetch → krypterad råpayload → parsing/avvikelsekontroll → normalisering/identity match → source facts/resolver → checkpoint/rapport.

## Segment till kampanj/lista

Sparat segment → tenantkontrollerad refresh → snapshot/memberships → kontakt-/NIX-policy → kampanj eller `customer_list` → pending/ready-köstatus.

## Dialer

Session → atomiskt claim med `SKIP LOCKED` → kontaktpolicy → providerkö → providerhangup → obligatoriskt efterarbete → atomiskt utfall/anteckning/återkomst/order/audit → nästa claim.

## Kommunikation och avtal

Domänmutation och outbox skapas i samma transaktion. Worker claimar idempotent, kallar provider, verifierar callback och uppdaterar kanonisk post. Avtalsmall, juridisk avsändare, produkt, pris och villkor snapshotas före signering.
