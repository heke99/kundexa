# Selected DocuSeal code ported into Kundexa

Upstream: https://github.com/docusealco/docuseal

Pinned source: `3c65b0e4ba872fe71d5566c0d09c3ace59a7fb8a`.

Only the selected document/signature features are ported into Kundexa. The Rails application, its authentication, database, administrative UI, job system and external API are not installed. Kundexa owns the customer, permission model, immutable PDF snapshot, public signing session, signature receipt, final document, audit and delivery.

The TypeScript ports identify their original source files and adaptations in their headers. Upstream's `LICENSE` and `LICENSE_ADDITIONAL_TERMS` are preserved here. The user has stated separate authorization to reuse the project; this file records source provenance and does not replace that agreement.

The port implements a drawn electronic signature with explicit consent and document/audit binding. It does not establish BankID identity or claim a qualified/advanced electronic signature or certificate-backed PDF signature.

## Portade koddelar i native signering

- `src/lib/signing/ported/docuseal-signature.ts` innehåller den faktiska algoritmen från upstream `app/javascript/submission_form/validate_signature.js` och `crop_canvas.js`: punktavvikelsekontroll, canvasprov och alfagränser/crop till PNG. Ändringar är TypeScript-typer och explicita fel vid saknad canvas-context eller tom bild.
- `src/lib/signing/ported/docuseal-geometry.ts` portar den faktiska skalnings- och centreringsformeln från `lib/submissions/generate_result_attachments.rb:490–515` från Ruby/HexaPDF till TypeScript/pdf-lib. Samma normaliserade områden, proportioner och invertering av PDF:s y-axel används.
- `signature_step.vue` inventerades för dess `signature_pad`, `validate_signature` och `crop_canvas`-flöde. Vue-komponenten har inte kopierats; Kundexas React-vy återanvänder de portade hjälparna och exakt `signature_pad@4.1.5`, låst i upstream `yarn.lock` för `^4.1.5`.
- Auditgenerationen i `lib/submissions/generate_audit_trail.rb` inventerades, men dess Ruby/rendering är inte portad. Kundexas audit-PDF är egen kod från det låsta lokala signeringskvittot och utger sig inte för att vara en originalaudit från en extern DocuSeal-installation.

Native-motorn bäddar in underskriftsbilden i de låsta PDF-fälten och skapar ett separat kvitto med källdokumentets och bildens SHA-256. Den gör inga PKI-, BankID- eller högre identitetsanspråk. Ursprunglig DocuSeal-attribution behålls i den interaktiva signeringsvyn och PDF-kvittot. Samtliga ursprungskällor avser pinnen ovan.
