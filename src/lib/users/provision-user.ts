import type { User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { findAuthUserByEmail } from "@/lib/supabase/auth-admin-users";
import { passwordSchema } from "@/lib/security/password-policy";

export type ProvisionUserInput = {
  email: string;
  firstName: string;
  lastName: string;
  temporaryPassword?: string;
  invitationId: string;
  provisionedBy: string;
};

export type ProvisionUserResult = {
  user: User;
  /**
   * True means this provisioning attempt issued a fresh temporary credential that
   * must be communicated to the user. This is also true when Kundexa safely
   * recovers its own never-signed-in Auth identity and rotates the stale temporary
   * credential; the underlying Auth row may already have existed in that case.
   */
  created: boolean;
};

function normalizeName(firstName: string, lastName: string) {
  return [firstName.trim(), lastName.trim()].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

async function stageAuthProvisioning(invitationId: string, userId: string, created: boolean) {
  const admin = createAdminClient();
  const { error } = await admin.rpc("mark_tenant_invitation_auth_provisioned", {
    p_invitation_id: invitationId,
    p_user_id: userId,
    p_auth_user_was_created: created,
  });
  if (error) throw error;
}

async function reuseExistingUser(user: User, input: ProvisionUserInput): Promise<ProvisionUserResult> {
  const admin = createAdminClient();
  const { data: securityRows, error: stateReadError } = await admin.rpc("get_user_security_state_for_provisioning", {
    p_user_id: user.id,
  });
  if (stateReadError) throw stateReadError;
  const securityState = Array.isArray(securityRows) ? securityRows[0] : securityRows;

  const kundexaProvisioned = user.user_metadata?.provisioned_by_kundexa === true;
  const neverSignedIn = !user.last_sign_in_at;
  const passwordNeverChanged = !securityState?.password_changed_at;
  const recoverablePendingIdentity = kundexaProvisioned && neverSignedIn && passwordNeverChanged;

  // A previous provisioning attempt can have created the Auth identity successfully
  // but failed later in the invitation/security workflow. On retry the administrator
  // enters a new temporary password. That password must actually replace the stale
  // credential; otherwise the UI reports success while signInWithPassword rejects it.
  // This recovery is deliberately limited to Kundexa-owned identities that have never
  // signed in and have never completed the mandatory password-change gate.
  if (recoverablePendingIdentity) {
    const password = passwordSchema.parse(input.temporaryPassword ?? "");
    const fullName = normalizeName(input.firstName, input.lastName);
    const { data: updated, error: passwordResetError } = await admin.auth.admin.updateUserById(user.id, {
      password,
      email_confirm: true,
      user_metadata: {
        ...user.user_metadata,
        full_name: fullName,
        provisioned_by_kundexa: true,
      },
    });
    if (passwordResetError || !updated.user) throw passwordResetError ?? new Error("auth_user_recovery_failed");

    const { error: recoverError } = await admin.rpc("provision_user_security_state", {
      p_user_id: user.id,
      p_provisioned_by: input.provisionedBy,
    });
    if (recoverError) throw recoverError;

    // The Auth row was reused rather than created, so keep the database audit fact
    // accurate even though callers should treat this as a newly issued temp credential.
    await stageAuthProvisioning(input.invitationId, user.id, false);
    return { user: updated.user, created: true };
  }

  // Recovery only for an account that Kundexa itself provisioned and that has never
  // signed in. A normal existing user must keep both password and security state.
  if (!securityState && kundexaProvisioned && neverSignedIn) {
    const { error: recoverError } = await admin.rpc("provision_user_security_state", {
      p_user_id: user.id,
      p_provisioned_by: input.provisionedBy,
    });
    if (recoverError) throw recoverError;
  }

  await stageAuthProvisioning(input.invitationId, user.id, false);
  return { user, created: false };
}

/**
 * Canonical server-only Auth provisioning.
 *
 * Supabase Auth owns identity and credentials. Tenant role/team authorization stays in
 * tenant_memberships/team_members and is never trusted from user-editable Auth metadata.
 * Existing active Auth users are reused and their password is never mutated by this flow.
 */
export async function provisionUser(input: ProvisionUserInput): Promise<ProvisionUserResult> {
  const email = input.email.trim().toLowerCase();
  const fullName = normalizeName(input.firstName, input.lastName);
  if (!email || !fullName) throw new Error("provision_user_identity_required");

  const existing = await findAuthUserByEmail(email);
  if (existing) return reuseExistingUser(existing, input);

  const password = passwordSchema.parse(input.temporaryPassword ?? "");
  const admin = createAdminClient();
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: fullName,
      provisioned_by_kundexa: true,
    },
  });
  if (created.error || !created.data.user) {
    // A concurrent request may have created the same Auth identity after our first lookup.
    // Re-read instead of retrying createUser or changing an active account's password.
    const concurrentUser = await findAuthUserByEmail(email);
    if (concurrentUser) return reuseExistingUser(concurrentUser, input);
    throw created.error ?? new Error("auth_user_create_failed");
  }

  const user = created.data.user;
  const { error: securityError } = await admin.rpc("provision_user_security_state", {
    p_user_id: user.id,
    p_provisioned_by: input.provisionedBy,
  });
  if (securityError) {
    // Keep the Auth identity for deterministic retry/recovery. Aggressive deletion could
    // race another provisioning attempt and can destroy a valid shared Auth identity.
    throw new Error(`security_state_provisioning_failed:${securityError.code ?? "unknown"}`);
  }

  await stageAuthProvisioning(input.invitationId, user.id, true);
  return { user, created: true };
}
