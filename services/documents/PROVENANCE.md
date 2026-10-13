# Kundexa document engine

Ported source: docusealco/docuseal, commit `3c65b0e4ba872fe71d5566c0d09c3ace59a7fb8a`.
The local vendor archive contains the application, Vue PDF builder, PDF/signing libraries,
models, controllers, locked dependencies and original build files. Upstream specifications,
documentation and GitHub workflows are excluded. Original license/attribution files remain.

User states express permission for whole-project reuse. The overlay adds Kundexa's scoped
builder, immutable template snapshots and durable submission idempotency. No Pro activation
or DocuSeal Cloud dependency is introduced. This is our runtime inside this repository.

Run `sh services/documents/build.sh`, then supply `services/documents/.env` and run
`docker compose --env-file services/documents/.env -f services/documents/compose.yaml up -d`.
Put the service behind HTTPS; port 3100 binds to loopback. Configure the dedicated account
using `/app/bin/rails runner "Kundexa::Bootstrap.call"` inside the container, then set the web runtime's
`KUNDEXA_DOCUMENTS_URL`, `KUNDEXA_DOCUMENTS_API_KEY` and `KUNDEXA_DOCUMENTS_SECRET`.
The shared secret is for narrow builder sessions, not a browser-visible API key.
Back up both volumes and use a deployment-pinned database image digest before production.
See `docs/DOCUMENT_ENGINE_OPERATIONS.md` for exact steps and verification boundaries.
