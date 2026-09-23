"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useWebphone } from "./use-webphone";

export type EndCallResult = {
  callId: string;
  attemptReleased: boolean;
  callClosed: boolean;
  answeredWhenEnded: boolean;
  callStatus: string;
  message: string;
};

/**
 * Vad telefonistatusen faktiskt svarar.
 *
 * Den gamla typen beskrev en uppringningsväg: vilken telefon leverantören
 * ringde först, vilken plats säljaren satt på, om namnet stämde. Ingen av de
 * frågorna finns kvar när webbläsaren är telefonen -- och fält som aldrig fylls
 * i är värre än inga fält, för de får gränssnittet att visa "okänt" om något
 * som inte existerar.
 */
type StatusResponse = {
  manualReady?: boolean;
  automaticReady?: boolean;
  tenantEnabled?: boolean;
  outboundCallsEnabled?: boolean;
  withinCallingHours?: boolean;
  callerIdConfigured?: boolean;
  callerIdNumber?: string | null;
  callerIdSource?: string | null;
  hasOpenAttempt?: boolean;
  webphoneConfigured?: boolean;
  blockers?: Array<{ code?: string; message?: string }>;
  status?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
};

function publicTelephonyMessage(message: string) {
  // Skyddsnät. Meddelandena kommer från våra egna hinder i databasen och namnger
  // ingen leverantör, men ett felmeddelande som slinker igenom från ett
  // bibliotek ska inte lära säljaren vem vi köper telefoni av.
  return message
    .replace(/provider/gi, "telefonitjänsten")
    .replace(/leverantör/gi, "telefonitjänst");
}

/**
 * En mening som säger vad säljaren ska göra.
 *
 * Hindren kommer numera färdigformulerade från databasen, ett per villkor som
 * brister. Koderna nedan är bara till för de två hinder som inte kan formuleras
 * där: serverns egen konfiguration och ett misslyckat anrop.
 */
function telephonyStatusMessage(data: StatusResponse) {
  if (data.manualReady) return "Telefoni redo";
  const firstBlocker = data.blockers?.find((blocker) => blocker.message)?.message;
  if (firstBlocker) return publicTelephonyMessage(firstBlocker);
  if (data.errorMessage) return publicTelephonyMessage(data.errorMessage);
  switch (data.blockers?.[0]?.code ?? data.errorCode) {
    case "WEBPHONE_NOT_CONFIGURED":
      return "Webbtelefonen är inte konfigurerad. Kontakta plattformsadministratören";
    case "TELEPHONY_STATUS_QUERY_FAILED":
      return "Telefonistatus kunde inte läsas";
    default:
      return "Telefoni är inte redo";
  }
}

export function useDialerPanel() {
  const webphone = useWebphone();
  const { start: startWebphone } = webphone;
  const [registered, setRegistered] = useState(false);
  const [automaticReady, setAutomaticReady] = useState(false);
  const [calling, setCalling] = useState(false);
  const [ending, setEnding] = useState(false);
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

  // Webbtelefonen registrerar sig när dialern öppnas, inte vid första trycket
  // på ringknappen. Registreringen tar ett par sekunder, och att göra den när
  // säljaren redan har ett nummer framför sig hade lagt den väntan mitt i
  // arbetet -- och gett ett "webbtelefonen är inte klar" på det första samtalet
  // varje gång sidan laddats om.
  useEffect(() => {
    void startWebphone();
  }, [startWebphone]);

  const startCall = useCallback(async (payload: Record<string, unknown>) => {
    // Platsen tas och samtalsraden skrivs på servern innan webbläsaren ringer.
    // Är webbtelefonen inte registrerad blir det en reservation och en
    // misslyckad samtalsrad för ett problem som inte har med samtalet att göra
    // -- och säljaren får läsa att samtalet inte kunde kopplas upp, vilket
    // pekar åt fel håll. Frågan ställs därför före reservationen.
    const phase = webphone.state.phase;
    if (phase !== "ready" && phase !== "calling") {
      const message = phase === "unavailable"
        ? webphone.state.message
        : "Webbtelefonen registrerar sig fortfarande. Vänta några sekunder och försök igen.";
      setCalling(false);
      setStatus(message);
      throw new Error(message);
    }

    setCalling(true);
    setStatus("Kopplar upp samtalet i webbtelefonen…");
    const body = {
      ...payload,
      webphoneSessionId: payload.webphoneSessionId ?? webphone.currentSessionId(),
      clientRequestId: payload.clientRequestId ?? crypto.randomUUID(),
      idempotencyKey: payload.idempotencyKey ?? `call:${crypto.randomUUID()}`,
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
      attemptId?: string;
      to?: string;
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
    if (uncertain) {
      setCalling(true);
      setStatus("Samtalsresultatet är oklart – inväntar säker avstämning");
      return data.callId;
    }
    if (data.idempotentReplay) {
      // Reservationen återanvändes, så samtalet är redan uppkopplat. Att ringa
      // en gång till hade gett mottagaren två samtal för ett tryck.
      setCalling(true);
      setStatus(publicTelephonyMessage(data.message ?? "Det befintliga samtalet fortsätter"));
      return data.callId;
    }

    // Servern har reserverat platsen och samtalsraden. Uppkopplingen sker här,
    // i webbläsaren. Misslyckas den är raden redan skriven, så felet går att
    // följa -- till skillnad från förr, när ett samtal kunde försvinna mellan
    // leverantören och oss.
    if (!data.attemptId || !data.to) {
      setCalling(false);
      throw new Error("reservation_contract_invalid");
    }
    try {
      await webphone.placeCall({ callId: data.callId, attemptId: data.attemptId, to: data.to });
    } catch (error) {
      setCalling(false);
      const message = error instanceof Error && error.message === "webphone_not_ready"
        ? "Webbtelefonen är inte klar ännu. Vänta någon sekund och försök igen."
        : "Samtalet kunde inte kopplas upp i webbtelefonen.";
      setStatus(message);
      throw new Error(message);
    }
    setCalling(true);
    setStatus("Webbtelefonen ringer upp");
    return data.callId;
  }, [webphone]);

  const markEnded = useCallback(() => {
    setCalling(false);
    setStatus("Telefoni redo");
  }, []);

  // Serversidan lägger inte på: samtalet ligger i webbläsarens webbtelefon och
  // avslutas där. Det här anropet släpper uppringningsförsöket, som är det som
  // faktiskt hindrar säljaren från att ringa nästa nummer, och stänger ett
  // obesvarat samtal.
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

  return {
    registered, automaticReady, calling, ending, status,
    startCall, markEnded, endCall,
    webphone: webphone.state, startWebphone: webphone.start, hangupWebphone: webphone.hangup,
    // Ljudkontrollerna kommer från webbtelefonen och inte härifrån: det är den
    // som håller samtalet, och bara den vet vad det går att göra med det.
    muted: webphone.muted, audioCapabilities: webphone.capabilities,
    toggleMute: webphone.toggleMute, sendDtmf: webphone.sendDtmf,
  };
}
