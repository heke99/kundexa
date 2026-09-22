import { serverEnv } from "@/lib/env";

/**
 * Vad ser leverantören för Kundexas nyckel?
 *
 * "Domänen är verifierad" och "leverantören svarar 403: domänen är inte
 * verifierad" kan båda vara sanna samtidigt, för de handlar om olika konton. En
 * nyckel skapad i ett team ser inte domänen som verifierats i ett annat, och
 * varken kontrollpanelen eller felmeddelandet säger vilket konto nyckeln
 * tillhör.
 *
 * Svaret hämtas från leverantören i stället för att påstås. Integrationssidan
 * påstod tidigare rakt ut att domänen var verifierad -- en rad som stod kvar
 * och var osann medan varje utskick avvisades.
 *
 * Domännamn och status är inte hemligheter. Nyckeln är det, och den lämnar
 * aldrig servern: den används som bearer-credential och hamnar aldrig i något
 * som returneras härifrån.
 */

export type SendingDomainStatus = {
  kind: "verified" | "not_in_account" | "unverified" | "no_domains" | "unreadable";
  domain: string;
  message: string;
};

type ResendDomain = { name?: string; status?: string };

export async function describeResendSendingDomain(): Promise<SendingDomainStatus> {
  const env = serverEnv();
  const domain = String(env.DEFAULT_EMAIL_FROM_ADDRESS ?? "").split("@")[1]?.toLowerCase() ?? "";
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey || !domain) {
    return { kind: "unreadable", domain, message: "Kundexas e-postkonto är inte färdigkonfigurerat." };
  }
  let domains: ResendDomain[] = [];
  try {
    // Sidan ska renderas även när leverantören är seg eller nere. En avsaknad
    // av svar är inte ett besked om domänen.
    const response = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!response.ok) {
      return { kind: "unreadable", domain, message: `Resend svarade ${response.status} på domänfrågan.` };
    }
    domains = ((await response.json()) as { data?: ResendDomain[] }).data ?? [];
  } catch {
    return { kind: "unreadable", domain, message: "Resend svarade inte på domänfrågan." };
  }

  if (domains.length === 0) {
    return {
      kind: "no_domains",
      domain,
      message: `Nyckeln tillhör ett Resend-konto utan några domäner alls. ${domain} är verifierad i ett annat konto eller team — skapa nyckeln i samma team som domänen står i.`,
    };
  }
  const listed = domains.map((entry) => `${entry.name ?? "?"} (${entry.status ?? "okänd status"})`).join(", ");
  const match = domains.find((entry) => (entry.name ?? "").toLowerCase() === domain);
  if (!match) {
    return {
      kind: "not_in_account",
      domain,
      message: `${domain} finns inte i det konto nyckeln tillhör. Kontot har: ${listed}. Antingen pekar DEFAULT_EMAIL_FROM_ADDRESS på fel domän, eller så skapades nyckeln i fel team.`,
    };
  }
  if ((match.status ?? "").toLowerCase() !== "verified") {
    return {
      kind: "unverified",
      domain,
      message: `${domain} finns i kontot men har status "${match.status ?? "okänd"}", inte "verified". Utskick avvisas tills den är färdigverifierad.`,
    };
  }
  return { kind: "verified", domain, message: `${domain} är verifierad i det konto nyckeln tillhör.` };
}
