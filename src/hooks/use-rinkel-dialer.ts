"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

export type DialPath = {
  mapped?: boolean;
  deviceReady?: boolean;
  /** The phone Rinkel rings first: the seller's own seat at the provider. */
  deviceRingsPhone?: string | null;
  providerUserName?: string | null;
  /** What the customer sees. A different number from the one above. */
  callerIdNumber?: string | null;
  callerIdSource?: string | null;
  seatNameMatchesProfile?: boolean | null;
};

export type EndCallResult = {
  callId: string;
  attemptReleased: boolean;
  callClosed: boolean;
  answeredWhenEnded: boolean;
  providerHangupSupported: boolean;
  callStatus: string;
  message: string;
};

type StatusResponse = {
  dialPath?: DialPath | null;
  manualReady?: boolean;
  automaticReady?: boolean;
  platformConfigured?: boolean | null;
  platformReady?: boolean;
  runtimeConfigured?: boolean;
  tenantEnabled?: boolean;
  tenantHasNumber?: boolean;
  userMapped?: boolean;
  userHasDevice?: boolean;
  userHasNumberAccess?: boolean;
  callerIdResolvable?: boolean;
  apiVerified?: boolean;
  coreWebhooksVerified?: boolean;
  workerHealthy?: boolean;
  userHasActiveDevice?: boolean;
  blockers?: Array<{ code: string; message: string }>;
  webhookReady?: boolean;
  status?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
};

function publicTelephonyMessage(message: string) {
  return message
    .replace(/rinkel/gi, "telefonitjänsten")
    .replace(/provider/gi, "telefonitjänsten")
    .replace(/leverantör/gi, "telefonitjänst");
}

function telephonyStatusMessage(data: StatusResponse) {
  if (data.manualReady) return "Telefoni redo";
  if (data.blockers?.[0]?.message) return publicTelephonyMessage(data.blockers[0].message);
  if (data.errorMessage) return publicTelephonyMessage(data.errorMessage);
  switch (data.errorCode) {
    case "RINKEL_RUNTIME_API_KEY_MISSING":
      return "Telefonitjänstens serverkonfiguration saknas. Kontakta plattformsadministratören";
    case "RINKEL_PLATFORM_NOT_CONFIGURED":
      return "Telefoni är inte konfigurerad eller verifierad av plattformsadministratören";
    case "RINKEL_PLATFORM_TESTING":
      return "Telefonianslutningen testas just nu";
    case "RINKEL_AUTHENTICATION_ERROR":
      return "Telefonitjänstens anslutning nekades";
    case "RINKEL_PLAN_UNSUPPORTED":
      return "Telefonikontot saknar nödvändig integrationsåtkomst";
    case "RINKEL_UNAVAILABLE":
      return "Telefonitjänsten kunde inte nås vid den senaste kontrollen";
    case "TELEPHONY_PLATFORM_DISABLED":
      return "Central telefoni är pausad";
    case "RINKEL_DIAL_CAPABILITY_MISSING":
      return "Telefonianslutningen saknar verifierad uppringningsbehörighet";
    case "TELEPHONY_DISABLED":
      return "Telefoni är pausad för företaget";
    case "RINKEL_TENANT_NUMBER_MISSING":
      return "Inget telefonnummer har tilldelats företaget eller ditt team";
    case "RINKEL_USER_MAPPING_MISSING":
      return "Du saknar en telefonimappning";
    case "RINKEL_DEVICE_MISSING":
    case "DEVICE_MISSING":
    case "PROVIDER_DEVICE_MISSING":
      return "Logga in i telefonitjänstens webbtelefon eller app – ingen enhet är registrerad för dig";
    case "RINKEL_NUMBER_ACCESS_DENIED":
      return "Du saknar åtkomst till ett utgående nummer";
    case "CALLER_ID_UNRESOLVABLE":
      return "Ditt tilldelade utgående nummer kunde inte väljas";
    case "MANUAL_DIALER_DISABLED":
      return "Manuell uppringning är avstängd för företaget";
    default:
      break;
  }
  if (!data.platformReady) return "Telefoni är inte redo. Kontakta administratören";
  if (!data.tenantEnabled) return "Telefoni är pausad för företaget";
  if (!data.tenantHasNumber) return "Inget telefonnummer har tilldelats företaget eller ditt team";
  if (!data.userMapped) return "Du saknar en telefonimappning";
  if (!data.userHasDevice) return "Logga in i telefonitjänstens webbtelefon eller app – ingen enhet är registrerad för dig";
  if (!data.userHasNumberAccess) return "Du saknar åtkomst till ett utgående nummer";
  if (data.callerIdResolvable === false) return "Ditt tilldelade utgående nummer kunde inte väljas";
  return "Telefoni är inte redo";
}

