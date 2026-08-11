import type { User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

export async function sendSupabaseAuthInvite(input: {
  email: string;
  fullName: string;
}): Promise<User> {
  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.inviteUserByEmail(input.email, {
    data: {
      full_name: input.fullName,
      provisioned_by_kundexa: true,
    },
  });
  if (error || !data.user) throw error ?? new Error("auth_user_invite_failed");
  return data.user;
}
