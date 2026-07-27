export const resendStatusMap = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.delivery_delayed": "delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  "email.suppressed": "suppressed",
} as const;

export type ResendEventType = keyof typeof resendStatusMap;
export type ResendDeliveryStatus = (typeof resendStatusMap)[ResendEventType];

export function resendStatusForEvent(eventType: string): ResendDeliveryStatus | null {
  return resendStatusMap[eventType as ResendEventType] ?? null;
}

export function isPermanentResendFailure(status: string) {
  return status === "bounced" || status === "complained" || status === "suppressed";
}
