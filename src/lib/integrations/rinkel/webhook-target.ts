// Rinkel delivers webhooks with a plain POST and does not promise to follow a
// redirect. A public base URL that answers 3xx — an apex domain redirecting to
// its `www` host, for example — therefore registers cleanly with the provider
// and still loses every call event. The registration flow probes the target
// before it registers anything so that failure mode surfaces as a blocker
// instead of as silently missing calls.

export type WebhookTargetProbeResult =
  | { ok: true; status: number }
  | {
    ok: false;
    code:
      | "RINKEL_WEBHOOK_TARGET_REDIRECT"
      | "RINKEL_WEBHOOK_TARGET_UNREACHABLE"
      | "RINKEL_WEBHOOK_TARGET_UNEXPECTED_RESPONSE";
    message: string;
    status?: number;
    location?: string;
  };

export const WEBHOOK_TARGET_PROBE_PATH = "/api/health";

export function webhookTargetProbeUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, "")}${WEBHOOK_TARGET_PROBE_PATH}`;
}

/** Classifies a probe response without performing any I/O, so it is unit testable. */
export function classifyWebhookTargetResponse(
  baseUrl: string,
  response: { status: number; headers: { get(name: string): string | null } },
): WebhookTargetProbeResult {
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "";
    let target = location;
    try {
      target = new URL(location, webhookTargetProbeUrl(baseUrl)).origin;
    } catch {
      target = location;
    }
    return {
      ok: false,
      code: "RINKEL_WEBHOOK_TARGET_REDIRECT",
      status: response.status,
      location: target || undefined,
      message: target
        ? `Webhookadressen ${baseUrl} svarar med en omdirigering (${response.status}) till ${target}. Registrera webhookarna mot den adress som svarar direkt, annars kan samtalsevent tappas.`
        : `Webhookadressen ${baseUrl} svarar med en omdirigering (${response.status}). Registrera webhookarna mot den adress som svarar direkt, annars kan samtalsevent tappas.`,
    };
  }
  if (response.status === 200) return { ok: true, status: response.status };
  return {
    ok: false,
    code: "RINKEL_WEBHOOK_TARGET_UNEXPECTED_RESPONSE",
    status: response.status,
    message: `Webhookadressen ${baseUrl} svarade ${response.status} på hälsokontrollen. Kontrollera att adressen pekar på den driftsatta Kundexa-webben.`,
  };
}

export async function probeWebhookDeliveryTarget(
  baseUrl: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<WebhookTargetProbeResult> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(webhookTargetProbeUrl(baseUrl), {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    });
    return classifyWebhookTargetResponse(baseUrl, response);
  } catch {
    return {
      ok: false,
      code: "RINKEL_WEBHOOK_TARGET_UNREACHABLE",
      message: `Webhookadressen ${baseUrl} kunde inte nås från servern. Kontrollera DNS och att adressen är publikt tillgänglig innan webhookarna registreras.`,
    };
  } finally {
    clearTimeout(timer);
  }
}
