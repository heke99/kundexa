# 2026-08-10 — canonical tenant and user provisioning

This session replaced the competing tenant/user onboarding paths with one platform-driven provisioning model while preserving the hardened invitation/membership chain.

## Decisions

- Platform owner/admin is the canonical B2B tenant creator. Public signup is closed.
- Tenant base, defaults, Huvudteam, default legal entity and owner invitation reservation are created/resumed transactionally by `create_or_resume_platform_tenant_owner`.
- Supabase Auth owns credentials. Kundexa owns tenant membership, role, team and authorization.
- New Auth identities are provisioned with a temporary password but remain non-operational (`tenant_memberships.status = invited`) until the password has been changed successfully.
- After successful `auth.updateUser`, Kundexa clears the private first-login security state and only then activates the pending invitation/team assignment. This prevents direct PostgREST/RPC access before the mandatory credential change.
- Existing Auth identities are always reused and their password is never changed when they are added to another tenant.
- Primary team is explicit. UUID/array ordering is never used to select a user's primary team. Ambiguous legacy multi-team data fails closed.
- Sales requires a primary team. Active team leads require a primary manager team. Team leads can only provision sales into teams they manage.
- Owner/admin team creation no longer auto-adds the creator as manager; manager assignment is explicit. A team lead creating their own team is the only automatic manager case.
- Temporary passwords are never stored in Kundexa tables, metadata, audit events or notifications.
- The old externally callable tenant-creation RPCs are revoked from authenticated/public users and retained service-role only for compatibility.

## Verification state

Local checks passed before publishing the patch:

- `node scripts/remediation-regression-tests.mjs`
- `node scripts/verify.mjs`
- `node scripts/verify-openapi-coverage.mjs`
- `node scripts/contract-delivery-unit-tests.mjs`
- `npm run test:api`
- `git diff --check`
- TypeScript `transpileModule` syntax pass for all changed TS/TSX files

The local sandbox cannot perform a clean `npm ci` because its package mirror returns 404 for `pdf-lib@1.17.1`; therefore full dependency-backed verification is delegated to the repository GitHub Actions workflow. Live Kundexa Supabase staging/type regeneration and real-provider checks remain external gates and must not be claimed until a linked Kundexa project is available.
