import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { expectedWebhookUrl, isUsablePublicAppUrl, publicEnv, serverEnv } from "@/lib/env";
import { telephonyConfigured } from "@/lib/telephony/webphone";

export const dynamic = "force-dynamic";

type DeliveryChecks = {
  /** Arbetaren har rapporterat sin konfiguration minst en gång. */
  reported: boolean;
  smsProvider: string | null;
  platformSmsConfigured: boolean | null;
  platformEmailConfigured: boolean | null;
  /**
   * Bygger arbetaren sina avtalslänkar mot samma adress som webbappen?
   *
   * Första utskicket bygger länken i webbappen (`NEXT_PUBLIC_APP_URL`),
   * påminnelsen bygger den i utskicksarbetaren (`APP_URL`). Går de isär pekar
   * påminnelsen på en annan värd än avtalet, och en POST som möter en
   * omdirigering tappas tyst. Det är två variabler som måste vara samma sak, och
   * ingenting jämförde dem.
   */
  linkHostAligned: boolean | null;
  /**
   * IP-spärren framför SMS-webhookarna, och om den nuvarande leverantören alls
   * har några nät registrerade.
   *
   * `is_provider_ip_allowed` frågar per leverantör och nekar när inget nät
   * matchar. En spärr som slås på innan leverantörens nät är inlagda avvisar
   * därför varje leveransrapport och varje inkommande SMS med 403 -- inklusive
   * kundens "JA" på ett avtal. Det syns inte någonstans förrän någon läser en
   * loggrad, så det står här i stället.
   */
  smsIpAllowlistEnforced: boolean;
  smsIpAllowlistNetworks: number | null;
  reportedAt: string | null;
};

const UNREPORTED: DeliveryChecks = {
  reported: false,
  smsProvider: null,
  platformSmsConfigured: null,
  platformEmailConfigured: null,
  linkHostAligned: null,
  smsIpAllowlistEnforced: false,
  smsIpAllowlistNetworks: null,
  reportedAt: null,
};

function readDelivery(metadata: unknown, appBaseUrl: string | null): DeliveryChecks | null {
  if (!metadata || typeof metadata !== "object") return null;
  const delivery = (metadata as Record<string, unknown>).delivery;
  if (!delivery || typeof delivery !== "object") return null;
  const record = delivery as Record<string, unknown>;
  const workerAppUrl = typeof record.appUrl === "string" ? record.appUrl.replace(/\/$/, "") : "";
  return {
    reported: true,
    smsProvider: typeof record.smsProvider === "string" && record.smsProvider ? record.smsProvider : null,
    platformSmsConfigured: record.platformSmsConfigured === true,
    platformEmailConfigured: record.platformEmailConfigured === true,
    // Utan en av de två adresserna finns inget att jämföra, och `false` vore ett
    // påstående om olikhet som ingen mätning stöder.
    linkHostAligned: workerAppUrl && appBaseUrl ? workerAppUrl === appBaseUrl.replace(/\/$/, "") : null,
    smsIpAllowlistEnforced: false,
    smsIpAllowlistNetworks: null,
    reportedAt: null,
  };
}

export async function GET() {
  const startedAt = Date.now();
  // The configured public base URL is what customers receive in acceptance and
  // signing links. It is not a secret, and surfacing it here is the only way to
  // confirm from outside that a deployment builds links for the canonical domain
  // rather than for a host that no longer resolves.
  let appBaseUrl: string | null = null;
  try {
    appBaseUrl = publicEnv().NEXT_PUBLIC_APP_URL;
  } catch {
    appBaseUrl = null;
  }
  const appBaseUrlUsable = appBaseUrl !== null && isUsablePublicAppUrl(appBaseUrl);
  // A registered webhook target on a different host than the app is delivered to
  // only if the provider follows redirects, which is not guaranteed. Report it.
  // Adressen leverantören förväntas posta till. Den går inte att läsa tillbaka
  // från leverantören -- den skrivs in för hand i deras kontrollpanel -- så det
  // här är adressen den borde vara, för den som jämför de två.
  const webhookUrl = expectedWebhookUrl();
  const configured = telephonyConfigured();
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("tenants").select("id", { head: true, count: "exact" }).limit(1);
    if (error) {
      return NextResponse.json({
        status: "not_ready",
        service: "kundexa-web",
        checks: { database: false, telephonyConfigured: configured, appBaseUrl, appBaseUrlUsable, webhookUrl, delivery: UNREPORTED },
        durationMs: Date.now() - startedAt,
      }, { status: 503, headers: { "cache-control": "no-store" } });
    }

    // SMS- och e-postnycklarna bor i Edge-funktionen, inte här. Webbappen kan
    // inte läsa dem, så den enda vägen till ett svar är arbetarens egen
    // rapport. Saknas den säger vi att den saknas -- inte att allt är bra.
    let delivery: DeliveryChecks = UNREPORTED;
    const { data: heartbeat } = await admin.from("platform_worker_heartbeats")
      .select("metadata,updated_at")
      .eq("worker_key", "process-outbox")
      .maybeSingle();
    if (heartbeat) {
      const read = readDelivery(heartbeat.metadata, appBaseUrl);
      if (read) delivery = { ...read, reportedAt: heartbeat.updated_at ?? null };
    }

    let allowlistEnforced = false;
    try { allowlistEnforced = serverEnv().ENFORCE_SMS_IP_ALLOWLIST; } catch { allowlistEnforced = false; }
    delivery = { ...delivery, smsIpAllowlistEnforced: allowlistEnforced };
    if (delivery.smsProvider) {
      const { count, error: allowlistError } = await admin.from("provider_network_allowlists")
        .select("id", { head: true, count: "exact" })
        .eq("provider", delivery.smsProvider)
        .eq("active", true);
      // Ett läsfel är inte noll nät. Noll betyder "spärren stänger ute allt",
      // och det påståendet ska bara göras när det är mätt.
      delivery = { ...delivery, smsIpAllowlistNetworks: allowlistError ? null : count ?? 0 };
    }

    return NextResponse.json({
      status: "ready",
      service: "kundexa-web",
      checks: { database: true, telephonyConfigured: configured, appBaseUrl, appBaseUrlUsable, webhookUrl, delivery },
      durationMs: Date.now() - startedAt,
    }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({
      status: "not_ready",
      service: "kundexa-web",
      checks: { database: false, telephonyConfigured: false, appBaseUrl, appBaseUrlUsable, webhookUrl, delivery: UNREPORTED },
      durationMs: Date.now() - startedAt,
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
