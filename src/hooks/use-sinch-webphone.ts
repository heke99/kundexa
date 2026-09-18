"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Säljarens webbtelefon.
 *
 * Samtalet kopplas här, i webbläsaren, och inte av servern. Servern reserverar
 * platsen och delar ut en kortlivad JWT; `sinch-rtc` sköter signalering, media
 * och ICE. Ingen enhet att registrera, inget konto hos leverantören, ingen
 * telefon som ringer först och kopplar vidare.
 *
 * SDK:t laddas dynamiskt. Det rör `window`, `navigator.mediaDevices` och
 * RTCPeerConnection vid import, och skulle krascha en serverrendering.
 */

export type WebphoneState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "ready" }
  | { phase: "calling"; callId: string }
  | { phase: "unavailable"; code: string; message: string };

type SinchCredentials = {
  kind: string;
  applicationKey: string;
  userId: string;
  environmentHost: string;
  token: string;
  callerIdentifier: string;
  expiresAt: string;
};

type LegEvent = "ringing" | "answered" | "ended";

/**
 * Vad det pågående samtalet faktiskt går att göra.
 *
 * Kontrollerat på samtalsobjektet, inte antaget. En knapp som ser ut att stänga
 * av mikrofonen men inte gör det är värre än ingen knapp: säljaren tror att
 * kunden inte hör henne.
 */
export type CallAudioCapabilities = { mute: boolean; dtmf: boolean };

type ProviderCall = {
  id: string;
  hangup: () => void;
  addListener: (listener: unknown) => void;
  mute?: () => void;
  unmute?: () => void;
  setMuted?: (muted: boolean) => void;
  sendDTMF?: (digit: string) => void;
};

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null) as Record<string, unknown> | null;
  return { ok: response.ok, status: response.status, data };
}

