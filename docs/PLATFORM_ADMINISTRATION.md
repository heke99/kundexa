# Plattformsadministration och säker onboarding

## Separata roller

Tenantroller (`owner`, `admin`, `sales` och övriga) gäller endast inom en tenant. Plattformsroller gäller hela Kundexa och lagras separat i `platform_memberships`:

- `platform_owner` – kan ändra plattformsroller och tenantstatus.
- `platform_admin` – kan administrera tenantstatus och se plattformsdrift.
- `platform_support` – läsbehörig plattformsöversikt för support.
- `platform_auditor` – läsbehörig revisionsöversikt.

Plattformsportalen finns på `/app/platform` och visas endast för användare med en aktiv plattformsroll. Alla roll- och statusändringar går genom revisionsloggade RPC-funktioner. Den sista aktiva plattformsägaren kan inte tas bort eller degraderas.

## Skapa första plattformsägaren

1. Registrera användaren i Kundexa och bekräfta e-postadressen.
2. Kör migrationerna.
3. Kör följande en gång i Supabase SQL Editor och byt e-postadressen:

```sql
with target_user as (
  select id
  from auth.users
  where lower(email)=lower('DIN-EPOST@EXEMPEL.SE')
  limit 1
), upserted as (
  insert into public.platform_memberships(user_id,role,status,created_by)
  select id,'platform_owner'::public.platform_role,'active',id
  from target_user
  on conflict(user_id) do update set
    role='platform_owner'::public.platform_role,
    status='active',
    updated_at=now()
  returning user_id
)
insert into public.platform_audit_logs(
  actor_user_id,action,entity_type,entity_id,reason,metadata
)
select
  user_id,
  'platform_owner.bootstrapped',
  'platform_membership',
  user_id::text,
  'Initial plattformsägare skapad via betrodd SQL Editor',
  jsonb_build_object('role','platform_owner')
from upserted;
```

Verifiera:

```sql
select u.email,pm.role,pm.status,pm.created_at
from public.platform_memberships pm
join auth.users u on u.id=pm.user_id;
```

Efter detta hanteras ytterligare plattformsroller i `/app/platform`.

## Idempotent onboarding

`create_tenant_with_owner` är serialiserad per användare och säker att köra igen efter dubbelklick, timeout eller nätverksretry. Ett andra anrop returnerar användarens redan aktiva tenant i stället för att skapa en ny.

Samtliga standardrader använder konfliktkontroll:

- medlemskap
- huvudteam och teammedlemskap
- tenantinställningar
- feature-flaggor
- juridiskt standardbolag
- kundstatusar
- standardpipeline och steg
- source-priority policies

`ensure_tenant_defaults(tenant_id)` kan köras av tenantadmin eller plattformsadmin för att reparera saknade standardrader utan att skriva över befintliga tenantval.

## Säker typgenerering

`npm run types:generate` använder `scripts/generate-supabase-types.mjs` och:

- läser project ref från `SUPABASE_PROJECT_REF` eller den länkade filen `supabase/.temp/project-ref`
- använder explicit project ref i stället för en tyst interaktiv länkning
- har timeout
- skriver först till temporär fil
- ersätter `database.types.ts` endast när resultatet är giltigt
- raderar en tom, avbruten outputfil

Kör:

```bash
npx supabase@2.109.1 login
npx supabase@2.109.1 link --project-ref DIN_PROJECT_REF
SUPABASE_PROJECT_REF=DIN_PROJECT_REF npm run types:generate
```
