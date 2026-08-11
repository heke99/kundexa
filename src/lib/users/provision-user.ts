import type { User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { findAuthUserByEmail } from "@/lib/supabase/auth-admin-users";
import { sendSupabaseAuthInvite } from "@/lib/users/supabase-auth-invite";

export type ProvisionUserInput = {
  email: string;
  firstName: string;
  lastName: string;
  invitationId: string;
  provisionedBy: string;
};

export type ProvisionUserResult = {
  user: User;
  invited: boolean;
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

/**
 * Canonical server-only Auth provisioning.
 *
 * Supabase Auth owns invitation delivery and credential setup. Kundexa owns tenant,
 * role and team authorization in tenant_memberships/team_members.
 *
 * Existing Auth users are reused and never have credentials changed by this flow.
 * The legacy implementation used admin.auth.admin.createUser; new identities are now
 * created by Supabase's invitation flow so Auth also owns the outbound email/template.
 */
export async function provisionUser(input: ProvisionUserInput): Promise<ProvisionUserResult> {
  const email = input.email.trim().toLowerCase();
  const fullName = normalizeName(input.firstName, input.lastName);
  if (!email || !fullName) throw new Error("provision_user_identity_required");

  const existing = await findAuthUserByEmail(email);
  if (existing) {
    await stageAuthProvisioning(input.invitationId, existing.id, false);
    return { user: existing, invited: false };
  }

  let user: User;
  try {
    user = await sendSupabaseAuthInvite({ email, fullName });
  } catch (error) {
    // A concurrent request may have created the same Auth identity after our first lookup.
    // Re-read and reuse it rather than sending another invitation or mutating credentials.
    const concurrentUser = await findAuthUserByEmail(email);
    if (!concurrentUser) throw error;
    await stageAuthProvisioning(input.invitationId, concurrentUser.id, false);
    return { user: concurrentUser, invited: false };
  }

  const admin = createAdminClient();
  const { error: securityError } = await admin.rpc("provision_user_security_state", {
    p_user_id: user.id,
    p_provisioned_by: input.provisionedBy,
  });
  if (securityError) throw new Error(`security_state_provisioning_failed:${securityError.code ?? "unknown"}`);

  await stageAuthProvisioning(input.invitationId, user.id, true);
  return { user, invited: true };
}
