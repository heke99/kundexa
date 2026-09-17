// Den leverantörsneutrala SMS-porten.
//
// Allt utanför den här filen och dess adaptrar talar om "ett SMS", aldrig om en
// namngiven leverantör. Byter vi leverantör skrivs en ny adapter och registreras
// i `smsProviderFor`; utskickskoden i process-outbox rörs inte. Det var precis
// den kopplingen som gjorde 46elks dyr att lämna: leverantörens HTTP-anrop,
// dess statussträngar och dess avstämningsheuristik låg mitt i jobblogiken.
//
// Porten är medvetet smal. Den kan bara två saker, och båda är sådant som en
// SMS-leverantör måste kunna för att vi ska kunna leverera ett avtal:
//   1. skicka ett meddelande, och
//   2. hitta tillbaka till ett meddelande vi redan kan ha skickat.
// Punkt 2 är inte en bekvämlighet. Utan den skickar en omkörning efter en
// timeout avtalet en gång till till kunden.

export type SmsProviderId = "sinch";

/** Vilken adapter som används när inget annat är satt. Namnet bor här. */
export const DEFAULT_SMS_PROVIDER: SmsProviderId = "sinch";

export type SmsSendRequest = {
  /** Avsändarnumret i E.164. Måste vara ett nummer vi äger hos leverantören. */
  from: string;
  to: string;
  body: string;
  /**
   * Vår egen id för meddelandet. Adaptern måste bära den hela vägen till
   * leverantören så att `findSubmitted` kan hitta tillbaka utan gissningar.
   */
  clientReference: string;
  /** Dit leverantören skickar leveransrapporter. */
  deliveryCallbackUrl: string;
};

export type SmsStatus = "created" | "sent" | "delivered" | "failed";

export type SmsSubmission = {
  providerMessageId: string;
  status: SmsStatus;
  sentAt: string;
  /** Antal segment. Räknas lokalt när leverantören inte rapporterar det. */
  parts: number;
  /** Kostnad, bara när leverantören faktiskt rapporterar den. Aldrig gissad. */
  cost: number | null;
  deliveredAt: string | null;
};

export type SmsProvider = {
  readonly id: SmsProviderId;
  send(request: SmsSendRequest): Promise<SmsSubmission>;
  /**
   * Returnerar meddelandet om leverantören redan tagit emot det under samma
   * `clientReference`, annars null. Får aldrig matcha på ungefärlig tid eller
   * innehåll: ett falskt ja markerar ett osänt avtal som skickat.
   */
  findSubmitted(clientReference: string): Promise<SmsSubmission | null>;
};

export type SmsProviderCredentials = {
  servicePlanId: string;
  apiToken: string;
  /** Sinch-regionen, t.ex. "eu" eller "us". Del av bas-URL:en. */
  region: string;
};

/**
 * GSM-03.38 respektive UCS-2-segmentering. Leverantören fakturerar per segment
 * men rapporterar det inte i svaret, och en hårdkodad etta hade fått ett
 * trelångt avtals-SMS att se ut som ett.
 */
const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€";

export function smsSegments(body: string): number {
  let units = 0;
  let gsm = true;
  for (const character of body) {
    if (GSM_BASIC.includes(character)) units += 1;
    else if (GSM_EXTENDED.includes(character)) units += 2;
    else { gsm = false; break; }
  }
  if (!gsm) {
    // UCS-2 räknas i kodenheter, inte tecken: en emoji är två.
    const codeUnits = body.length;
    return codeUnits <= 70 ? 1 : Math.ceil(codeUnits / 67);
  }
  if (units === 0) return 1;
  return units <= 160 ? 1 : Math.ceil(units / 153);
}

/**
 * Sinch XMS. Den enda adaptern i dag; hela leverantörens vokabulär slutar här.
 */
function sinchSmsProvider(credentials: SmsProviderCredentials): SmsProvider {
  const base = `https://${credentials.region}.sms.api.sinch.com/xms/v1/${encodeURIComponent(credentials.servicePlanId)}`;
  const headers = {
    Authorization: `Bearer ${credentials.apiToken}`,
    "content-type": "application/json",
  };

  const fromBatch = (batch: Record<string, unknown>, body: string): SmsSubmission => ({
    providerMessageId: String(batch.id ?? ""),
    status: batch.canceled === true ? "failed" : "created",
    sentAt: typeof batch.created_at === "string" ? batch.created_at : new Date().toISOString(),
    parts: smsSegments(body),
    // XMS rapporterar ingen kostnad. Att fylla i en vore att hitta på siffror
    // som sedan läses som fakturaunderlag.
    cost: null,
    deliveredAt: null,
  });

  return {
    id: "sinch",
    async send(request) {
      const response = await fetch(`${base}/batches`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          from: request.from,
          to: [request.to],
          body: request.body,
          client_reference: request.clientReference,
          delivery_report: "per_recipient",
          callback_url: request.deliveryCallbackUrl,
        }),
      });
      const text = await response.text();
      if (!response.ok) {
        // 4xx utom 429 är vårt fel och kommer aldrig att lyckas vid omkörning.
        // Att låta det köra om i evighet döljer en felkonfigurerad avsändare.
        const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
        throw new Error(`${permanent ? "permanent_" : ""}sms_provider_${response.status}:${text.slice(0, 500)}`);
      }
      const batch = JSON.parse(text) as Record<string, unknown>;
      if (!batch.id) throw new Error("sms_provider_response_without_id");
      return fromBatch(batch, request.body);
    },
    async findSubmitted(clientReference) {
      const url = new URL(`${base}/batches`);
      url.searchParams.set("client_reference", clientReference);
      url.searchParams.set("page_size", "1");
      const response = await fetch(url, { headers });
      if (!response.ok) throw new Error(`sms_reconciliation_${response.status}`);
      const payload = await response.json() as { batches?: Array<Record<string, unknown>> };
      const batch = payload.batches?.[0];
      if (!batch?.id) return null;
      return fromBatch(batch, String(batch.body ?? ""));
    },
  };
}

const REGISTRY: Record<SmsProviderId, (credentials: SmsProviderCredentials) => SmsProvider> = {
  sinch: sinchSmsProvider,
};

export function smsProviderFor(id: string, credentials: SmsProviderCredentials): SmsProvider {
  const factory = REGISTRY[id as SmsProviderId];
  // Ett okänt namn är en felkonfiguration, inte något att tyst falla tillbaka
  // från: en tyst fallback hade skickat kundens avtal via fel konto.
  if (!factory) throw new Error(`permanent_sms_provider_unknown:${id}`);
  if (!credentials.servicePlanId || !credentials.apiToken) throw new Error("permanent_sms_provider_not_configured");
  return factory(credentials);
}
