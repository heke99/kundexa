# Implementerad omfattning

## Körbart i leveransen

- Responsiv Next.js-webbapp; ingen mobilapp
- Register/login/onboarding och första tenant
- Roller, användarinbjudningar och team
- CRM-kunder, företag, prospekt, kundkort, anteckningar, aktiviteter och historik
- CSV-import: preview, normalisering, felrader, dedupe, spärrkontroll, commit och mjuk rollback
- List-, kampanj-, pipeline-, produkt- och prisdatamodeller med användbara webbmoduler
- Dialergränssnitt, WebRTC-klient, calls/outbox och 46elks callbacks
- SMS- och e-postregister samt utskickskö
- Avtal, versionslåsning, PDF-upload, kanalutskick, accept och aktivering
- SMS-/webbaccept med exakt matchning och B2C-telefonkontroll
- Evidence manifest, accepterad PDF, evidence PDF och bekräftelsemeddelande
- Automationsregler, testläge, aktivering, databas-events, worker, retry och dead letter
- Rapporter och dashboard från riktig tenantdata
- API-nycklar, scopes, rate limits och OpenAPI
- Signerade utgående webhooks och leveranslogg
- Audit, security events, compliance blocks och usage limits
- Supabase RLS, Storage och Edge Functions

## Modellerat men kräver extern anslutning eller fortsatt produktarbete

- Merinfo/annan kommersiell dataleverantör: adapter- och provenance-modell finns, men ingen credential eller leverantörsspecifik klient ingår.
- Bolagsverket/SCB/Nominatim: adapterplats och datakällesmodul finns, men liveintegrationer måste implementeras mot valda avtal och användningsgränser.
- BankID och avancerad e-signering: statusmodell och providergränssnitt finns; konkret BankID/Documenso/DocuSeal-integration ingår inte.
- Prediktiv dialer, supervisor-medlyssning och coachning: datamodell/menyer finns delvis, men kräver särskild telefonimotor, juridisk kontroll och realtidsmedia.
- Excel, SFTP och schemalagda importer: databasen stödjer importkörningar; leveransen genomför CSV i webbappen.
- Full drag-and-drop PDF-fälteditor: PDF kan lagras och kopplas; visuell signaturfältseditor kräver vald signeringsmotor.
- Extern kalender-/mailboxsynk: aktivitets- och kalendermodul finns, OAuth-integration är inte kopplad.
- Fakturering: usage- och limitmodell finns; betalprovider och kommersiella planer måste kopplas.

Detta dokument är avsiktligt strikt: systemet ska inte beskrivas som externt produktionsfärdigt innan punkterna i `PRODUCTION_GATES.md` är godkända.
