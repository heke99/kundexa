import { createAdminClient } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";
import { sha256 } from "@/lib/crypto";

/**
 * Den leverantörsneutrala inkommande SMS-porten.
 *
 * Webhookrutterna under /api/webhooks/sms äger affärslogiken -- avtalssvar,
 * konversationer, leveransstatus -- och känner inte till någon leverantör.
 * Det enda leverantörsspecifika är hur en HTTP-förfrågan blir till ett
 * `InboundSms` eller en `SmsDeliveryReport`, och det bor i adaptern nedan.
 *
 * Konsekvensen är att ett leverantörsbyte är en ny adapter plus en rad i
 * registret. Hos den förra leverantören låg formatparsningen, autentiseringen och
 * avtalslogiken i samma fil, och det var därför bytet kostade så mycket.
 */

/** Exakt vad som kan komma ur JSON.parse -- och därmed vad som kan sparas. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type InboundSms = {
  /** Leverantörens id för meddelandet. Bär idempotensen; krävs. */
  providerMessageId: string;
  from: string;
  to: string;
  body: string;
  receivedAt: string;
  /** Rå nyttolast, sparad som bevis för ett avtalssvar. */
  payload: JsonObject;
};

export type SmsDeliveryReport = {
  providerMessageId: string;
  /** Vår egen id, när leverantören bär tillbaka den. */
  clientReference: string | null;
  status: "created" | "sent" | "delivered" | "failed";
  /** Leverantörens egen statussträng, för `sms_delivery_events`. */
  providerStatus: string;
  errorMessage: string | null;
  payload: JsonObject;
};

export type SmsWebhookAdapter = {
  readonly id: string;
  parseInbound(request: Request): Promise<InboundSms | null>;
  parseDeliveryReport(request: Request): Promise<SmsDeliveryReport | null>;
};

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function text(payload: JsonObject, ...keys: string[]) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Sinch XMS. Hela leverantörens vokabulär slutar här. */
const sinchAdapter: SmsWebhookAdapter = {
  id: "sinch",
  async parseInbound(request) {
    const payload = asObject(await request.json().catch(() => null));
    // XMS skickar flera callback-typer till samma URL. Allt som inte är ett
    // inkommande textmeddelande ska kvitteras, inte tolkas som ett -- annars
    // registreras en leveransrapport som kundens svar på ett avtal.
    const type = text(payload, "type");
    if (type && type !== "mo_text") return null;
    const providerMessageId = text(payload, "id");
    const from = text(payload, "from");
    const to = text(payload, "to");
    if (!providerMessageId || !from || !to) return null;
    return {
      providerMessageId,
      from,
      to,
      body: typeof payload.body === "string" ? payload.body : "",
      receivedAt: text(payload, "received_at") ?? new Date().toISOString(),
      payload,
    };
  },
  async parseDeliveryReport(request) {
    const payload = asObject(await request.json().catch(() => null));
    const type = text(payload, "type");
    if (type && !type.includes("delivery_report")) return null;
    const providerMessageId = text(payload, "batch_id", "id");
    if (!providerMessageId) return null;
    const providerStatus = text(payload, "status") ?? "Unknown";
    const normalized = providerStatus.toLowerCase();
    // Översättningen sker en gång, här. Den gamla rutten gissade med
    // `includes("deliver")` på varje anrop, vilket gjorde "Undeliverable" till
    // "delivered".
    const status = normalized === "delivered"
      ? "delivered" as const
      : ["failed", "aborted", "expired", "rejected", "cancelled", "canceled", "undeliverable"].includes(normalized)
        ? "failed" as const
        : normalized === "dispatched"
          ? "sent" as const
          : "created" as const;
    return {
      providerMessageId,
      clientReference: text(payload, "client_reference"),
      status,
      providerStatus,
      errorMessage: status === "failed" ? `${providerStatus}${payload.code == null ? "" : `:${String(payload.code)}`}` : null,
      payload,
    };
  },
};

const REGISTRY: Record<string, SmsWebhookAdapter> = { sinch: sinchAdapter };

/** Vilken adapter som används när inget annat är satt. Namnet bor här. */
export const DEFAULT_SMS_PROVIDER = sinchAdapter.id;

export function smsWebhookAdapter(): SmsWebhookAdapter {
  const id = process.env.SMS_PROVIDER ?? DEFAULT_SMS_PROVIDER;
  const adapter = REGISTRY[id];
  // En okänd leverantör är en felkonfiguration. En tyst fallback hade tolkat
  // nästa leverantörs nyttolast med fel adapter och tappat avtalssvar.
  if (!adapter) throw new Error(`sms_provider_unknown:${id}`);
  return adapter;
}

/**
 * Autentiserar anropet mot det nummer det påstår sig gälla.
 *
 * Token ligger i callback-URL:en och jämförs mot numrets sparade hash. Det är
 * per nummer, inte per konto: en läckt URL för ett nummer kan inte användas för
 * ett annat, och inte heller för en annan tenant.
 */
export async function authenticateSmsNumber(numberE164: string, token: string) {
  const env = serverEnv();
  const admin = createAdminClient();
  const { data: number } = await admin
    .from("phone_numbers")
    .select("*")
    .eq("number_e164", numberE164)
    .eq("status", "active")
    .maybeSingle();
  if (!number || number.webhook_token_hash !== sha256(token + env.KUNDEXA_WEBHOOK_PEPPER)) return null;
  return number;
}

/**
 * Valfri IP-spärr framför SMS-webhookarna.
 *
 * Djupled, inte primärskydd: token per nummer är det som faktiskt
 * autentiserar. Spärren är avstängd som standard eftersom en leverantörs
 * IP-intervall ändras utan förvarning, och en spärr som tappar inkommande
 * avtalssvar är värre än ingen spärr. Tillåtna intervall ligger i databasen så
 * att de kan uppdateras utan en deploy.
 */
export async function verifySmsCallbackNetwork(request: Request, provider: string) {
  const env = serverEnv();
  if (!env.ENFORCE_SMS_IP_ALLOWLIST) return true;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const direct = request.headers.get("x-real-ip")?.trim();
  const ip = forwarded || direct;
  if (!ip) return false;
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("is_provider_ip_allowed", { p_provider: provider, p_ip: ip });
  return !error && data === true;
}
