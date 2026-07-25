# Domain model

## Tenant och åtkomst

`tenants`, profiler/medlemskap, roller, team, API-nycklar och plattformsroller skapar den aktiva åtkomstkontexten.

## Katalog och ingestion

`master_entities` är normaliserad central katalog. Råpayload och `source_facts` ligger före resolverns fältvärden, historik, provenance och konflikter. Providerpermission skiljer `may_store`, `may_filter` och `may_display`.

## CRM och bearbetningslistor

- `customers` är enda kanoniska kund-/prospektkortet.
- `customer_lists` och `customer_list_members` är det operativa list-/kölagret.
- `platform_lists`, allokeringar och allokeringsposter är plattformens supply-/revisionsspår, inte ett andra CRM.
- `tenant_entities` kopplar central katalog till tenant.

## Dialer och efterarbete

`dialer_sessions` äger tillfälliga claims. `calls` är kanoniskt samtal, `activities` återkomster, `notes` anteckningar och `sales_orders`/`sales_order_items` order. Efterarbete är atomiskt och krävs innan automatiskt nästa samtal.

## Kampanjer, kommunikation och avtal

Segment materialiseras till snapshots/memberships och kan föras till kampanj/lista. Central kontaktpolicy, NIX och usage reservation körs innan köläggning. Meddelanden och dokument går via outbox. Godkända avtalsversioner snapshotas och signerade/låsta artefakter är immutabla.
