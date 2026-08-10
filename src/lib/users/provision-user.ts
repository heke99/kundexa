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

  // Recovery only for an account that Kundexa itself provisioned and that has never
  // signed in. A normal existing user must keep both password and security state.
  if (!securityState && user.user_metadata?.provisioned_by_kundexa === true && !user.last_sign_in_at) {
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
 * Existing Auth users are reused and their password is never mutated by this flow.
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
    // Re-read instead of retrying createUser or changing that account's password.
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
