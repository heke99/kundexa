/** Resend protocol verified against resend-node src/webhooks/{webhooks.ts,
 * interfaces/create-webhook-options.interface.ts,get-webhook.interface.ts,
 * list-webhooks.interface.ts}. Never expose raw responses: get/create contain
 * the signing secret, and endpoints include Kundexa's private path token. */
export const RESEND_DELIVERY_EVENTS = ["email.sent", "email.delivered", "email.delivery_delayed", "email.bounced", "email.complained", "email.opened", "email.clicked", "email.failed", "email.suppressed"] as const;
type ProviderWebhook = { id: string; endpoint: string; status: string; events: string[] | null; signing_secret?: string };
export function resendWebhookAdmin(apiKey: string, fetcher: typeof fetch = fetch) {
  if (!apiKey) throw new Error("platform_resend_key_missing");
  async function request(path: string, init?: RequestInit) {
    const response = await fetcher(`https://api.resend.com${path}`, { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...init?.headers } });
    if (!response.ok) throw new Error(`resend_admin_http_${response.status}`);
    return response.json() as Promise<unknown>;
  }
  async function list() {
    const rows: ProviderWebhook[] = []; const seen = new Set<string>(); let after = "";
    for (let page = 0; page < 100; page++) {
      const body = await request(`/webhooks?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`) as { data?: ProviderWebhook[]; has_more?: boolean };
      if (!Array.isArray(body.data)) throw new Error("resend_webhook_inventory_invalid");
      rows.push(...body.data);
      if (!body.has_more) return rows;
      const next = body.data.at(-1)?.id;
      if (!next || seen.has(next)) throw new Error("resend_webhook_inventory_incomplete");
      seen.add(next); after = next;
    }
    throw new Error("resend_webhook_inventory_incomplete");
  }
  async function verifiedSigningSecret(id: string, endpoint: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("resend_webhook_identifier_invalid");
    const webhook = await request(`/webhooks/${encodeURIComponent(id)}`) as ProviderWebhook;
    if (webhook.id !== id || webhook.endpoint !== endpoint || webhook.status !== "enabled" || !RESEND_DELIVERY_EVENTS.every(event => webhook.events?.includes(event))
      || typeof webhook.signing_secret !== "string" || !/^whsec_[A-Za-z0-9+/=_-]+$/.test(webhook.signing_secret)) throw new Error("resend_webhook_configuration_mismatch");
    return { id, signingSecret: webhook.signing_secret };
  }
  return {
    async inspectDomain(domain: string) {
      let after = ""; const seen = new Set<string>();
      for (let page = 0; page < 100; page++) {
        const body = await request(`/domains?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`) as { data?: Array<{ id?: string; name?: string; status?: string }>; has_more?: boolean };
        if (!Array.isArray(body.data)) throw new Error("resend_domain_inventory_invalid");
        if (body.data.some(row => row.name?.toLowerCase() === domain.toLowerCase() && row.status === "verified")) return true;
        if (!body.has_more) return false;
        const next = body.data.at(-1)?.id;
        if (!next || seen.has(next)) throw new Error("resend_domain_inventory_incomplete");
        seen.add(next); after = next;
      }
      throw new Error("resend_domain_inventory_incomplete");
    },
    async ensureWebhook(endpoint: string, initial: boolean) {
      const target = new URL(endpoint);
      if (target.protocol !== "https:" || target.username || target.password || target.search || target.hash) throw new Error("resend_webhook_endpoint_invalid");
      const matches = (await list()).filter(row => row.endpoint === endpoint);
      if (matches.length > 1) throw new Error("resend_webhook_inventory_conflict");
      if (matches.length === 1) return verifiedSigningSecret(matches[0].id, endpoint);
      // The caller persists and exclusively claims initial=true before POST.
      // A timeout is reconciled by exact endpoint; it never sends another POST.
      if (!initial) throw new Error("resend_webhook_create_outcome_unconfirmed");
      const created = await request("/webhooks", { method: "POST", body: JSON.stringify({ endpoint, events: RESEND_DELIVERY_EVENTS }) }) as { id?: string };
      if (!created.id) throw new Error("resend_webhook_create_outcome_unconfirmed");
      return verifiedSigningSecret(created.id, endpoint);
    },
  };
}
