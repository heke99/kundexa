"use client";

import { useCallback, useEffect, useState } from "react";

type StatusResponse = {
  ready?: boolean;
  automaticReady?: boolean;
  configured?: boolean | null;
  status?: string;
  webhookStatus?: string | null;
  mappingReady?: boolean;
  errorMessage?: string | null;
};

export function useRinkelDialer() {
  const [registered, setRegistered] = useState(false);
  const [automaticReady, setAutomaticReady] = useState(false);
  const [calling, setCalling] = useState(false);
  const [status, setStatus] = useState("Kontrollerar Rinkel…");

  useEffect(() => {
    let active = true;
    void fetch("/api/v1/integrations/rinkel/status", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as StatusResponse;
        if (!active) return;
        setRegistered(Boolean(response.ok && data.ready));
        setAutomaticReady(Boolean(response.ok && data.automaticReady));
        if (!response.ok) setStatus(data.errorMessage ?? "Rinkel-status kunde inte hämtas");
        else if (data.configured === false) setStatus("Rinkel är inte anslutet");
        else if (!data.mappingReady) setStatus("Rinkel-mappning saknas");
        else if (!data.ready) setStatus(data.errorMessage ?? `Rinkel: ${data.status ?? "inte redo"}`);
        else setStatus("Rinkel redo");
      })
      .catch(() => {
        if (active) {
          setRegistered(false);
          setAutomaticReady(false);
          setStatus("Rinkel-status kunde inte hämtas");
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
    setStatus("Rinkel redo");
  }, []);

  return { registered, automaticReady, calling, status, startCall, markEnded };
}
