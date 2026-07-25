# Security model

- RLS på tenantägda tabeller och aktiv tenant från verifierad identitet.
- Minsta möjliga `EXECUTE` för `SECURITY DEFINER`; explicit `search_path`.
- Hashade API-nycklar/callbacktokens, AES-GCM för tillåtna providercredentials/råpayloads.
- Privat Storage för importer, compliance-exporter, dokument och bevis.
- HTTPS, SSRF-skydd, redirect-/domän-/path-policy och signerade webhooks.
- Idempotens, atomiska claims, usage reservation och dead-letter/retry.
- Kontaktpolicy, kanalspärr, rättslig grund, ringtid och NIX precis före köläggning.
- Retention, legal hold, DSAR, audit och minimal suppression.
- Immutabla signerade/låsta dokument med SHA-256-bevis.

Kvar före produktion: extern SAST/DAST/pentest, tvåtenanttest i riktig Supabase, MFA, key rotation, SIEM/larm, backup/restore, malware-scanner och juridiskt godkännande.
