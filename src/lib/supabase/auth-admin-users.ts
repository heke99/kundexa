import type { User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

const PAGE_SIZE = 1000;

/**
 * Resolves an Auth user without silently truncating the directory at an arbitrary page count.
 * The repeated-page guard fails closed if the upstream pagination contract ever regresses.
 */
export async function findAuthUserByEmail(email: string): Promise<User | null> {
  const admin = createAdminClient();
  const normalizedEmail = email.trim().toLowerCase();
  let page = 1;
  let previousPageFingerprint: string | null = null;

  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
    if (error) throw error;

    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === normalizedEmail);
    if (user) return user;
    if (data.users.length < PAGE_SIZE) return null;

    const first = data.users[0]?.id ?? "";
    const last = data.users[data.users.length - 1]?.id ?? "";
    const fingerprint = `${first}:${last}:${data.users.length}`;
    if (fingerprint === previousPageFingerprint) throw new Error("auth_user_pagination_stalled");
    previousPageFingerprint = fingerprint;
    page += 1;
  }
}

export async function authUserEmailsById(userIds: string[]) {
  const admin = createAdminClient();
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  const rows = await Promise.all(uniqueIds.map(async (userId) => {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error) return [userId, userId] as const;
    return [userId, data.user.email ?? userId] as const;
  }));
  return new Map<string, string>(rows);
}