export function useSinchWebphone() {
  const [state, setState] = useState<WebphoneState>({ phase: "idle" });
  const clientRef = useRef<unknown>(null);
  const sessionRef = useRef<string | null>(null);
  const callRef = useRef<ProviderCall | null>(null);
  const [muted, setMutedState] = useState(false);
  const [capabilities, setCapabilities] = useState<CallAudioCapabilities>({ mute: false, dtmf: false });
  // Registreringen startas en gång. Utan den här spärren bygger en omrendering
  // en andra klient mot samma användare, och den första tappar sin plats utan
  // att någon får veta.
  const startedRef = useRef(false);
  /**
   * Har klienten faktiskt registrerat sig?
   *
   * `startedRef` betyder bara att uppstarten är påbörjad. Den här säger att
   * leverantören har svarat ja. Skillnaden är inte akademisk: en klient som
   * byggts men aldrig registrerats har ändå ett `callClient`-objekt, så en
   * kontroll av att objektet finns släpper igenom ett samtal som sedan avvisas
   * med "Invalid operation" -- ett fel som pekar på samtalet när problemet är
   * registreringen.
   */
  const registeredRef = useRef(false);

  const reportLeg = useCallback(async (callId: string, event: LegEvent) => {
    const sessionId = sessionRef.current;
    if (!sessionId) return;
    // Klientens rapport är en komplettering, inte sanningen. Providerns webhook
    // äger utfallet; det här är bara för att gränssnittet ska hinna med.
    await postJson("/api/v1/telephony/webphone/leg", {
      callId, sessionId, event, occurredAt: new Date().toISOString(),
    }).catch(() => null);
  }, []);

  const start = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setState({ phase: "starting" });

    const opened = await postJson("/api/v1/telephony/webphone/session", {
      userAgent: navigator.userAgent.slice(0, 400),
    });
    if (!opened.ok || !opened.data) {
      startedRef.current = false;
      setState({
        phase: "unavailable",
        code: String(opened.data?.error ?? "webphone_session_failed"),
        message: String(opened.data?.message ?? "Webbtelefonen kunde inte startas."),
      });
      return;
    }

    const credentials = opened.data.credentials as SinchCredentials | undefined;
    if (!credentials || credentials.kind !== "sinch_rtc") {
      startedRef.current = false;
      setState({
        phase: "unavailable",
        code: "webphone_credentials_unsupported",
        message: "Webbtelefonen fick uppgifter i ett format den inte kan använda.",
      });
      return;
    }
    sessionRef.current = String(opened.data.sessionId ?? "");

    try {
      const { Sinch } = await import("sinch-rtc");
      const client = Sinch.getSinchClientBuilder()
        .applicationKey(credentials.applicationKey)
        .userId(credentials.userId)
        .environmentHost(credentials.environmentHost)
        // Utan CLI får samtalet ett id från Sinch och når aldrig mottagaren.
        // Servern vägrar dela ut uppgifter utan det, så här kan det bara saknas
        // om kontraktet brutits -- men det sätts uttryckligen ändå.
        .callerIdentifier(credentials.callerIdentifier)
        .build();

      client.addListener({
        onCredentialsRequired: (_c: unknown, registration: { register: (t: string) => void; registerFailed: () => void }) => {
          // Första gången räcker den token vi redan har. Därefter hämtas en ny,
          // eftersom den vi fick är kortlivad med flit.
          if (Date.parse(credentials.expiresAt) > Date.now() + 30_000) {
            registration.register(credentials.token);
            return;
          }
          void postJson("/api/v1/telephony/webphone/session", { userAgent: navigator.userAgent.slice(0, 400) })
            .then((refreshed) => {
              const next = refreshed.data?.credentials as SinchCredentials | undefined;
              if (next?.token) registration.register(next.token);
              else registration.registerFailed();
            })
            .catch(() => registration.registerFailed());
        },
        onClientStarted: () => {
          registeredRef.current = true;
          setState({ phase: "ready" });
        },
        onClientFailed: (_c: unknown, error: unknown) => {
          startedRef.current = false;
          registeredRef.current = false;
          console.error("webphone_client_failed", { name: error instanceof Error ? error.name : "unknown" });
          setState({
            phase: "unavailable",
            code: "webphone_registration_failed",
            message: "Webbtelefonen kunde inte registrera sig. Ladda om sidan och försök igen.",
          });
        },
      });
      client.start();
      clientRef.current = client;
    } catch (error) {
      startedRef.current = false;
      console.error("webphone_sdk_load_failed", { name: error instanceof Error ? error.name : "unknown" });
      setState({
        phase: "unavailable",
        code: "webphone_sdk_unavailable",
        message: "Webbtelefonen kunde inte laddas i den här webbläsaren.",
      });
    }
  }, []);

  /**
   * Ringer ett redan reserverat samtal.
   *
   * Reservationen har skett på servern; `callId` och `attemptId` kommer därifrån.
   * Utfallet rapporteras tillbaka i alla tre riktningarna -- accepterat, misslyckat
   * och okänt -- eftersom ett samtal som startade men vars svar tappades kan ringa
   * hos mottagaren just nu, och att stänga det som misslyckat skulle släppa
   * platsen mitt i det.
   */
  const placeCall = useCallback(async (input: { callId: string; attemptId: string; to: string }) => {
    const client = clientRef.current as { callClient?: { callPhoneNumber: (n: string) => Promise<unknown> } } | null;
    // Registreringen måste vara klar, inte bara påbörjad. Se `registeredRef`.
    if (!client?.callClient || !registeredRef.current) {
      await postJson("/api/v1/calls/dialing", {
        callId: input.callId, attemptId: input.attemptId, outcome: "failed",
        errorCode: "webphone_not_ready", errorMessage: "Webbtelefonen var inte registrerad hos leverantören.",
      });
      throw new Error("webphone_not_ready");
    }

    let call: ProviderCall;
    try {
      call = await client.callClient.callPhoneNumber(input.to) as ProviderCall;
    } catch (error) {
      await postJson("/api/v1/calls/dialing", {
        callId: input.callId, attemptId: input.attemptId, outcome: "failed",
        errorCode: "webphone_dial_rejected",
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : "Samtalet avvisades.",
      });
      throw error;
    }

    callRef.current = call;
    setMutedState(false);
    setCapabilities({
      mute: typeof call.setMuted === "function" || (typeof call.mute === "function" && typeof call.unmute === "function"),
      dtmf: typeof call.sendDTMF === "function",
    });
    setState({ phase: "calling", callId: input.callId });

    // Samtalets identitet hos leverantören. Utan den går inkommande ace och dice
    // inte att koppla till det här försöket, så den rapporteras före allt annat.
    const reported = await postJson("/api/v1/calls/dialing", {
      callId: input.callId, attemptId: input.attemptId,
      outcome: "accepted", externalCallId: call.id,
    });
    if (!reported.ok) {
      console.error("webphone_dialing_report_failed", { status: reported.status });
    }

    call.addListener({
      onCallRinging: () => void reportLeg(input.callId, "ringing"),
      onCallAnswered: () => void reportLeg(input.callId, "answered"),
      onCallEstablished: () => void reportLeg(input.callId, "answered"),
      onCallEnded: () => {
        callRef.current = null;
        setMutedState(false);
        setCapabilities({ mute: false, dtmf: false });
        setState({ phase: "ready" });
        void reportLeg(input.callId, "ended");
      },
    });

    return { providerCallId: call.id };
  }, [reportLeg]);

  /** Lägger på. Samtalet ligger i webbläsaren, så knappen avslutar det på riktigt. */
  const hangup = useCallback(() => {
    callRef.current?.hangup();
  }, []);

  /**
   * Stänger av mikrofonen mot kunden.
   *
   * Tillståndet sätts först när anropet gått igenom. Att sätta det i förväg och
   * hoppas hade visat "mikrofonen av" för en säljare som fortfarande hörs.
   */
  const toggleMute = useCallback(() => {
    const call = callRef.current;
    if (!call) return false;
    const next = !muted;
    if (typeof call.setMuted === "function") call.setMuted(next);
    else if (next && typeof call.mute === "function") call.mute();
    else if (!next && typeof call.unmute === "function") call.unmute();
    else return false;
    setMutedState(next);
    return true;
  }, [muted]);

  /**
   * Knappval under samtalet, för växlar och telefonsvarare.
   *
   * Returnerar false när leverantörens klient inte kan skicka tonen, så att
   * gränssnittet kan säga det i stället för att låtsas att den gick fram.
   */
  const sendDtmf = useCallback((digit: string) => {
    const call = callRef.current;
    if (!call || typeof call.sendDTMF !== "function") return false;
    if (!/^[0-9*#]$/.test(digit)) return false;
    call.sendDTMF(digit);
    return true;
  }, []);

  useEffect(() => () => {
    // Fliken stängs. Släpp samtalet och sessionen, annars håller platsen kvar
    // säljaren tills sopningen tar den en och en halv minut senare.
    callRef.current?.hangup();
    const sessionId = sessionRef.current;
    if (sessionId) {
      void fetch("/api/v1/telephony/webphone/session", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, reason: "Fliken stängdes" }),
        keepalive: true,
      }).catch(() => null);
    }
  }, []);

  return {
    state, start, placeCall, hangup, toggleMute, sendDtmf, muted, capabilities,
    providerCallId: callRef.current?.id ?? null,
  };
}
