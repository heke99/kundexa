import { serverEnv } from "@/lib/env";

export async function sendProvisioningNotification(input: {
  email: string;
  tenantName: string;
  created: boolean;
}) {
  const env = serverEnv();
  if (!env.RESEND_API_KEY || !env.DEFAULT_EMAIL_FROM_ADDRESS || !env.DEFAULT_EMAIL_FROM_NAME) return { sent: false as const, reason: "resend_not_configured" as const };

  const loginUrl = `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/login`;
  const subject = input.created ? `Ditt Kundexa-konto hos ${input.tenantName}` : `Du har lagts till i ${input.tenantName}`;
  const text = input.created
    ? `Du har fått ett Kundexa-konto hos ${input.tenantName}. Logga in på ${loginUrl} med den e-postadress och det tillfälliga lösenord du fått via separat kanal. Du måste välja ett nytt lösenord vid första inloggningen.`
    : `Ditt befintliga Kundexa-konto har lagts till i ${input.tenantName}. Logga in på ${loginUrl} med ditt befintliga lösenord.`;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${env.DEFAULT_EMAIL_FROM_NAME} <${env.DEFAULT_EMAIL_FROM_ADDRESS}>`,
        to: [input.email],
        subject,
        text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { sent: false as const, reason: `resend_${response.status}` };
    return { sent: true as const };
  } catch {
    return { sent: false as const, reason: "resend_request_failed" as const };
  }
}
