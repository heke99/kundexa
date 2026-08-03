"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type StatusResponse = {
  manualReady?: boolean;
  automaticReady?: boolean;
  platformConfigured?: boolean | null;
  platformReady?: boolean;
  tenantEnabled?: boolean;
  tenantHasNumber?: boolean;
  userMapped?: boolean;
  userHasDevice?: boolean;
  userHasNumberAccess?: boolean;
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
      return "Din telefonienhet saknas";
    case "RINKEL_NUMBER_ACCESS_DENIED":
      return "Du saknar åtkomst till ett utgående nummer";
    case "MANUAL_DIALER_DISABLED":
      return "Manuell uppringning är avstängd för företaget";
    default:
      break;
  }
  if (!data.platformReady) return "Telefoni är inte redo. Kontakta administratören";
  if (!data.tenantEnabled) return "Telefoni är pausad för företaget";
  if (!data.tenantHasNumber) return "Inget telefonnummer har tilldelats företaget eller ditt team";
  if (!data.userMapped) return "Du saknar en telefonimappning";
  if (!data.userHasDevice) return "Din telefonienhet saknas";
  if (!data.userHasNumberAccess) return "Du saknar åtkomst till ett utgående nummer";
  return "Telefoni är inte redo";
}

export function useRinkelDialer() {
  const [registered, setRegistered] = useState(false);
  const [automaticReady, setAutomaticReady] = useState(false);
  const [calling, setCalling] = useState(false);
  const [status, setStatus] = useState("Kontrollerar telefoni…");

  useEffect(() => {
    let active = true;
    void fetch("/api/v1/telephony/status", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as StatusResponse;
        if (!active) return;
        setRegistered(Boolean(response.ok && data.manualReady));
        setAutomaticReady(Boolean(response.ok && data.automaticReady));
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
      setStatus(publicTelephonyMessage(data.message ?? data.error ?? "Samtalet kunde inte startas"));
      throw new Error(data.message ?? data.error ?? "call_start_failed");
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

  return { registered, automaticReady, calling, status, startCall, markEnded };
}
