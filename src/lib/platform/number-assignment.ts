import "server-only";
import { getPlatformContext, isPlatformAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Nummer och team för alla företag, till plattformens "Ge ett nummer till ett team".
 *
 * Plattformskontexten har ingen tenant och RLS på `teams` och `phone_numbers`
 * släpper bara in företagets egna medlemmar. Läsningen går därför med
 * tjänstenyckeln, och rollen prövas här och inte bara på sidan som anropar.
 */
export async function platformNumberAssignmentChoices() {
  const context = await getPlatformContext();
  if (!isPlatformAdmin(context.platformRole)) return null;
  const service = createAdminClient();
  const [{ data: numbers }, { data: teams }] = await Promise.all([
    service.from("phone_numbers").select("id,tenant_id,number_e164").eq("status", "active").eq("supports_voice", true).order("number_e164"),
    service.from("teams").select("id,tenant_id,name").eq("status", "active").order("name"),
  ]);
  return { numbers: numbers ?? [], teams: teams ?? [] };
}