export function useRinkelDialer() {
  const [registered, setRegistered] = useState(false);
  const [automaticReady, setAutomaticReady] = useState(false);
  const [calling, setCalling] = useState(false);
  const [ending, setEnding] = useState(false);
  const [dialPath, setDialPath] = useState<DialPath | null>(null);
  const [status, setStatus] = useState("Kontrollerar telefoni…");

  useEffect(() => {
    let active = true;
    void fetch("/api/v1/telephony/status", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as StatusResponse;
        if (!active) return;
        setRegistered(Boolean(response.ok && data.manualReady));
        setAutomaticReady(Boolean(response.ok && data.automaticReady));
        setDialPath(response.ok ? data.dialPath ?? null : null);
        setStatus(response.ok ? telephonyStatusMessage(data) : publicTelephonyMessage(data.errorMessage ?? "Telefonistatus kunde inte hämtas"));
      })
      .catch(() => {
        if (active) {
          setRegistered(false);
          setAutomaticReady(false);
          setStatus("Telefonistatus kunde inte hämtas");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const startCall = useCallback(async (payload: Record<string, unknown>) => {
    setCalling(true);
    setStatus("Initierar samtalet på din telefonienhet…");
    const body = {
      ...payload,
      clientRequestId: payload.clientRequestId ?? crypto.randomUUID(),
      idempotencyKey: payload.idempotencyKey ?? `rinkel.call:${crypto.randomUUID()}`,
    };
    let response: Response;
    try {
      response = await fetch("/api/v1/calls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      setCalling(true);
      setStatus("Svaret från samtalsstarten saknas – inväntar webhook eller CDR-avstämning");
      const uncertain = new Error("Samtalsstartens utfall är oklart. Starta inte ett nytt samtal.") as Error & { outcomeUnknown: boolean };
      uncertain.outcomeUnknown = true;
      throw uncertain;
    }
    let data: {
      callId?: string;
      error?: string;
      message?: string;
      status?: string;
      attemptStatus?: string;
      providerStatus?: string;
      callActive?: boolean;
      idempotentReplay?: boolean;
      correlationId?: string;
    };
    try {
      data = await response.json() as typeof data;
    } catch {
      setCalling(true);
      setStatus("Samtalsstartens svar kunde inte tolkas – inväntar säker avstämning");
      const uncertain = new Error("Samtalsstartens utfall är oklart. Starta inte ett nytt samtal.") as Error & { outcomeUnknown: boolean };
      uncertain.outcomeUnknown = true;
      throw uncertain;
    }
    if (!response.ok && response.status !== 202) {
      setCalling(false);
      const reference = data.correlationId ? ` Referens: ${data.correlationId}.` : "";
      const message = `${publicTelephonyMessage(data.message ?? data.error ?? "Samtalet kunde inte startas")}${reference}`;
      setStatus(message);
      throw new Error(message);
    }
    if (!data.callId) {
      setCalling(false);
      throw new Error("call_id_missing");
    }
    const uncertain = data.status === "provider_outcome_unknown"
      || data.attemptStatus === "provider_outcome_unknown"
      || data.attemptStatus === "reconciliation_required";
    if (data.idempotentReplay && data.callActive === false) {
      setCalling(false);
      setStatus(data.message ?? "Det tidigare samtalsförsöket är avslutat");
      throw new Error(data.message ?? "call_attempt_not_active");
    }
    setCalling(true);
    setStatus(uncertain
      ? "Samtalsresultatet är oklart – inväntar säker avstämning"
      : publicTelephonyMessage(data.message ?? "Telefonitjänsten ringer din valda enhet"));
    return data.callId;
  }, []);

  const markEnded = useCallback(() => {
    setCalling(false);
    setStatus("Telefoni redo");
  }, []);

  // Rinkel exposes no hangup endpoint — its whole call-control surface is
  // `POST /dial` — so this never claims to drop the provider's call. What it
  // does is release the dial attempt, which is what actually blocks the seller
  // from calling the next number, and close an unanswered call.
  const endCall = useCallback(async (callId: string, reason?: string) => {
    setEnding(true);
    try {
      const response = await fetch("/api/v1/calls/end", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ callId, reason: reason ?? null }),
      });
      const payload = await response.json().catch(() => null) as (EndCallResult & { message?: string; error?: string }) | null;
      if (!response.ok || !payload) {
        throw new Error(payload?.message ?? "Samtalet kunde inte avslutas");
      }
      setCalling(false);
      setStatus(payload.message ?? "Telefoni redo");
      return payload;
    } finally {
      setEnding(false);
    }
  }, []);

  return { registered, automaticReady, calling, ending, dialPath, status, startCall, markEnded, endCall };
}
