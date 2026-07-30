"use client";

import { useCallback, useEffect, useState } from "react";

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
  webhookReady?: boolean;
  status?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
};

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
        if (!response.ok) setStatus(data.errorMessage ?? "Telefonistatus kunde inte hämtas");
        else if (!data.platformReady) setStatus("Telefonileverantören är tillfälligt otillgänglig");
        else if (!data.tenantEnabled) setStatus("Telefoni är pausad för företaget");
        else if (!data.tenantHasNumber) setStatus("Inget telefonnummer har tilldelats företaget");
        else if (!data.userMapped) setStatus("Du saknar en telefonimappning");
        else if (!data.userHasDevice) setStatus("Din Rinkel-enhet saknas");
        else if (!data.userHasNumberAccess) setStatus("Du saknar åtkomst till ett utgående nummer");
        else if (!data.manualReady) setStatus(data.errorMessage ?? "Telefoni är inte redo");
        else setStatus("Telefoni redo");
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
    setStatus("Initierar samtalet på din Rinkel-enhet…");
    const body = {
      ...payload,
      clientRequestId: payload.clientRequestId ?? crypto.randomUUID(),
      idempotencyKey: payload.idempotencyKey ?? `rinkel.call:${crypto.randomUUID()}`,
    };
    const response = await fetch("/api/v1/calls", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json() as { callId?: string; error?: string; message?: string; status?: string };
    if (!response.ok && response.status !== 202) {
      setCalling(false);
      setStatus(data.message ?? data.error ?? "Samtalet kunde inte startas");
      throw new Error(data.message ?? data.error ?? "call_start_failed");
    }
    if (!data.callId) {
      setCalling(false);
      throw new Error("call_id_missing");
    }
    setStatus(data.status === "provider_outcome_unknown"
      ? "Providerresultatet är oklart – inväntar avstämning"
      : "Rinkel ringer din valda enhet");
    return data.callId;
  }, []);

  const markEnded = useCallback(() => {
    setCalling(false);
    setStatus("Telefoni redo");
  }, []);

  return { registered, automaticReady, calling, status, startCall, markEnded };
}
